// Persistenz: localStorage, ein Schlüssel je Datenart. Alles bleibt im Browser.
const P = 'sr.';
export const Store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(P + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(P + key, JSON.stringify(value)); } catch (e) { console.warn('store', key, e); }
  },
  remove(key) { try { localStorage.removeItem(P + key); } catch {} },
  clearData() { ['segments', 'routes', 'activities', 'curve', 'livesync'].forEach(k => this.remove(k)); },
};
