// Task-manager data: one fixed, read-only script run on the SSH host.
// The browser cannot choose what runs.
import { execCapture } from '../ssh.js';

// Prints "@@section" headers followed by raw values; the page does the maths.
// Inside a container /sys/fs/cgroup describes the container itself (its own
// usage and limits), which is what the task manager prefers over /proc totals
// that describe the Docker host.
const STATS_SCRIPT = `
export LC_ALL=C
c=/sys/fs/cgroup
sec() { echo "@@$1"; }
sec time; date +%s.%N 2>/dev/null || date +%s
sec host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null
sec container
[ -f /.dockerenv ] && echo docker
[ -f /run/.containerenv ] && echo podman
grep -qaE 'docker|kubepods|containerd|lxc|libpod' /proc/1/cgroup 2>/dev/null && echo cgroup
tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | grep -a '^container=' | head -n 1
sec nproc; nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null
sec clk; getconf CLK_TCK 2>/dev/null
for f in memory.current memory.max cpu.max pids.current pids.max; do sec "v2:$f"; cat "$c/$f" 2>/dev/null; done
sec v2:cpu.stat; grep -E '^usage_usec ' "$c/cpu.stat" 2>/dev/null
sec v2:memory.stat; grep -E '^inactive_file ' "$c/memory.stat" 2>/dev/null
sec v1:memory.usage; cat "$c/memory/memory.usage_in_bytes" 2>/dev/null
sec v1:memory.limit; cat "$c/memory/memory.limit_in_bytes" 2>/dev/null
sec v1:memory.stat; grep -E '^total_inactive_file ' "$c/memory/memory.stat" 2>/dev/null
sec v1:cpu.usage; cat "$c/cpuacct/cpuacct.usage" 2>/dev/null || cat "$c/cpu,cpuacct/cpuacct.usage" 2>/dev/null
sec v1:cpu.quota; cat "$c/cpu/cpu.cfs_quota_us" 2>/dev/null || cat "$c/cpu,cpuacct/cpu.cfs_quota_us" 2>/dev/null
sec v1:cpu.period; cat "$c/cpu/cpu.cfs_period_us" 2>/dev/null || cat "$c/cpu,cpuacct/cpu.cfs_period_us" 2>/dev/null
sec v1:pids; cat "$c/pids/pids.current" 2>/dev/null
sec meminfo; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo 2>/dev/null
sec stat; head -n 1 /proc/stat 2>/dev/null
sec uptime; cat /proc/uptime 2>/dev/null
sec cpumodel; grep -m1 -E '^(model name|Hardware|cpu model|Processor|Model)[[:space:]]*:' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
sec disk; df -kP / "$HOME" 2>/dev/null | tail -n +2
sec net; tail -n +3 /proc/net/dev 2>/dev/null
sec ps; ps -eo pid=,user=,rss=,comm= 2>/dev/null
sec ticks; awk '{ i = index($0, ") "); n = split(substr($0, i + 2), a, " "); print $1, a[12] + a[13], a[20] }' /proc/[0-9]*/stat 2>/dev/null
sec end
`;

export async function stats({ client }) {
  return { out: await execCapture(client, STATS_SCRIPT) };
}
