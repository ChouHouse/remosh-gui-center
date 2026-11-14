// Error codes sent by the server and their user-facing text.
import { tm, tt } from './i18n.js';
export const ERROR_TEXT = {
  'auth-failed': tm('登入失敗：帳號、密碼或金鑰不正確'),
  'connect-failed': tm('無法連線到主機，請確認位置與連接埠'),
  'connect-timeout': tm('連線逾時'),
  'host-not-allowed': tm('不允許連線到這台主機'),
  'hostkey-changed': tm('主機金鑰與上次不同'),
  'bad-key': tm('無法讀取這個私鑰檔（格式不支援，或不是私鑰）'),
  'key-needs-passphrase': tm('這把私鑰有密碼保護，請輸入金鑰密碼'),
  'key-bad-passphrase': tm('金鑰密碼不正確'),
  'not-found': tm('找不到檔案或資料夾'),
  exists: tm('已經有同名的項目'),
  'wrong-password': tm('密碼沒有變更：目前的密碼不正確，或新密碼不符合主機的規定'),
  'sudo-failed': tm('sudo 驗證失敗，或這個帳號沒有 sudo 權限'),
  'bad-username': tm('帳號名稱只能用小寫英文、數字、底線和連字號，且不能以數字開頭'),
  'into-itself': tm('不能把資料夾放進它自己裡面'),
  'too-many': tm('項目太多，超過一次能處理的上限'),
  'too-deep': tm('資料夾層數太深'),
  'no-terminal': tm('這個終端機已經關閉'),
  'permission-denied': tm('權限不足'),
  'too-large': tm('檔案太大'),
  'not-a-file': tm('這不是一般檔案'),
  'exec-failed': tm('這台主機不允許執行指令，無法讀取資源資訊'),
  'not-connected': tm('連線已中斷'),
  disconnected: tm('連線已中斷'),
  timeout: tm('主機沒有回應'),
  closed: tm('主機關閉了連線'),
};
export function errText(err) {
  return ERROR_TEXT[err?.code] ? tt(ERROR_TEXT[err.code]) : err?.message || String(err);
}
export function appError(code, message) {
  const e = new Error(message || (ERROR_TEXT[code] ? tt(ERROR_TEXT[code]) : code));
  e.code = code;
  return e;
}
