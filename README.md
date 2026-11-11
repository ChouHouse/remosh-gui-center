# SSH Desk

A Cloudflare Worker that logs in to an SSH server and shows its files as a small
desktop in the browser: a Finder-style file browser, and every file you open
gets its own Monaco window (the editor component of VS Code, not the whole
workbench) with an entry in the taskbar at the bottom.

## Two ways to run it

The same code runs on both; the start command picks the platform.

| | Cloudflare Worker | Docker (Remosh GUI Center) |
| --- | --- | --- |
| Start | `npm run deploy` | `docker run ... ghcr.io/chouhouse/remosh-gui-center` |
| Entry | `src/index.js` + `src/platform/worker.js` | `server/main.js` + `src/platform/node.js` |
| SSH targets | public addresses only | anything the container can reach, LAN included |
| SSH ciphers | AES-CTR + HMAC-SHA2 | everything ssh2 supports |

## Docker

```bash
docker run -d \
  --name=remosh-gui \
  --restart always \
  -e WEB_PASSWORD=your_access_password \
  -p 8080:8080 \
  ghcr.io/chouhouse/remosh-gui-center:latest
```

| Variable | Description | Default |
| :--- | :--- | :--- |
| `WEB_PASSWORD` | Access password asked before the SSH login screen. Leave it empty and anyone who can reach the port can use the site. | *None* |
| `cloudflared` | (Optional) Cloudflare Tunnel token; the tunnel should point at `http://localhost:8080`. | *None* |
| `ALLOWED_HOSTS` | (Optional) Comma-separated SSH targets that may be reached, e.g. `10.0.0.5,example.com:2222`. | *None* |
| `PORT` | Port inside the container. | `8080` |

The image is based on `ccp-base-debian`, runs as a non-root user, and keeps
the tunnel token in `/ccp/flags` like Remosh. `WEB_PASSWORD` works on the
Worker too (`wrangler secret put WEB_PASSWORD`).

The access password is checked by the server: `/ws` is refused without the
cookie it sets (HttpOnly, 12 hours), and five wrong tries from one address
lock it for a minute.

## How it works

```
browser ──WebSocket /ws──▶ Worker ──▶ Durable Object ──TCP (cloudflare:sockets)──▶ SSH server
  UI + Monaco               routing     ssh2 client + SFTP, one per connection
```

Nothing is bundled for the browser: the page loads native ES modules.

```
server/main.js          Node entry (Docker): static files, /ws, /api/gate
docker/                 run.sh, cloudflared supervisor
src/                    shared by both entries
  index.js              fetch handler, and SessionDO (the Durable Object per connection)
  session.js            one SSH/SFTP session per WebSocket, login, op dispatch
  ssh.js                socket adapter, algorithms, run-a-command helper
  gate.js               optional access password (WEB_PASSWORD)
  platform/             worker.js / node.js: how each runtime opens TCP
  util.js               shared helpers
  ops/                  one handler per request name
    index.js            the registry (files, manage, stats, terminal)
    files.js  manage.js  stats.js  terminal.js
public/
  index.html
  css/                  base, login, shell + css/apps/<app>.css
  js/
    main.js             imports the apps (start-menu order) and boots
    core/               dom, store, errors, ui, format, path, icons, events, rpc, text-codec, settings
    shell/              wm (windows), menubar, context-menu, drag, file-drop, shortcuts,
                        desktop-icons, login, gate, start-menu, clock, style, fullscreen,
                        desktop, apps (registry), file-open (associations)
    apps/
      files/            檔案櫃
      editor/           Monaco windows (index.js, monaco.js)
      notepad/          記事本
      terminal/         終端機
      taskman/          工作管理員 (index.js, stats.js)
      settings/         設定
  vs/  xterm/           Monaco and xterm.js, copied by `npm run assets` (not committed)
```

### Adding an app

1. Create `public/js/apps/<name>/index.js`. Build the window with
   `createWindow()` from `shell/wm.js` (and `attachMenuBar()` from
   `shell/menubar.js` if it needs menus), then register it:

   ```js
   registerApp({ id: 'notes', name: '記事本', icon: () => svg, startMenu: true, launch: openNotes });
   ```

   Optional fields: `autostart`, `extensions` (`'all'` or a list such as
   `['txt', 'md']`; `launch({ path, size })` then opens a remote file) and
   `unsavedCount()` (asked before logout).
2. Import it in `public/js/main.js` and add `css/apps/<name>.css` to `index.html`.
3. If it needs new data from the host, add a handler in `src/ops/` and list it
   in `src/ops/index.js`; call it from the page with `rpc('<op>', args)`.

### Drag and drop

`shell/drag.js` is the one drag API. `makeDraggable(element, (ev) => payload)`
makes things draggable; the payload is `{ type, name, icon, data }` and the
card that follows the pointer always shows that icon and name.
`registerDropTarget(element, { accepts, action, onDrop })` receives them.
Built-in payload types are `file` (`data.path`) and `app` (`data.id`);
`shell/file-drop.js` holds the move / copy / shortcut rules shared by the file
cabinet and the desktop.

### System colour and light/dark

`shell/style.js` owns the one system colour and the light/dark mode chosen in
設定 → 樣式. A system app follows them just by using the CSS variables
(`--accent`, `--accent-text`, `--select`, `--folder`, `--surface`, ...). An app
that needs the values in code calls `systemColor()` / `effectiveMode()` and
listens for `settings:changed`. An app that does neither keeps its own colours:
the code editor only switches between its own light and dark theme.

