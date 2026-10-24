// Strava OAuth + API-Client. Zugangsdaten (Client-ID/Secret) gibt der Nutzer in den Einstellungen ein –
// sie bleiben im Browser, nichts davon liegt im Repo.
import { Store } from './store.js';

export const SCOPES = 'read,read_all,activity:read_all,profile:read_all,profile:write';
const BASE = 'https://www.strava.com/api/v3';

export class StravaError extends Error {
  constructor(status, body) {
    super(status === 403 ? 'Strava: Zugriff verweigert (403) – Endpoint gesperrt oder Scope fehlt.'
        : status === 429 ? 'Strava: Rate-Limit erreicht (429). 15 Minuten warten.'
        : `Strava HTTP ${status}: ${String(body).slice(0, 200)}`);
    this.status = status;
  }
  get rateLimited() { return this.status === 429; }
  get forbidden() { return this.status === 403; }
}

export const Auth = {
  get cfg() { return Store.get('cfg', {}); },
  get token() { return Store.get('token', null); },
  get isLoggedIn() { return !!this.token; },
  get hasCredentials() { const c = this.cfg; return !!(c.clientId && c.clientSecret); },
  redirectUri() { return location.origin + location.pathname; },

  saveCredentials(clientId, clientSecret) {
    Store.set('cfg', { ...this.cfg, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  },

  login() {
    const c = this.cfg;
    const u = new URL('https://www.strava.com/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: c.clientId, redirect_uri: this.redirectUri(), response_type: 'code',
      approval_prompt: 'auto', scope: SCOPES,
    });
    location.href = u.toString();
  },

  /// Beim Laden: ?code=… aus dem Strava-Redirect gegen ein Token tauschen.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const err = params.get('error');
    if (!code && !err) return false;
    history.replaceState(null, '', location.pathname + location.hash);
    if (err) throw new Error('Strava-Freigabe abgelehnt: ' + err);
    const t = await this.tokenRequest({ code, grant_type: 'authorization_code' });
    Store.set('token', t);
    Store.set('cfg', { ...this.cfg, grantedScopes: params.get('scope') || SCOPES });
    return true;
  },

  async validAccessToken() {
    let t = this.token;
    if (!t) throw new Error('Nicht mit Strava verbunden.');
    if (Date.now() / 1000 > t.expires_at - 60) {
      t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      Store.set('token', t);
    }
    return t.access_token;
  },

  logout() { Store.remove('token'); },

  /// Übernahme-Code: Zugangsdaten + Token als Base64, um eine Anmeldung aus Safari in die
  /// Home-Bildschirm-App zu bringen (die hat auf iOS einen eigenen, getrennten Speicher).
  exportHandover() {
    const c = this.cfg, t = this.token; if (!t) return null;
    return btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, clientId: c.clientId, clientSecret: c.clientSecret, token: t }))));
  },
  importHandover(code) {
    let j; try { j = JSON.parse(decodeURIComponent(escape(atob(code.trim())))); } catch { throw new Error('Übernahme-Code ungültig.'); }
    if (!j.token?.refresh_token || !j.clientId) throw new Error('Übernahme-Code unvollständig.');
    Store.set('cfg', { ...this.cfg, clientId: j.clientId, clientSecret: j.clientSecret, grantedScopes: SCOPES });
    Store.set('token', j.token);
  },

  async tokenRequest(params) {
    const c = this.cfg;
    const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params });
    const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body });
    if (!r.ok) throw new StravaError(r.status, await r.text());
    const j = await r.json();
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at, athlete: j.athlete };
  },
};

async function request(method, path, query = null, form = null) {
  const token = await Auth.validAccessToken();
  const u = new URL(BASE + '/' + path);
  if (query) u.search = new URLSearchParams(query);
  const init = { method, headers: { Authorization: 'Bearer ' + token } };
  if (form) { init.body = new URLSearchParams(form); }
  const r = await fetch(u, init);
  if (!r.ok) throw new StravaError(r.status, await r.text());
  return r.json();
}

export const API = {
  athlete: () => request('GET', 'athlete'),
  routes: (athleteId, page = 1, perPage = 200) => request('GET', `athletes/${athleteId}/routes`, { page, per_page: perPage }),
  route: id => request('GET', `routes/${id}`),
  starredSegments: (page = 1) => request('GET', 'segments/starred', { page, per_page: 200 }),
  segment: id => request('GET', `segments/${id}`),
  segmentStreams: id => request('GET', `segments/${id}/streams`, { keys: 'distance,altitude', key_by_type: 'true' }),
  activityStreams: id => request('GET', `activities/${id}/streams`, { keys: 'watts,time', key_by_type: 'true' }),
  activities: (page, perPage = 30) => request('GET', 'athlete/activities', { page, per_page: perPage }),
  activity: id => request('GET', `activities/${id}`, { include_all_efforts: 'true' }),
  explore: (swLat, swLng, neLat, neLng) => request('GET', 'segments/explore', { bounds: `${swLat},${swLng},${neLat},${neLng}`, activity_type: 'riding' }),
  star: (id, on) => request('PUT', `segments/${id}/starred`, null, { starred: on ? 'true' : 'false' }),
};

/// Sterne lesen/setzen – Basis für den Wahoo-Sync. 300 ms Pause je PUT.
export const StarService = {
  async loadAllStarred() {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const b = await API.starredSegments(page);
      if (!b.length) break;
      out.push(...b);
      if (b.length < 200) break;
    }
    const seen = new Set();
    return out.filter(s => !seen.has(s.id) && seen.add(s.id));
  },
  async setStarred(id, on) {
    await API.star(id, on);
    await new Promise(r => setTimeout(r, 300));
  },
};
