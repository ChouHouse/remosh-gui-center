// Entry point. Importing an app module registers it; the order here is the
// order of the start menu.
import './shell/desktop.js';
import './shell/context-menu.js';
import './shell/style.js';
import './apps/files/index.js';
import './apps/editor/index.js';
import './apps/notepad/index.js';
import './apps/terminal/index.js';
import './apps/taskman/index.js';
import './apps/settings/index.js';
import './shell/clock.js';
import { initStartMenu } from './shell/start-menu.js';
import { initLogin } from './shell/login.js';
import { ensureGate } from './shell/gate.js';

initStartMenu();
await ensureGate(); // access password first, when the server asks for one
initLogin();
