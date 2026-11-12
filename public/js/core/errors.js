// Error codes sent by the Worker and their user-facing text.
export const ERROR_TEXT = {
  'auth-failed': '登入失敗：帳號、密碼或金鑰不正確',
  'connect-failed': '無法連線到主機，請確認位置與連接埠',
  'private-address': '無法連線到本機或內網位址，請改用公開位址',
  'connect-timeout': '連線逾時',
  'host-not-allowed': '不允許連線到這台主機',
  'hostkey-changed': '主機金鑰與上次不同',
  'bad-key': '無法讀取這個私鑰檔（格式不支援，或不是私鑰）',
  'key-needs-passphrase': '這把私鑰有密碼保護，請輸入金鑰密碼',
  'key-bad-passphrase': '金鑰密碼不正確',
  'not-found': '找不到檔案或資料夾',
  exists: '已經有同名的項目',
  'wrong-password': '密碼沒有變更：目前的密碼不正確，或新密碼不符合主機的規定',
  'sudo-failed': 'sudo 驗證失敗，或這個帳號沒有 sudo 權限',
  'bad-username': '帳號名稱只能用小寫英文、數字、底線和連字號，且不能以數字開頭',
  'into-itself': '不能把資料夾放進它自己裡面',
  'too-many': '項目太多，超過一次能處理的上限',
  'too-deep': '資料夾層數太深',
  'no-terminal': '這個終端機已經關閉',
  'permission-denied': '權限不足',
  'too-large': '檔案太大（上限 5 MB）',
  'not-a-file': '這不是一般檔案',
  'exec-failed': '這台主機不允許執行指令，無法讀取資源資訊',
  'not-connected': '連線已中斷',
  disconnected: '連線已中斷',
  timeout: '主機沒有回應',
  closed: '主機關閉了連線',
};
export function errText(err) {
  return ERROR_TEXT[err?.code] || err?.message || String(err);
}
export function appError(code, message) {
  const e = new Error(message || ERROR_TEXT[code] || code);
  e.code = code;
  return e;
}
