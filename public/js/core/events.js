// Minimal publish/subscribe bus so modules do not import each other in circles.
//
// Events used by the app:
//   session:start   first successful login; the desktop appears
//   session:resume  logged in again after the connection dropped (windows kept)
//   session:end     the user logged out
//   conn:lost       the connection dropped unexpectedly
//   fs:changed      (dir) a file was created or replaced in that remote folder
const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => handlers.get(name).delete(fn);
}

export function emit(name, ...args) {
  for (const fn of [...(handlers.get(name) || [])]) {
    try {
      fn(...args);
    } catch (err) {
      console.error(`handler for "${name}" failed`, err);
    }
  }
}
