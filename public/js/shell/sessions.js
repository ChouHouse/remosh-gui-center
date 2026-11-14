// Several signed-in users in one browser tab ("切換使用者").
//
// The first session is this page itself. Every further one is the same page in
// a full-size iframe on top of it, so each has its own connection, windows and
// settings, and all of them stay connected while only one is shown. The page
// at the top keeps the list; iframes reach it through window.parent.
import { on } from '../core/events.js';
import { conn } from '../core/rpc.js';
import { tt } from '../core/i18n.js';

const PARAM = 'session';

function createHost() {
  const sessions = new Map([['main', { id: 'main', label: null, frame: null }]]);
  const listeners = new Map(); // session id -> callback (one per session page)
  let seq = 0;
  let active = 'main';
  const notify = () => {
    for (const [id, fn] of listeners) {
      try {
        fn();
      } catch {
        listeners.delete(id); // that page is gone
      }
    }
  };
  const drop = (s) => {
    listeners.delete(s.id);
    s.frame.remove();
    sessions.delete(s.id);
  };
  // A login screen nobody finished is not worth keeping.
  const prune = (keep) => {
    for (const s of [...sessions.values()]) if (s.frame && !s.label && s.id !== keep) drop(s);
  };
  const show = (id) => {
    active = id;
    for (const s of sessions.values()) if (s.frame) s.frame.hidden = s.id !== id;
    const s = sessions.get(id);
    (s.frame ? s.frame.contentWindow : window).focus();
    notify();
  };
  const host = {
    list: () => [...sessions.values()].map(({ id, label }) => ({ id, label, active: id === active })),
    onChange(id, fn) {
      listeners.set(id, fn);
    },
    setLabel(id, label) {
      const s = sessions.get(id);
      if (!s) return;
      s.label = label;
      notify();
    },
    // Show a login screen for another user (the main page's, if it is free).
    add() {
      if (!sessions.get('main').label) return host.switchTo('main');
      const id = 's' + ++seq;
      const frame = document.createElement('iframe');
      frame.className = 'session-frame';
      frame.title = tt('另一個使用者');
      frame.allow = 'fullscreen; clipboard-read; clipboard-write';
      frame.src = `${location.pathname}?${PARAM}=${id}`;
      document.body.append(frame);
      sessions.set(id, { id, label: null, frame });
      prune(id);
      show(id);
    },
    switchTo(id) {
      if (!sessions.has(id)) return;
      prune(id);
      show(id);
    },
    remove(id) {
      const s = sessions.get(id);
      if (!s?.frame) return;
      drop(s);
      if (active === id) show([...sessions.values()].reverse().find((x) => x.label)?.id || 'main');
      else notify();
    },
  };
  return host;
}

const embedded = window.parent !== window && !!window.parent.__remoshSessions;
export const host = embedded ? window.parent.__remoshSessions : (window.__remoshSessions = createHost());
export const sessionId = embedded ? new URLSearchParams(location.search).get(PARAM) : 'main';
// The other users who are signed in right now.
export const otherSessions = () => host.list().filter((s) => s.id !== sessionId && s.label);
// The host keeps one callback per session page; fan it out to this page's listeners.
const changeListeners = new Set();
host.onChange(sessionId, () => {
  for (const fn of changeListeners) fn();
});
export const onSessionsChange = (fn) => changeListeners.add(fn);

const label = () => `${conn.info.username}@${conn.info.host}${conn.info.port === 22 ? '' : ':' + conn.info.port}`;
on('session:start', () => host.setLabel(sessionId, label()));
on('session:resume', () => host.setLabel(sessionId, label()));
on('session:end', () => (embedded ? host.remove(sessionId) : host.setLabel('main', null)));
