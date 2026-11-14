// This app's texts in the other languages (the source text is Traditional Chinese).
import { addStrings } from '../../core/i18n.js';

addStrings({
  en: {
    '「{0}」太大（{1}），記事本上限是 5 MB': '“{0}” is too large ({1}); Notepad\'s limit is 5 MB',
    '記事本': 'Notepad',
    '文字內容': 'Text',
    '新文件': 'New document',
    '不是文字檔': 'Not a text file',
    '「{0}」已經在另一個記事本視窗開啟': '“{0}” is already open in another Notepad window',
    '瀏覽器不允許讀取剪貼簿，請改用 Ctrl+V': 'The browser does not allow reading the clipboard. Use Ctrl+V instead',
  },
  ja: {
    '「{0}」太大（{1}），記事本上限是 5 MB': '「{0}」は大きすぎます（{1}）。メモ帳の上限は 5 MB です',
    '記事本': 'メモ帳',
    '文字內容': 'テキストの内容',
    '新文件': '新しい文書',
    '不是文字檔': 'テキストファイルではありません',
    '「{0}」已經在另一個記事本視窗開啟': '「{0}」は別のメモ帳ウインドウで開いています',
    '瀏覽器不允許讀取剪貼簿，請改用 Ctrl+V': 'ブラウザがクリップボードの読み取りを許可していません。Ctrl+V を使ってください',
  },
});
