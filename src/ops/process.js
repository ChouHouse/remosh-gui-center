// One process: details for the task manager's process window, and force-kill.
// The pid is validated as an integer, so nothing from the page reaches the shell.
import { execCapture } from '../ssh.js';
import { codeError } from '../util.js';

function pidOf(msg) {
  const pid = Number(msg.pid);
  if (!Number.isInteger(pid) || pid < 2 || pid > 4194304) throw codeError('bad-request', 'Invalid pid');
  return pid;
}

// key=value lines; empty values mean the process is gone.
const infoScript = (pid) => `
export LC_ALL=C
p=${pid}
echo "time=$(date +%s.%N 2>/dev/null || date +%s)"
echo "clk=$(getconf CLK_TCK 2>/dev/null)"
for f in comm ppid user stat nlwp rss vsz etime lstart; do echo "$f=$(ps -p $p -o $f= 2>/dev/null)"; done
echo "ticks=$(awk '{ i = index($0, ") "); split(substr($0, i + 2), a, " "); print a[12] + a[13] }' /proc/$p/stat 2>/dev/null)"
echo "cmd=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)"
echo "cwd=$(readlink /proc/$p/cwd 2>/dev/null)"
echo "exe=$(readlink /proc/$p/exe 2>/dev/null)"
`;

export async function procInfo({ client }, msg) {
  const pid = pidOf(msg);
  const info = {};
  for (const line of (await execCapture(client, infoScript(pid))).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { pid, alive: !!info.comm, info };
}

// SIGKILL. The host decides whether this user may do it.
export async function kill({ client }, msg) {
  const pid = pidOf(msg);
  const out = await execCapture(client, `kill -9 ${pid} 2>&1; echo "rc=$?"`);
  if (/rc=0\s*$/.test(out)) return { pid };
  if (/not permitted/i.test(out)) throw codeError('permission-denied', 'Not permitted to kill this process');
  if (/no such process/i.test(out)) throw codeError('not-found', 'No such process');
  throw codeError('failure', out.replace(/rc=\d+\s*$/, '').trim() || 'kill failed');
}
