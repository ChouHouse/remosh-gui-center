// This app's texts in the other languages (the source text is Traditional Chinese).
import { addStrings } from '../../core/i18n.js';

addStrings({
  en: {
    '終端機': 'Terminal',
    '\r\n\u001b[90m[工作階段已結束]\u001b[0m\r\n': '\r\n\u001b[90m[Session ended]\u001b[0m\r\n',
    '\r\n\u001b[90m[連線已中斷]\u001b[0m\r\n': '\r\n\u001b[90m[Connection lost]\u001b[0m\r\n',
    '瀏覽器不允許寫入剪貼簿': 'The browser does not allow writing to the clipboard',
    '瀏覽器不允許讀取剪貼簿（需要 https），請改用 {0}': 'The browser does not allow reading the clipboard (https is needed). Use {0} instead',
    '複製（{0}）': 'Copy ({0})',
    '貼上（{0}）': 'Paste ({0})',
    '清除畫面': 'Clear screen',
    '無法開啟終端機：{0}': 'Could not open the terminal: {0}',
  },
  ja: {
    '終端機': 'ターミナル',
    '\r\n\u001b[90m[工作階段已結束]\u001b[0m\r\n': '\r\n\u001b[90m[セッションが終了しました]\u001b[0m\r\n',
    '\r\n\u001b[90m[連線已中斷]\u001b[0m\r\n': '\r\n\u001b[90m[接続が切れました]\u001b[0m\r\n',
    '瀏覽器不允許寫入剪貼簿': 'ブラウザがクリップボードへの書き込みを許可していません',
    '瀏覽器不允許讀取剪貼簿（需要 https），請改用 {0}': 'ブラウザがクリップボードの読み取りを許可していません（https が必要です）。{0} を使ってください',
    '複製（{0}）': 'コピー（{0}）',
    '貼上（{0}）': '貼り付け（{0}）',
    '清除畫面': '画面をクリア',
    '無法開啟終端機：{0}': 'ターミナルを開けません：{0}',
  },
});
