#!/usr/bin/env python3
"""Remogui MCP agent (Python): a small MCP server (Streamable HTTP) that gives
Remogui a machine to work on without SSH. The same tools as remogui-agent.mjs
(the Node.js version); use whichever the machine already has. The Remogui
login screen offers both for download (as mcp.py and mcp.mjs).

    python3 mcp.py [--key KEY] [--tunnel TOKEN | --no-tunnel] [--port 8787] [--host 127.0.0.1]

    --key KEY       what the login screen must send as the access token.
                    Without it there is no check at all: anyone with the
                    address can use this machine.
    --tunnel TOKEN  run this Cloudflare tunnel (its token, from the Cloudflare
                    dashboard). Without it a quick tunnel is made and its
                    https://….trycloudflare.com address is printed.
    --no-tunnel     no tunnel: reach the agent directly (LAN, reverse proxy).

cloudflared is used from PATH, else downloaded once from Cloudflare's GitHub
releases into ~/.cache/remogui/. The environment variables REMOGUI_TOKEN,
CLOUDFLARE_TUNNEL_TOKEN, PORT and HOST work as the options do.

Python 3.8 or newer, standard library only. Terminals (with resizing) come
from the pty module, so they work on Linux and macOS. The tools and their
arguments are described in docs/MCP.md.
"""
import argparse
import atexit
import base64
import errno
import hmac
import json
import os
import platform
import pwd
import re
import shutil
import secrets
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import fcntl
    import pty
    import termios

    TERMS_OK = True
except ImportError:  # not a POSIX system: no terminal tools
    TERMS_OK = False

VERSION = '1.0.0'
TOKEN = ''  # the access key; empty = no check (set from --key in main())
MAX_BODY = 64 * 1024 * 1024
MAX_READ = 4 * 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024
SESSION_IDLE = 60 * 60  # seconds an MCP session may stay unused
MAX_SESSIONS = 64
MAX_TERMS = 8
BUFFER_CAP = 4 * 1024 * 1024
HOME = os.path.expanduser('~')

os.chdir(HOME)


# ---- errors

class ToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


FS_CODES = {
    errno.ENOENT: 'not-found', errno.ENOTDIR: 'not-found',
    errno.EACCES: 'permission-denied', errno.EPERM: 'permission-denied',
    errno.EEXIST: 'exists',
}


def tool_error(err):
    if isinstance(err, ToolError):
        return err
    if isinstance(err, OSError):
        return ToolError(FS_CODES.get(err.errno, 'failure'), err.strerror or str(err))
    return ToolError('failure', str(err))


# ---- argument checks

def text_arg(args, key, what=None, default=None):
    v = args.get(key, default)
    if not isinstance(v, str) or not v or '\0' in v:
        raise ToolError('bad-request', 'Invalid ' + (what or key))
    return v


def int_arg(args, key, default=None, lo=0, hi=2 ** 53):
    v = args.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, int) or v < lo or v > hi:
        raise ToolError('bad-request', 'Invalid ' + key)
    return v


def attrs(st):
    return {'mode': st.st_mode, 'size': st.st_size, 'mtime': int(st.st_mtime), 'uid': st.st_uid, 'gid': st.st_gid}


# ---- file tools

def fs_stat(a):
    path = text_arg(a, 'path')
    return attrs(os.lstat(path) if a.get('follow') is False else os.stat(path))


def fs_readdir(a):
    path = text_arg(a, 'path')
    entries = []
    with os.scandir(path) as it:
        for e in it:
            try:
                entries.append(dict(name=e.name, **attrs(e.stat(follow_symlinks=False))))
            except OSError:
                pass  # gone meanwhile
    return {'entries': entries}


def fs_realpath(a):
    path = text_arg(a, 'path', default='.')
    real = os.path.realpath(path)
    os.stat(real)  # like realpath(3): a path that is not there is an error
    return {'path': real}


def fs_read(a):
    path = text_arg(a, 'path')
    at = int_arg(a, 'offset', 0)
    want = min(int_arg(a, 'length', MAX_READ, lo=1), MAX_READ)
    fd = os.open(path, os.O_RDONLY)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ToolError('not-a-file', 'Not a regular file')
        data = os.pread(fd, want, at)
        return {'data': base64.b64encode(data).decode('ascii'), 'size': st.st_size, 'eof': at + len(data) >= st.st_size}
    finally:
        os.close(fd)


