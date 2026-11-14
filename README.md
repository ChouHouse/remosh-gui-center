# Remosh GUI Center

A desktop in the browser for SSH hosts. A small Node server logs in to an SSH
server and shows its files as a desktop: a file cabinet, a code editor
(Procoder, built on Monaco), a terminal, a task manager and settings, with a
taskbar at the bottom. It ships as a Docker image.

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
the tunnel token in `/ccp/flags` like Remosh. It can reach anything the
container can reach, LAN addresses included.

The access password is checked by the server: `/ws` is refused without the
cookie it sets (HttpOnly, 12 hours), and five wrong tries from one address
lock it for a minute.

## How it works

```
browser ──WebSocket /ws──▶ Node server ──TCP──▶ SSH server
  UI + Monaco               ssh2 client + SFTP, one session per connection
```

Nothing is bundled for the browser: the page loads native ES modules.

```
server/main.js          entry: static files, /ws, /api/gate
docker/                 run.sh, cloudflared supervisor
src/
  session.js            one SSH/SFTP session per WebSocket, login, op dispatch
  net.js                opens the TCP connection to the SSH server
  ssh.js                run-a-command helper
  gate.js               optional access password (WEB_PASSWORD)
  util.js               shared helpers
  ops/                  one handler per request name
    index.js            the registry (files, manage, stats, process, terminal, account)
    files.js  manage.js  stats.js  terminal.js
public/
  index.html
  css/                  base, login, shell (the system's own styles)
  js/
    main.js             imports the apps (start-menu order) and boots
    core/               dom, store, errors, ui, format, path, icons, events, rpc, text-codec, settings
    shell/              wm (windows), menubar, context-menu, drag, file-drop, shortcuts,
                        desktop-icons, login, gate, start-menu, clock, style, fullscreen,
                        desktop, apps (registry), file-open (associations)
    apps/               one folder per app: index.js, icon.js, style.css
      files/            檔案櫃
      editor/           Procoder: one window with tabs (index.js, welcome.js, monaco.js)
      notepad/          記事本
      graphoto/         Graphoto (image viewer)
      terminal/         終端機
      taskman/          工作管理員 (index.js, stats.js, chart.js, process.js)
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
2. Import it in `public/js/main.js`. Everything else belongs in the app's folder:
   its icon (`icon.js`) and its styles (`style.css`, loaded by the app with
   `useAppStyle(import.meta.url)` from `shell/apps.js`). `core/` and `shell/` hold
   only what the whole system shares (file and folder icons, toolbar icons,
   windows, the status bar ...).
   What an app saves goes through `appStore('<app id>')` (`core/app-store.js`)
   into `~/.remosh-gui/app/<app id>/` on the host; only the system's own
   settings sit directly in `~/.remosh-gui/`.
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

### Selection

The file cabinet and the desktop support several selected items: Ctrl+click,
Shift+click (file cabinet), Ctrl+A, and a rubber-band box drawn from empty
space (`shell/marquee.js`, `attachMarquee(container, { itemSelector, onChange })`).
Copy, cut, delete and drag act on the whole selection; a drag payload lists
every file in `data.paths`.

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
sent to the server over the WebSocket for the login and kept only in memory. Host keys are not remembered or checked, so a host that is recreated with a new key
connects without a warning (and a changed key is not detected).

## Run

```bash
npm install
npm run assets && WEB_PASSWORD=secret npm start   # http://localhost:8080
```

## Desktop

- **Installable**: a web app manifest and icons let Safari ("Add to Dock",
  "Add to Home Screen") and Chrome/Edge install it as an app.
- **Full screen** after a successful login (and from the start menu); logging
  out leaves it.
- **Start menu** (bottom left): pinned apps and 所有應用程式; right-click an app to
  pin or unpin it, or drag it onto the desktop. Click the user for 切換使用者,
  full screen and 登出.
- **Several users at once**: 切換使用者 signs another user in while the current one
  stays connected; signed-in users are listed on the user card and at the bottom
  left of the login screen, and one click switches back without a password.
  Each extra user is the same page in a full-size frame (`shell/sessions.js`).
- **Desktop**: shows whatever is in `~/.remosh-gui/desktop`. New icons fill
  columns from the top left; an icon dragged to another grid cell stays there
  (positions are an array of `{ name, col, row }` in
  `desktop/config.inv-remosh_gui-config`). Files whose extension starts with
  `inv-` are internal and never listed anywhere in the GUI. Drop a file or folder on it to move it there (Ctrl = copy, Alt =
  shortcut). Shortcuts are one-line text files: `name.remosh_gui-app` holds
  `app:<id>`, `name.remosh_gui-lnk` holds `lnk:<path>`.
- **Windows**: drag to the left or right edge for half the screen, to the top to
  maximise; the strip at the far right of the taskbar shows the desktop.
- **Taskbar**: one entry per open window; 設定 → 工作列 sets its size, icons only
  or with titles, left or centred (dock mode: start button included), and auto-hide (3 s after
  the pointer leaves). More entries than fit scroll
  with the wheel. Clicking the clock opens a calendar.
- **Accounts** (設定 → 帳號): change your password; with root or sudo, create
  users (`passwd` / `chpasswd` / `useradd` run on the host, passwords on stdin).
- **Task manager**: two pages. 進程 is the process list (double-click one for
  details and force close); 圖表 charts CPU (with the processor's name), memory
  and network over the last three minutes and shows how full the storage is.
  Refreshed every 3 s by a fixed read-only script run over SSH. When the host is a
  container it reads the container's own cgroup usage and limits (v2 or v1)
  instead of `/proc` totals, which would describe the Docker host.

- **File cabinet** (檔案櫃): any number of windows; each re-reads its folder every 4 s. Right-click a file
  for 開啟 / 開啟程式… / 複製 / 剪下 / 貼上 / 重新命名 / 刪除 / 內容, empty space for
  新增資料夾 / 在這裡開啟終端機; right-click the sidebar to add or remove folders.
  Copy and cut put `remosh/file:<path><<id>>` on the clipboard; the id names the
  server and account, and pasting files with another id is refused.
- **File associations**: every app declares the extensions it accepts
  (`extensions: 'all'` or a list). The first time an extension is opened the
  user is asked which app to use and the answer is remembered; 設定 → 檔案關聯
  lists them and lets them be changed or removed (not added by hand).
- **Graphoto**: the image viewer (png, jpg, gif, webp, avif, bmp, ico, svg).
  Wheel or +/- to zoom, drag to move, R to rotate, 0 to fit, 1 for actual size;
  ← / → (or the mouse side buttons) step through the pictures in the same folder.
- **Notepad** (記事本): a plain textarea editor, no Monaco.
- **Terminal** (終端機): an interactive shell (xterm.js + an SSH PTY channel).
  Opening a file with it sets the file to mode 777 and runs it as `./name`
  from its folder.
- **Settings** (設定): categories on the left (動畫: on/off and speed; 檔案關聯; 樣式: light/dark mode, which side the window
  buttons sit on, one system colour, and a wallpaper — the last five uploads are
  kept in `~/.remosh-gui/wallpaper`). 儲存 writes `~/.remosh-gui/setting.inv-remosh_gui-config` (JSON; `setting.json` from
  earlier versions is moved over at login) on the SSH host, so settings
  follow the account, and they are read back at login. Add a setting in
  `core/settings.js` and a category in `apps/settings/index.js`.

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
endings; binary files are not opened. Large files travel in pieces
(`core/file-io.js`, `readChunk` / `writeChunk`), so there is no fixed limit;
above 200 MB the window asks before opening.

## Language features

TypeScript, JavaScript, JSON, CSS and HTML get diagnostics, completion and hover
from Monaco's built-in language services, which run in the browser. Each file is
analysed on its own — imports of other remote files are not resolved.

## Limits worth knowing

- **Restrict who can use it.** With `ALLOWED_HOSTS` empty, anyone who can open
  the page can use the server to try logins against any SSH server it can
  reach, the container's own network included. Set `WEB_PASSWORD`, and
  `ALLOWED_HOSTS` where the targets are known.
- A dropped connection is logged in again by the page (the login is kept in
  memory while the page is open); a running terminal does not come back.

## Tests

```bash
node test/ws-smoke.mjs ws://127.0.0.1:8080/ws <host> <port> <user> <password>
NODE_PATH=<playwright>/node_modules node test/e2e.cjs http://127.0.0.1:8080 <host> <port> <user> <password> <home>
```

Both expect the test account's home to contain `project/src/math.ts`,
`project/README.md`, `docs/notes.txt`, `docs/blob.bin` and a Big5
`docs/legacy.asp` with a copy at `docs/legacy.orig`.