Apps do not import each other. They talk through `core/events.js`
(`session:start`, `session:resume`, `session:end`, `conn:lost`, `fs:changed`,
`fs:moved`, `settings:changed`)
`shell/apps.js` (`launchApp`) and `shell/file-open.js` (`openFile`, `openWith`).

Log in with a password or a private key file (OpenSSH / PEM / PPK; RSA, ECDSA
or Ed25519, optionally passphrase-protected). Neither is stored; the key text is
sent to the Worker over the WebSocket for the login and kept only in memory. Host keys are not remembered or checked, so a host that is recreated with a new key
connects without a warning (and a changed key is not detected).

## Run

```bash
npm install
npm run dev      # Worker runtime, http://localhost:3000
npm run assets && WEB_PASSWORD=secret npm start   # Node server, http://localhost:8080
npm run deploy   # publish to Cloudflare
```

## Desktop

- **Installable**: a web app manifest and icons let Safari ("Add to Dock",
  "Add to Home Screen") and Chrome/Edge install it as an app.
- **Full screen** after a successful login (and from the start menu); logging
  out leaves it.
- **Start menu** (bottom left): pinned apps and 所有應用程式; right-click an app to
  pin or unpin it, or drag it onto the desktop. Click the user for full screen
  and 登出.
- **Desktop**: shows whatever is in `~/.remosh-gui/desktop`. New icons fill
  columns from the top left; an icon dragged to another grid cell stays there
  (positions are an array of `{ name, col, row }` in
  `desktop/config.inv-remosh_gui-config`). Files whose extension starts with
  `inv-` are internal and never listed anywhere in the GUI. Drop a file or folder on it to move it there (Ctrl = copy, Alt =
  shortcut). Shortcuts are one-line text files: `name.remosh_gui-app` holds
  `app:<id>`, `name.remosh_gui-lnk` holds `lnk:<path>`.
- **Windows**: drag to the left or right edge for half the screen, to the top to
  maximise; the strip at the far right of the taskbar shows the desktop.
- **Taskbar**: one entry per open window, clock at the right.
- **Task manager**: CPU, memory and the process list of the SSH host, refreshed
  every 3 s by a fixed read-only script run over SSH. When the host is a
  container it reads the container's own cgroup usage and limits (v2 or v1)
  instead of `/proc` totals, which would describe the Docker host.

- **File cabinet** (檔案櫃): any number of windows; each re-reads its folder every 4 s. Right-click a file
  for 開啟 / 開啟程式… / 複製 / 剪下 / 貼上 / 重新命名 / 刪除 / 內容, empty space for
  新增資料夾 / 在這裡開啟終端機; right-click the sidebar to add or remove folders.
  Copy and cut put `remosh/file:<path>` on the clipboard.
- **File associations**: every app declares the extensions it accepts
  (`extensions: 'all'` or a list). The first time an extension is opened the
  user is asked which app to use and the answer is remembered; 設定 → 檔案關聯
  lists them and lets them be changed or removed (not added by hand).
- **Notepad** (記事本): a plain textarea editor, no Monaco.
- **Terminal** (終端機): an interactive shell (xterm.js + an SSH PTY channel).
  Opening a file with it sets the file to mode 777 and runs it as `./name`
  from its folder.
- **Settings** (設定): categories on the left (動畫: on/off and speed; 檔案關聯; 樣式: light/dark mode, which side the window
  buttons sit on, one system colour, and a wallpaper — the last five uploads are
  kept in `~/.remosh-gui/wallpaper`). 儲存 writes `~/.remosh-gui/setting.json` on the SSH host, so settings
  follow the account, and they are read back at login. Add a setting in
  `core/settings.js` and a category in `apps/settings/index.js`.

## Deploying to Cloudflare

```bash
npx wrangler login   # or set CLOUDFLARE_API_TOKEN
npm run deploy
```

Works on the Workers Free plan. How the project fits the platform limits:

| Limit | Platform | This project |
| --- | --- | --- |
| CPU time | Worker: 10 ms (Free) / 30 s (Paid) for the whole connection. Durable Object: 30 s, renewed by every incoming message | The SSH session runs in a Durable Object (`SessionDO`), so each request from the page gets a fresh budget |
| Durable Objects on Free | SQLite-backed classes only | `new_sqlite_classes` migration; nothing is stored |
| WebSocket message | 32 MiB received | Largest is a 5 MB file as base64, about 7 MiB |
| Worker size | 3 MB gzip (Free) | about 150 KiB gzip |
| Static assets | 20,000 files, 25 MiB each | about 260 files, largest 5.7 MB |
| Outbound TCP | No loopback, private or Cloudflare addresses; no port 25 | The SSH host needs a public address; the login form says so when a private one fails |

Connections are dropped when Cloudflare updates the runtime or the Worker is
redeployed; the page then asks for the password again and keeps the open
windows. A terminal that prints continuously while the page sends nothing can
use up the 30 s CPU budget between messages (the page pings every 25 s).

## Editor shortcuts

Everything Monaco ships with (Ctrl+C / Ctrl+V / Ctrl+X, Ctrl+Z / Ctrl+Y,
Ctrl+F / Ctrl+H, Ctrl+/, Alt+↑↓, Ctrl+D, multi-cursor, F1 command palette ...)
plus:

| Key | Action |
| --- | --- |
| Ctrl+S | Save the file back to the SSH host |
| Ctrl+Shift+S | Save as (the window switches to the new file) |
| Alt+Z | Toggle word wrap |
| Ctrl+= / Ctrl+- / Ctrl+0 | Larger / smaller / default text size |

Each editor window has two menus: 檔案 (undo, redo, save, save as, close) and
介面 (text size, minimap on/off, word wrap). The 介面 settings apply to every
editor window and are remembered in the browser.

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