def fs_write(a):
    path = text_arg(a, 'path')
    at = int_arg(a, 'offset', 0)
    data = a.get('data')
    if not isinstance(data, str):
        raise ToolError('bad-request', 'Missing data')
    buf = base64.b64decode(data)
    perm = 0o666 if a.get('mode') is None else int_arg(a, 'mode', hi=0o7777)
    if a.get('truncate'):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, perm)
    else:
        try:
            fd = os.open(path, os.O_RDWR)
        except FileNotFoundError:
            if at != 0:
                raise
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, perm)
    try:
        view = memoryview(buf)
        done = 0
        while done < len(view):
            done += os.pwrite(fd, view[done:], at + done)
    finally:
        os.close(fd)
    return {}


def fs_mkdir(a):
    os.mkdir(text_arg(a, 'path'), 0o777 if a.get('mode') is None else int_arg(a, 'mode', hi=0o7777))
    return {}


def fs_remove(a):
    path = text_arg(a, 'path')
    if a.get('dir'):
        os.rmdir(path)
    else:
        os.unlink(path)
    return {}


def fs_rename(a):
    os.rename(text_arg(a, 'from'), text_arg(a, 'to'))
    return {}


def fs_chmod(a):
    os.chmod(text_arg(a, 'path'), int_arg(a, 'mode', hi=0o7777))
    return {}


def fs_symlink(a):
    os.symlink(text_arg(a, 'target'), text_arg(a, 'path'))
    return {}


def fs_readlink(a):
    return {'target': os.readlink(text_arg(a, 'path'))}


# ---- exec

def run_exec(a):
    command = text_arg(a, 'command')
    stdin = a.get('stdin')
    limit = min(float(a.get('timeoutMs') or 30000), 10 * 60 * 1000) / 1000
    try:
        p = subprocess.run(['/bin/sh', '-c', command], input=stdin.encode() if isinstance(stdin, str) else b'',
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=limit)
        out, err, code, timed_out = p.stdout, p.stderr, p.returncode, False
    except subprocess.TimeoutExpired as e:
        out, err, code, timed_out = e.stdout or b'', e.stderr or b'', 128, True
    except OSError as e:
        raise ToolError('exec-failed', str(e))
    if code < 0:  # killed by a signal
        code = 128 - code
    return {
        'stdout': out[:MAX_OUTPUT].decode('utf-8', 'replace'),
        'stderr': err[:MAX_OUTPUT].decode('utf-8', 'replace'),
        'code': code,
        'timedOut': timed_out,
    }


# ---- terminals (long-polled: the client calls term_read, the agent answers as
# soon as there is output or after waitMs)

class Term:
    def __init__(self, cols, rows, term):
        shell = os.environ.get('SHELL') or '/bin/sh'
        env = dict(os.environ, TERM=term, LANG=os.environ.get('LANG') or 'C.UTF-8')
        pid, fd = pty.fork()
        if pid == 0:  # the child: becomes the shell
            try:
                os.chdir(HOME)
                os.execvpe(shell, [shell, '-l'], env)
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd
        self.resize(cols, rows)
        self.chunks, self.size, self.exited = [], 0, False
        self.cond = threading.Condition()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b''
            with self.cond:
                if not data:
                    self.exited = True
                    self.cond.notify_all()
                    break
                self.chunks.append(data)
                self.size += len(data)
                while self.size > BUFFER_CAP and len(self.chunks) > 1:
                    self.size -= len(self.chunks.pop(0))
                self.cond.notify_all()
        try:
            os.waitpid(self.pid, 0)
        except OSError:
            pass

    def read(self, wait):
        with self.cond:
            if not self.chunks and not self.exited and wait:
                self.cond.wait(wait)
            data = b''.join(self.chunks)
            self.chunks, self.size = [], 0
            return data, self.exited and not data

    def write(self, data):
        view = memoryview(data)
        while view:
            n = os.write(self.fd, view)
            view = view[n:]

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def close(self):
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass


terms = {}
terms_lock = threading.Lock()
term_seq = [0]


def clamp(v, default, lo, hi):
    try:
        v = int(v)
    except (TypeError, ValueError):
        v = default
    return min(max(v or default, lo), hi)


def term_of(a):
    with terms_lock:
        t = terms.get(a.get('tid'))
    if not t:
        raise ToolError('no-terminal', 'Terminal is closed')
    return t


