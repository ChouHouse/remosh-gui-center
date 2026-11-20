# MCP mode

Remogui can reach a machine in two ways. **SSH** (the original and default)
logs in to an SSH server. **MCP** talks to a remote [MCP](https://modelcontextprotocol.io)
server over Streamable HTTP instead, so the machine needs no SSH daemon: it
only has to run an MCP server that offers the tools below and be reachable by
HTTP(S) from the Remogui server (a Cloudflare Tunnel, a reverse proxy, a LAN
address).

```
browser ──WebSocket /ws──▶ Remogui server ──HTTP POST /mcp (JSON-RPC)──▶ MCP server on the machine
                           MCP client                                    (agent/remogui-agent.mjs or agent/remogui_agent.py)
```

Choose **MCP** on the login screen and enter the server address (for example
`https://something.trycloudflare.com/mcp`) and the access token. The token is
sent as `Authorization: Bearer <token>` and is not stored by the page.
`ALLOWED_HOSTS` applies to the address's host (or `host:port`) as it does to SSH.

## Running an agent

Two agents with the same tools are in `agent/`; use whichever the machine
already has. Neither needs any packages. The login screen offers both for
download (the Python and JavaScript icons under the MCP fields), and the
Remogui server serves them without the access password, so on the machine
itself this works too:

```bash
curl -O https://<your-remogui>/download/mcp.py     # or mcp.mjs
python3 mcp.py --key 'a-long-random-secret'        # Python 3.8 or newer
node mcp.mjs --key 'a-long-random-secret'          # or Node.js 20 or newer
```

It prints the address to log in with, e.g.
`https://some-words.trycloudflare.com/mcp`. Paste that and the key into the
login screen.

| Option | |
| :--- | :--- |
| `--key KEY` | The access token the login screen must send. **Without it there is no check at all**: anyone who has the address can read, change and run anything on the machine. |
| `--tunnel TOKEN` | Run your own Cloudflare tunnel (the token from the Cloudflare dashboard). Its public hostname, set in the dashboard with the service `http://127.0.0.1:8787`, plus `/mcp`, is the address to log in with. |
| (neither tunnel option) | A Cloudflare quick tunnel is made and its random `https://….trycloudflare.com` address is printed. |
| `--no-tunnel` | No tunnel: reach the agent directly (a LAN address with `--host 0.0.0.0`, or your own reverse proxy). |
| `--port`, `--host` | Where the agent listens (default `127.0.0.1:8787`). |

The environment variables `REMOGUI_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, `PORT`
and `HOST` work as the options do (and keep the key out of `ps`).

cloudflared is taken from `PATH`; when it is not there the agent downloads it
once from Cloudflare's GitHub releases (Linux: amd64, arm64, arm, 386; macOS:
amd64, arm64) into `~/.cache/remogui/cloudflared`. The tunnel token is handed
to cloudflared in its environment, not on the command line. When cloudflared
stops, the agent stops too.

The agent runs commands and edits files as the user that started it, so run
it as an ordinary user, never as root, and keep the key secret.

Terminals: the Python agent uses the `pty` module (Linux and macOS), with
window resizing. The Node.js agent uses `node-pty` when it is installed next
to it (`npm i node-pty`), otherwise `script` (works, but cannot resize), and
without either the terminal app reports that the host has no shell.

Google Colab's terms do not allow remote control of its managed runtimes (SSH
shells, remote desktops and the like). Running an agent there may get the
account suspended; that is the user's own risk.

## The tool contract

Every tool takes a JSON object and answers with **one text content block that
holds a JSON object**. A failure sets `isError: true` and the text is
`{ "code": "...", "message": "..." }`. For `fs_*` tools the codes `not-found`,
`permission-denied` and `exists` are meaningful to Remogui; anything else is
shown as a generic failure. Paths are absolute or relative to the home
directory. Binary data is base64. `mtime` is whole seconds since the epoch and
`mode` is the full `st_mode` (file type bits included).

| Tool | Arguments | Answer |
| :--- | :--- | :--- |
| `hello` | | `{ home, user, host, platform, version, pty, resize }` |
| `fs_stat` | `path`, `follow` (default true; false = lstat) | `{ mode, size, mtime, uid, gid }` |
| `fs_readdir` | `path` | `{ entries: [{ name, mode, size, mtime, uid, gid }] }` (lstat attributes) |
| `fs_realpath` | `path` | `{ path }` |
| `fs_read` | `path`, `offset`, `length` (at most 4 MiB are returned) | `{ data, size, eof }` |
| `fs_write` | `path`, `offset`, `data`, `truncate`, `mode` | `{}`. `truncate` starts the file afresh (creating it with `mode`); otherwise the bytes go at `offset` |
| `fs_mkdir` | `path`, `mode` | `{}` (`exists` when it is there) |
| `fs_remove` | `path`, `dir` | `{}`: unlink, or rmdir when `dir` is true |
| `fs_rename` | `from`, `to` | `{}` |
| `fs_chmod` | `path`, `mode` | `{}` |
| `fs_symlink` | `target`, `path` | `{}` |
| `fs_readlink` | `path` | `{ target }` |
| `exec` | `command`, `stdin`, `timeoutMs` | `{ stdout, stderr, code }`. Run with `/bin/sh -c`; `stdin` is text fed to the command |
| `term_open` | `cols`, `rows`, `term` | `{ tid }` |
| `term_write` | `tid`, `data` | `{}` (data is base64 of the typed bytes) |
| `term_read` | `tid`, `waitMs` | `{ data, exited }`: waits up to `waitMs` for output (long poll) |
| `term_resize` | `tid`, `cols`, `rows` | `{}` |
| `term_close` | `tid` | `{}` |

`hello` through `exec` are required; the five `term_*` tools are optional
(all or none). The task manager, account settings and tmux apps use `exec`
with the same fixed shell scripts they send over SSH, so the machine needs the
usual Linux tools (`ps`, `df`, `/proc`, ...) for them to work.

Sessions: `initialize` answers with an `Mcp-Session-Id` header, and every
later request must carry it (the agents answer 404 otherwise, and forget a
session after an hour without use). Remogui logs in again by itself when its
session is gone.

## What differs from SSH

- No host key: the connection is trusted by the token and by HTTPS.
- Every file operation and every keystroke is one HTTP round trip, so it is
  slower than SSH, especially through a tunnel.
- There is no persistent connection to watch: the server pings the MCP server
  every 20 s and treats three misses in a row as a dropped connection (the page
  then reconnects by itself, as with SSH).
- Playing audio / video streams chunks of 256 KiB through `fs_read`.

## Tests

`node test/mcp-smoke.mjs` starts each agent and the web server and runs the
ops through them (`npm run test:mcp`); the browser test (`test/e2e.cjs`) also
logs in through the Python agent.
