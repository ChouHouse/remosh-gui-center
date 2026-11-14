// Bytes <-> text for the editor (UTF-8 and Big5) and base64 for the wire.
import { appError } from './errors.js';
import { tt } from './i18n.js';

export let big5Table = null;
export function big5Encoder() {
  if (big5Table) return big5Table;
  // Browsers can decode Big5 but not encode it, so build the reverse table
  // from the decoder (same range and duplicate rules as the WHATWG encoder).
  const map = new Map();
  const dec = new TextDecoder('big5');
  const pair = new Uint8Array(2);
  const preferLast = new Set(['═', '╞', '╡', '╪', '十', '卅']);
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail > 0x7e && trail < 0xa1) continue;
      pair[0] = lead;
      pair[1] = trail;
      const s = dec.decode(pair);
      if (s.includes('�') || [...s].length !== 1) continue;
      if (!map.has(s) || preferLast.has(s)) map.set(s, (lead << 8) | trail);
    }
  }
  return (big5Table = map);
}

export function decodeText(bytes) {
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return null;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8', bom };
  } catch {
    /* not UTF-8 */
  }
  try {
    return { text: new TextDecoder('big5', { fatal: true }).decode(bytes), encoding: 'Big5', bom: false };
  } catch {
    return null;
  }
}

export function encodeText(text, encoding, bom) {
  if (encoding === 'UTF-8') {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const table = big5Encoder();
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else {
      const v = table.get(ch);
      if (v == null) throw appError('unencodable', tt('字元「{0}」無法用 Big5 儲存', ch));
      out.push(v >> 8, v & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