def term_open(a):
    with terms_lock:
        if len(terms) >= MAX_TERMS:
            raise ToolError('too-many', 'Too many terminals')
    term = a.get('term')
    if not (isinstance(term, str) and 0 < len(term) <= 40 and all(c.isalnum() or c in '_.-' for c in term)):
        term = 'xterm-256color'
    t = Term(clamp(a.get('cols'), 80, 2, 500), clamp(a.get('rows'), 24, 2, 300), term)
    with terms_lock:
        term_seq[0] += 1
        tid = term_seq[0]
        terms[tid] = t
    return {'tid': tid}


def term_write(a):
    t = term_of(a)
    buf = base64.b64decode(str(a.get('data') or ''))
    if len(buf) > 256 * 1024:
        raise ToolError('bad-request', 'Input too large')
    t.write(buf)
    return {}


def term_read(a):
    t = term_of(a)
    wait = min(max(float(a.get('waitMs') or 0), 0), 20000) / 1000
    data, exited = t.read(wait)
    if exited:
        with terms_lock:
            terms.pop(a.get('tid'), None)
    return {'data': base64.b64encode(data).decode('ascii'), 'exited': exited}


def term_resize(a):
    term_of(a).resize(clamp(a.get('cols'), 80, 2, 500), clamp(a.get('rows'), 24, 2, 300))
    return {}


def term_close(a):
    with terms_lock:
        t = terms.pop(a.get('tid'), None)
    if t:
        t.close()
    return {}


# ---- tool registry

def obj(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required)}


S, N, B = {'type': 'string'}, {'type': 'integer'}, {'type': 'boolean'}


def hello(_a):
    try:
        user = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        user = os.environ.get('USER') or str(os.getuid())
    return {'home': HOME, 'user': user, 'host': socket.gethostname(), 'platform': sys.platform,
            'version': VERSION, 'pty': TERMS_OK, 'resize': TERMS_OK}


TOOLS = {
    'hello': ('Who and where this agent is.', obj({}), hello),
    'fs_stat': ('stat / lstat (follow=false) a path.', obj({'path': S, 'follow': B}, ['path']), fs_stat),
    'fs_readdir': ('List a directory (lstat attributes per entry).', obj({'path': S}, ['path']), fs_readdir),
    'fs_realpath': ('Resolve a path (relative to the home directory).', obj({'path': S}), fs_realpath),
    'fs_read': ('Read up to length bytes at offset (base64).', obj({'path': S, 'offset': N, 'length': N}, ['path']), fs_read),
    'fs_write': ('Write base64 data at offset; truncate=true starts the file afresh.',
                 obj({'path': S, 'offset': N, 'data': S, 'truncate': B, 'mode': N}, ['path', 'data']), fs_write),
    'fs_mkdir': ('Create one directory.', obj({'path': S, 'mode': N}, ['path']), fs_mkdir),
    'fs_remove': ('Delete a file or symlink, or an empty directory (dir=true).', obj({'path': S, 'dir': B}, ['path']), fs_remove),
    'fs_rename': ('Rename or move.', obj({'from': S, 'to': S}, ['from', 'to']), fs_rename),
    'fs_chmod': ('Change permission bits.', obj({'path': S, 'mode': N}, ['path', 'mode']), fs_chmod),
    'fs_symlink': ('Create a symlink at path pointing to target.', obj({'target': S, 'path': S}, ['target', 'path']), fs_symlink),
    'fs_readlink': ('Read a symlink.', obj({'path': S}, ['path']), fs_readlink),
    'exec': ('Run a command with /bin/sh -c; optional stdin text.', obj({'command': S, 'stdin': S, 'timeoutMs': N}, ['command']), run_exec),
}
if TERMS_OK:
    TOOLS.update({
        'term_open': ('Open a terminal (PTY).', obj({'cols': N, 'rows': N, 'term': S}), term_open),
        'term_write': ('Type into a terminal (base64).', obj({'tid': N, 'data': S}, ['tid', 'data']), term_write),
        'term_read': ('Read terminal output (base64), waiting up to waitMs for some.', obj({'tid': N, 'waitMs': N}, ['tid']), term_read),
        'term_resize': ('Resize a terminal.', obj({'tid': N, 'cols': N, 'rows': N}, ['tid', 'cols', 'rows']), term_resize),
        'term_close': ('Close a terminal.', obj({'tid': N}, ['tid']), term_close),
    })


