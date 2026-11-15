// What the host is: system name, CPU, memory and storage, for 設定 › 系統.
// One fixed, read-only script; the browser cannot choose what runs.
import { execCapture } from '../ssh.js';

const SCRIPT = `
export LC_ALL=C
echo "os=$( (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") )"
echo "kernel=$(uname -sr 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "host=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"
echo "cpu=$(grep -m1 -E '^(model name|Hardware|cpu model|Processor|Model)[[:space:]]*:' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"
echo "cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo "memKb=$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null | tr -dc 0-9)"
echo "disk=$(df -kP "$HOME" 2>/dev/null | tail -n 1 | awk '{ print $2, $4 }')"
`;

export async function sysInfo({ client }) {
  const info = {};
  for (const line of (await execCapture(client, SCRIPT)).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) info[line.slice(0, at)] = line.slice(at + 1).replace(/\s+/g, ' ').trim();
  }
  const [diskKb, freeKb] = (info.disk || '').split(' ').map(Number);
  return {
    os: info.os || info.kernel || '',
    kernel: info.kernel || '',
    arch: info.arch || '',
    host: info.host || '',
    cpu: info.cpu || '',
    cores: Number(info.cores) || 0,
    memBytes: (Number(info.memKb) || 0) * 1024,
    diskBytes: (diskKb || 0) * 1024,
    diskFreeBytes: (freeKb || 0) * 1024,
  };
}
