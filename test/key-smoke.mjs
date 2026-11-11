// Private-key login check.
// usage: node test/key-smoke.mjs ws://127.0.0.1:3000/ws host port user keyfile [passphrase]
import { readFileSync } from 'node:fs';
const [url, host, port, username, keyfile, passphrase] = process.argv.slice(2);
const ws = new WebSocket(url);
ws.onerror = () => { console.error('ws error'); process.exit(1); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  console.log(keyfile.split('/').pop(), passphrase ? '(passphrase)' : '', '->', m.ok ? 'ok, home ' + m.home : 'FAIL ' + m.error.code + ': ' + m.error.message);
  ws.close();
  process.exit(m.ok ? 0 : 1);
};
ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: 'connect', host, port: Number(port), username, privateKey: readFileSync(keyfile, 'utf8'), passphrase }));