def text_content(value, error=False):
    out = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
    if error:
        out['isError'] = True
    return out


def call_tool(name, args):
    tool = TOOLS.get(name) if isinstance(name, str) else None
    if not tool:
        return text_content({'code': 'bad-request', 'message': 'Unknown tool: %s' % name}, True)
    try:
        return text_content(tool[2](args if isinstance(args, dict) else {}))
    except Exception as err:  # every failure goes back to the caller as a tool error
        e = tool_error(err)
        return text_content({'code': e.code, 'message': str(e)}, True)


# ---- MCP over Streamable HTTP (plain JSON replies, no server push)

sessions = {}  # session id -> last used (time.time())
sessions_lock = threading.Lock()


def new_session():
    now = time.time()
    with sessions_lock:
        for sid, used in list(sessions.items()):
            if now - used > SESSION_IDLE:
                del sessions[sid]
        while len(sessions) >= MAX_SESSIONS:
            del sessions[min(sessions, key=sessions.get)]  # the least recently used
        sid = secrets.token_hex(16)
        sessions[sid] = now
        return sid


def known_session(sid):
    now = time.time()
    with sessions_lock:
        used = sessions.get(sid) if sid else None
        if used is None or now - used > SESSION_IDLE:
            sessions.pop(sid, None)
            return False
        sessions[sid] = now
        return True


def handle_message(msg):
    if not isinstance(msg, dict) or 'id' not in msg:
        return None  # a notification: nothing to answer
    mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}

    def ok(result):
        return {'jsonrpc': '2.0', 'id': mid, 'result': result}

    if method == 'initialize':
        asked = params.get('protocolVersion')
        return ok({'protocolVersion': asked if asked in ('2025-06-18', '2025-03-26', '2024-11-05') else '2025-03-26',
                   'capabilities': {'tools': {}}, 'serverInfo': {'name': 'remogui-agent', 'version': VERSION}})
    if method == 'ping':
        return ok({})
    if method == 'tools/list':
        return ok({'tools': [{'name': n, 'description': d, 'inputSchema': s} for n, (d, s, _f) in TOOLS.items()]})
    if method == 'tools/call':
        return ok(call_tool(params.get('name'), params.get('arguments')))
    return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'Method not found: %s' % method}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'remogui-agent/' + VERSION

    def log_message(self, fmt, *args):  # quiet: no line per request
        pass

    def send(self, status, body=None, headers=None):
        data = b'' if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        if body is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def gate(self):
        # When the answer comes before the body is read, the connection must not
        # be reused: the unread body would be taken for the next request.
        if self.path.split('?')[0] not in ('/mcp', '/'):
            self.close_connection = True
            self.send(404)
            return False
        given = self.headers.get('Authorization') or ''
        if given[:7].lower() == 'bearer ':
            given = given[7:]
        if TOKEN and not hmac.compare_digest(given.encode(), TOKEN.encode()):
            self.close_connection = True
            self.send(401, headers={'WWW-Authenticate': 'Bearer'})
            return False
        return True

    def do_DELETE(self):
        if self.gate():
            with sessions_lock:
                sessions.pop(self.headers.get('Mcp-Session-Id'), None)
            self.send(200)

    def do_GET(self):
        if self.gate():
            self.send(405, headers={'Allow': 'POST, DELETE'})

    def do_POST(self):
        if not self.gate():
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            return self.send(413)
        try:
            msg = json.loads(self.rfile.read(length).decode('utf-8'))
        except ValueError:
            return self.send(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}})
        batch = isinstance(msg, list)
        items = msg if batch else [msg]
        init = any(isinstance(m, dict) and m.get('method') == 'initialize' for m in items)
        # Everything but initialize belongs to a session that initialize started.
        if not init and not known_session(self.headers.get('Mcp-Session-Id')):
            return self.send(404, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32001, 'message': 'Unknown or expired session'}})
        answers = [a for a in (handle_message(m) for m in items) if a is not None]
        if not answers:
            return self.send(202)
        self.send(200, answers if batch else answers[0], {'Mcp-Session-Id': new_session()} if init else None)


# ---- cloudflared: from PATH, or downloaded once into ~/.cache/remogui

CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'


