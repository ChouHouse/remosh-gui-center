// Reads the title and the artist out of an MP3's ID3v2 tag (the part at the
// very start of the file). Other formats, or files without a tag, give {}.
const DECODERS = ['iso-8859-1', 'utf-16', 'utf-16be', 'utf-8'];

function text(bytes) {
  if (!bytes.length) return '';
  const enc = DECODERS[bytes[0]] || 'utf-8';
  try {
    return new TextDecoder(enc).decode(bytes.subarray(1)).replace(/\0+$/g, '').split('\0')[0].trim();
  } catch {
    return '';
  }
}

export function readTags(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return {}; // "ID3"
  const major = bytes[3];
  if (major !== 3 && major !== 4) return {};
  const syncsafe = (at) => ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
  const plain = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const end = Math.min(bytes.length, 10 + syncsafe(6));
  const out = {};
  for (let at = 10; at + 10 <= end;) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const size = major === 4 ? syncsafe(at + 4) : plain(at + 4);
    const body = bytes.subarray(at + 10, Math.min(end, at + 10 + size));
    if (id === 'TIT2') out.title = text(body);
    else if (id === 'TPE1') out.artist = text(body);
    at += 10 + size;
  }
  return out;
}
