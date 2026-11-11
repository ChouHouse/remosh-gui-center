# SSH Desk

A Cloudflare Worker that logs in to an SSH server and shows its files as a small
desktop in the browser: a Finder-style file browser, and every file you open
gets its own Monaco window (the editor component of VS Code, not the whole
workbench) with an entry in the taskbar at the bottom.

## How it works

```
browser ──WebSocket /ws──▶ Worker ──TCP (cloudflare:sockets)──▶ SSH server
  UI + Monaco                ssh2 client + SFTP
```

- `src/worker.js` — one SSH/SFTP session per WebSocket; JSON requests
  (`connect`, `list`, `read`, `write`, ...).
- `public/` — the page (`index.html`, `app.css`, `app.js`). `public/vs` is
  Monaco, copied from `node_modules` by `npm run assets` (not committed).

Log in with a password or a private key file (OpenSSH / PEM / PPK; RSA, ECDSA
or Ed25519, optionally passphrase-protected). Neither is stored; the key text is
sent to the Worker over the WebSocket for the login and kept only in memory. The browser
remembers each host's key fingerprint (trust on first use) and warns when it
changes.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run deploy   # publish to Cloudflare
```

## Editor shortcuts

Everything Monaco ships with (Ctrl+C / Ctrl+V / Ctrl+X, Ctrl+Z / Ctrl+Y,
Ctrl+F / Ctrl+H, Ctrl+/, Alt+↑↓, Ctrl+D, multi-cursor, F1 command palette ...)
plus:

| Key | Action |
| --- | --- |
| Ctrl+S | Save the file back to the SSH host |
| Alt+Z | Toggle word wrap |

Files are read and written as UTF-8 (BOM kept) or Big5, with the original line
endings; binary files and files over 5 MB are not opened.

## Language features

TypeScript, JavaScript, JSON, CSS and HTML get diagnostics, completion and hover
from Monaco's built-in language services, which run in the browser. Each file is
analysed on its own — imports of other remote files are not resolved.

## Limits worth knowing

- Workers cannot run ssh2's AES-GCM / ChaCha20 code, so the connection
  negotiates AES-CTR with HMAC-SHA2. A server that only allows AEAD ciphers
  will refuse the handshake.
- Cloudflare does not let Workers open sockets to private/Cloudflare IP ranges
  in production, so the SSH server needs a public address.
- **Restrict who can use it.** With `ALLOWED_HOSTS` empty, anyone who can open
  the page can use the Worker to try logins against any SSH server. Set
  `ALLOWED_HOSTS` in `wrangler.jsonc` and/or put the Worker behind Cloudflare
  Access.

## Tests

```bash
node test/ws-smoke.mjs ws://127.0.0.1:3000/ws <host> <port> <user> <password>
NODE_PATH=<playwright>/node_modules node test/e2e.cjs http://127.0.0.1:3000 <host> <port> <user> <password> <home>
```

Both expect the test account's home to contain `project/src/math.ts`,
`project/README.md`, `docs/notes.txt`, `docs/blob.bin` and a Big5
`docs/legacy.asp` with a copy at `docs/legacy.orig`.
