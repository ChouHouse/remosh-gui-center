// Optional access password in front of everything (env WEB_PASSWORD).
// With it set, the page must log in here before it may open the WebSocket.
//
// Stateless: the cookie is "<expiry>.<HMAC(expiry)>" keyed from the password,
// so it works across Worker isolates and changing the password logs everyone out.
// Uses only WebCrypto, which both Workers and Node provide.
const COOKIE = 'remosh_gate';
const TTL_SECONDS = 12 * 60 * 60;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((b) => parseInt(b, 16)));
const sha256 = (text) => crypto.subtle.digest('SHA-256', enc.encode(text));

// Failed attempts: a short lock per address and overall (best effort, in memory).
const MAX_PER_IP = 5;
const MAX_TOTAL = 40;
const WINDOW_MS = 60 * 1000;

export function createGate(password) {
  const required = typeof password === 'string' && password.length > 0;
  let keyPromise = null;
  const key = () => (keyPromise ??= sha256('remosh-gate\0' + password).then((raw) =>
    crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])));
  const failures = new Map(); // ip -> [timestamps]
  let allFailures = [];
  const recent = (list, now) => list.filter((t) => now - t < WINDOW_MS);

  async function matches(candidate) {
    // Compare digests so the comparison takes the same time for any input.
    const [a, b] = await Promise.all([sha256('cmp\0' + candidate), sha256('cmp\0' + password)]);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  }

  return {
    required,

    // Resolves to { token } on success, { locked: seconds } or { wrong: true } otherwise.
    async login(candidate, ip = 'unknown') {
      if (!required) return { token: '' };
      const now = Date.now();
      allFailures = recent(allFailures, now);
      const mine = recent(failures.get(ip) || [], now);
      if (mine.length >= MAX_PER_IP || allFailures.length >= MAX_TOTAL) {
        const oldest = (mine.length >= MAX_PER_IP ? mine : allFailures)[0];
        return { locked: Math.ceil((WINDOW_MS - (now - oldest)) / 1000) };
      }
      if (typeof candidate !== 'string' || candidate.length > 1024 || !(await matches(candidate))) {
        mine.push(now);
        allFailures.push(now);
        failures.set(ip, mine);
        if (failures.size > 5000) failures.clear();
        await new Promise((r) => setTimeout(r, 400));
        return { wrong: true };
      }
      failures.delete(ip);
      const exp = String(Math.floor(now / 1000) + TTL_SECONDS);
      return { token: `${exp}.${hex(await crypto.subtle.sign('HMAC', await key(), enc.encode(exp)))}` };
    },

    // True when the request's Cookie header carries a valid, unexpired token.
    async check(cookieHeader) {
      if (!required) return true;
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([0-9a-f]{64})(?:;|$)`).exec(cookieHeader || '');
      if (!m || Number(m[1]) * 1000 < Date.now()) return false;
      return crypto.subtle.verify('HMAC', await key(), unhex(m[2]), enc.encode(m[1]));
    },

    cookie(token, secure) {
      return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_SECONDS}${secure ? '; Secure' : ''}`;
    },
    clearCookie() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// Handles /api/gate for either entry. Returns a Response, or null for other paths.
//   GET    -> { required, ok }
//   POST   { password } -> sets the cookie
//   DELETE -> clears it
export async function handleGateApi(request, gate, { ip, secure }) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/gate') return null;
  if (request.method === 'GET') return json({ required: gate.required, ok: await gate.check(request.headers.get('Cookie')) });
  if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': gate.clearCookie() });
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  // A cross-site page must not be able to submit guesses on a visitor's behalf.
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== (request.headers.get('Host') || url.host)) return json({ error: 'origin' }, 403);
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* treated as a wrong password */
  }
  const result = await gate.login(body?.password, ip);
  if (result.locked) return json({ ok: false, locked: result.locked }, 429);
  if (result.wrong) return json({ ok: false }, 401);
  return json({ ok: true }, 200, { 'Set-Cookie': gate.cookie(result.token, secure) });
}