def cloudflared_path():
    found = shutil.which('cloudflared')
    if found:
        return found
    cache = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.join(HOME, '.cache'), 'remogui')
    path = os.path.join(cache, 'cloudflared')
    if os.access(path, os.X_OK):
        return path
    arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64',
            'armv7l': 'arm', 'armv6l': 'arm', 'i386': '386', 'i686': '386'}.get(platform.machine().lower())
    system = {'linux': 'linux', 'darwin': 'darwin'}.get(sys.platform)
    if not arch or not system or (system == 'darwin' and arch not in ('amd64', 'arm64')):
        raise SystemExit('cloudflared is not on PATH and there is no download for %s/%s; install it, or use --no-tunnel'
                         % (sys.platform, platform.machine()))
    name = 'cloudflared-%s-%s%s' % (system, arch, '.tgz' if system == 'darwin' else '')
    print('Downloading cloudflared (%s) from GitHub…' % name, flush=True)
    os.makedirs(cache, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=cache)
    try:
        with os.fdopen(fd, 'wb') as out, urllib.request.urlopen(CF_RELEASES + name, timeout=120) as res:
            shutil.copyfileobj(res, out)
        if name.endswith('.tgz'):
            with tarfile.open(tmp) as tar:
                member = next(m for m in tar.getmembers() if os.path.basename(m.name) == 'cloudflared' and m.isfile())
                with tar.extractfile(member) as src, open(tmp + '.bin', 'wb') as out:
                    shutil.copyfileobj(src, out)
            os.replace(tmp + '.bin', tmp)
        os.chmod(tmp, 0o755)
        os.replace(tmp, path)
    except Exception as err:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SystemExit('Could not download cloudflared: %s (install it yourself, or use --no-tunnel)' % err)
    return path


def start_tunnel(port, token):
    """Starts cloudflared in front of the agent; prints the address to log in with."""
    exe = cloudflared_path()
    env = dict(os.environ)
    if token:
        args = [exe, 'tunnel', '--no-autoupdate', 'run']
        env['TUNNEL_TOKEN'] = token  # not on the command line, where ps would show it
        print('Starting your Cloudflare tunnel…', flush=True)
    else:
        args = [exe, 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:%d' % port]
        print('Starting a Cloudflare quick tunnel…', flush=True)
    proc = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    atexit.register(lambda: proc.poll() is None and proc.terminate())

    def watch():
        told = False
        tail = []
        for raw in proc.stdout:
            line = raw.decode('utf-8', 'replace').rstrip()
            tail = (tail + [line])[-15:]
            if told:
                continue
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if not token and m:
                told = True
                print('\n  Login address:  %s/mcp\n' % m.group(0), flush=True)
            elif token and 'Registered tunnel connection' in line:
                told = True
                print('\n  Tunnel connected. Login address: the public hostname you gave this tunnel in\n'
                      '  Cloudflare, followed by /mcp (its service must be http://127.0.0.1:%d).\n' % port, flush=True)
        code = proc.wait()
        print('cloudflared stopped (exit %s):\n  %s' % (code, '\n  '.join(tail)), flush=True)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def main():
    global TOKEN
    ap = argparse.ArgumentParser(prog='mcp.py', description='Remogui MCP agent: lets Remogui use this machine without SSH.')
    ap.add_argument('--key', default=os.environ.get('REMOGUI_TOKEN', ''), help='access token the login screen must send (none: no check)')
    ap.add_argument('--tunnel', metavar='TOKEN', default=os.environ.get('CLOUDFLARE_TUNNEL_TOKEN', ''), help='Cloudflare tunnel token (none: a quick tunnel)')
    ap.add_argument('--no-tunnel', action='store_true', help='no tunnel; reach the agent directly')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT') or 8787))
    ap.add_argument('--host', default=os.environ.get('HOST') or '127.0.0.1', help='address to listen on (0.0.0.0 for a LAN or a container)')
    opts = ap.parse_args()
    TOKEN = opts.key

    server = ThreadingHTTPServer((opts.host, opts.port), Handler)
    server.daemon_threads = True
    print('Remogui MCP agent %s (Python)' % VERSION, flush=True)
    print('  Listening on:   http://%s:%d/mcp' % (opts.host, opts.port), flush=True)
    print('  Terminal:       ' + ('pty' if TERMS_OK else 'not available on this system'), flush=True)
    if TOKEN:
        print('  Access token:   set (--key)', flush=True)
    else:
        print('  Access token:   NONE. Anyone who has the address can read, change and run anything here.', flush=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if not opts.no_tunnel:
        start_tunnel(opts.port, opts.tunnel)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
