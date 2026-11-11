// Per-browser preferences (localStorage, namespaced, never holds secrets).
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('sshdesk.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('sshdesk.' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: preferences just do not persist */
    }
  },
};
