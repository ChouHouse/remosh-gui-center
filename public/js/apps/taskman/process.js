// Process window: opened by double-clicking a row in the task manager.
// Shows who runs it, what it uses, and offers 強制關閉 (SIGKILL).
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize } from '../../core/format.js';
import { gaugeSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { createWindow } from '../../shell/wm.js';

const STATES = { R: '執行中', S: '休眠', D: '等待 I/O', Z: '殭屍（已結束，尚未回收）', T: '已停止', t: '追蹤中', I: '閒置', X: '已結束' };
const open = new Map(); // pid -> window

export function openProcessWindow(pid, name) {
  if (open.has(pid)) return open.get(pid).focus();
  const win = createWindow({ title: `${name}（${pid}）`, appName: '行程', iconHtml: gaugeSvg(), width: 460, height: 430 });
  open.set(pid, win);
  const list = h('dl', { class: 'props proc-props' });
  const status = h('span', { class: 'proc-status' });
  const killBtn = h('button', { type: 'button', class: 'proc-kill' }, '強制關閉');
  win.body.append(h('div', { class: 'proc-body' }, list), h('div', { class: 'proc-foot' }, status, killBtn));
  let prev = null;
  let timer = null;
  let alive = true;
  let gone = false;

  const ended = (text) => {
    gone = true;
    killBtn.disabled = true;
    status.textContent = text;
    status.classList.add('ended');
  };
  const show = (info) => {
    const time = parseFloat(info.time);
    const ticks = Number(info.ticks);
    const clk = Number(info.clk) || 100;
    const dt = prev ? time - prev.time : 0;
    const cpu = dt > 0.2 && Number.isFinite(ticks) ? Math.max(0, ((ticks - prev.ticks) / clk / dt) * 100) : null;
    prev = { time, ticks };
    const rows = [
      ['名稱', info.comm],
      ['PID', pid],
      ['父行程 PID', info.ppid],
      ['執行者', info.user],
      ['狀態', STATES[info.stat?.[0]] || info.stat],
      ['CPU', cpu == null ? '計算中…' : cpu.toFixed(1) + '%'],
      ['記憶體', fmtSize(Number(info.rss) * 1024)],
      ['虛擬記憶體', fmtSize(Number(info.vsz) * 1024)],
      ['執行緒', info.nlwp],
      ['已執行', info.etime],
      ['啟動時間', info.lstart],
      ['指令', info.cmd || `[${info.comm}]`],
      ['工作目錄', info.cwd || '—'],
      ['執行檔', info.exe || '—'],
    ];
    list.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { 'data-k': k }, v ?? '—')]));
  };

  async function tick() {
    if (!alive || gone) return;
    let delay = 3000;
    if (!win.minimized && conn.ws) {
      try {
        const res = await rpc('procInfo', { pid });
        if (!alive || gone) return;
        if (!res.alive) return ended('這個行程已經結束');
        if (!prev) delay = 1000;
        show(res.info);
      } catch (err) {
        if (!alive) return;
        status.textContent = `無法讀取：${errText(err)}`;
        if (err.code === 'exec-failed') return;
      }
    }
    timer = setTimeout(tick, delay);
  }

  killBtn.addEventListener('click', async () => {
    const ok = await dialog({
      title: `要強制關閉「${name}」（PID ${pid}）嗎？`,
      message: '行程會立刻被終止，沒有機會儲存資料。',
      buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '強制關閉', value: true, danger: true }],
    });
    if (!ok || gone) return;
    killBtn.disabled = true;
    try {
      await rpc('kill', { pid });
      clearTimeout(timer);
      ended('已強制關閉');
    } catch (err) {
      killBtn.disabled = false;
      if (err.code === 'not-found') return ended('這個行程已經結束');
      toast(`無法關閉「${name}」：${err.code === 'permission-denied' ? '權限不足，這個行程不屬於你' : errText(err)}`, true);
    }
  });
  win.destroy = () => {
    alive = false;
    clearTimeout(timer);
    open.delete(pid);
  };
  tick();
}
