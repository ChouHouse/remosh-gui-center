// Turns the server's raw `stats` output into one sample.
// Container (cgroup) figures are preferred over /proc totals, which describe
// the Docker host when the SSH target is a container.
export function parseStats(out) {
  const sec = {};
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('@@')) sec[(cur = line.slice(2))] = [];
    else if (cur && line) sec[cur].push(line);
  }
  const num = (key) => {
    const v = sec[key]?.[0];
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : null;
  };
  const second = (key) => Number(sec[key]?.[0]?.split(/\s+/)[1]) || 0;
  const s = {
    time: parseFloat(sec.time?.[0]) || Date.now() / 1000,
    host: sec.host?.[0] || '',
    container: (sec.container || []).length > 0,
    nproc: num('nproc') || 1,
    clk: num('clk') || 100,
    cg: null,
    sys: null,
    procs: [],
  };

  // The container's own accounting (cgroup v2, then v1).
  if (num('v2:memory.current') != null) {
    const [quota, period] = (sec['v2:cpu.max']?.[0] || 'max 100000').split(/\s+/);
    const usage = second('v2:cpu.stat');
    s.cg = {
      version: 2,
      memUsed: Math.max(0, num('v2:memory.current') - second('v2:memory.stat')),
      memLimit: num('v2:memory.max'), // "max" -> null
      cpuSec: sec['v2:cpu.stat']?.length ? usage / 1e6 : null,
      cpuLimit: quota === 'max' ? null : Number(quota) / (Number(period) || 100000),
      pids: num('v2:pids.current'),
    };
  } else if (num('v1:memory.usage') != null) {
    const limit = num('v1:memory.limit');
    const quota = num('v1:cpu.quota');
    const usage = num('v1:cpu.usage');
    s.cg = {
      version: 1,
      memUsed: Math.max(0, num('v1:memory.usage') - second('v1:memory.stat')),
      memLimit: limit != null && limit < 2 ** 60 ? limit : null, // v1 reports "no limit" as a huge number
      cpuSec: usage != null ? usage / 1e9 : null,
      cpuLimit: quota != null && quota > 0 ? quota / (num('v1:cpu.period') || 100000) : null,
      pids: num('v1:pids'),
    };
  }

  // Whole-machine figures from /proc (the Docker host's, when inside a container).
  const mem = {};
  for (const line of sec.meminfo || []) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  const cpu = (sec.stat?.[0] || '').split(/\s+/).slice(1, 9).map(Number);
  if (mem.MemTotal && cpu.length >= 4) {
    const avail = mem.MemAvailable ?? (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0);
    s.sys = {
      memUsed: mem.MemTotal - avail,
      memLimit: mem.MemTotal,
      cpuTotal: cpu.reduce((a, b) => a + (b || 0), 0),
      cpuIdle: (cpu[3] || 0) + (cpu[4] || 0),
    };
  }
  s.uptime = parseFloat(sec.uptime?.[0]) || null;
  s.cpuModel = (sec.cpumodel?.[0] || '').replace(/\s+/g, ' ').trim();

  // Storage: the file systems holding / and the home folder (one entry when they are the same).
  s.disks = [];
  for (const line of sec.disk || []) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue;
    const d = { fs: m[1], size: Number(m[2]) * 1024, used: Number(m[3]) * 1024, avail: Number(m[4]) * 1024, mount: m[5] };
    if (!s.disks.some((x) => x.mount === d.mount || (x.fs === d.fs && x.size === d.size))) s.disks.push(d);
  }

  // Network: bytes received / sent so far on every interface but loopback.
  // Inside a container these are the container's own interfaces.
  let rx = 0;
  let tx = 0;
  let ifaces = 0;
  for (const line of sec.net || []) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    rx += f[0] || 0;
    tx += f[8] || 0;
    ifaces++;
  }
  s.net = ifaces ? { rx, tx } : null;

  const ticks = new Map();
  for (const line of sec.ticks || []) {
    const [pid, t, start] = line.split(/\s+/).map(Number);
    ticks.set(pid, { t, start });
  }
  for (const line of sec.ps || []) {
    const m = /^(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    s.procs.push({ pid, user: m[2], rss: Number(m[3]) * 1024, name: m[4], ticks: ticks.get(pid)?.t ?? null });
  }
  // In a container /proc/uptime is the host's; the container's age is how long PID 1 has run.
  const pid1 = ticks.get(1);
  s.pid1Age = s.uptime != null && pid1?.start ? s.uptime - pid1.start / s.clk : null;
  // Prefer the container's own numbers whenever this is a container or the cgroup has limits.
  s.useCgroup = !!s.cg && (s.container || s.cg.memLimit != null || s.cg.cpuLimit != null);
  return s;
}
