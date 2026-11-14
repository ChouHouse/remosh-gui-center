// Entry point. The apps are not listed here: the server says which folders
// are in js/apps (see /api/apps) and each one is loaded and registers itself.
// An app's `order` (shell/apps.js) decides its place in the start menu.
import './shell/language.js'; // first: everything after it is shown in the chosen language
import './shell/sessions.js';
import './shell/desktop.js';
import './shell/context-menu.js';
import './shell/style.js';
import './shell/clock.js';
import './shell/taskbar.js';
import './shell/dock.js';
import './shell/workspaces.js';
import './shell/preview.js';
import './shell/navigation.js';
import './shell/desktop-icons.js';
import './shell/fullscreen.js';
import { initStartMenu } from './shell/start-menu.js';
import { initLogin } from './shell/login.js';
import { ensureGate } from './shell/gate.js';

const appIds = await fetch('/api/apps').then((r) => (r.ok ? r.json() : []), () => []);
await Promise.all(appIds.map((id) => import(`./apps/${id}/index.js`).catch((err) => console.error(`App "${id}" did not load:`, err))));

initStartMenu();
await ensureGate(); // access password first, when the server asks for one
initLogin();
