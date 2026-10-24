// Zustand der App: Daten, Lader, Lage zur Route, Filter/Sortierung, Wind, Routenplanung – Port von AppState.swift.
import { Store } from './store.js';
import { Auth, API, StravaError } from './strava.js';
import { Config, Geo, Seg, Fmt, RiderProfile, PowerModel, decodePolyline } from './model.js';
import { windAt } from './wind.js';
import { brouterRoute, Planner, gpx } from './routing.js';
import { LiveSegmentSync } from './sync.js';

export const SORTS = [
  ['routeOrder', 'Reihenfolge auf der Route', 'Route'], ['chance', 'Chance', 'Chance'], ['gapKom', 'Rückstand KOM', 'KOM'],
  ['length', 'Länge', 'Länge'], ['grade', 'Steigung', 'Steigung'], ['popularity', 'Beliebtheit', 'Beliebt'], ['distanceFromMe', 'Entfernung', 'Nähe'],
];
export const RETURN_MODES = [['none', 'Endet am letzten Segment'], ['roundTrip', 'Rundkurs (ein Track zurück zum Start)'], ['separate', 'Rückweg separat (andere Straßen, eigene GPX)']];
export const RADIUS_OPTIONS = [5, 10, 20, 30, 50, 100, 0];
export const MAP_STYLES = [['topo', 'Topo (Relief + Höhenlinien)'], ['standard', 'Standard'], ['satellite', 'Satellit']];

const DEFAULTS = { radiusKm: 20, top10Percent: 6, pessimismPct: Config.defaultPessimismPct, riderKg: 0, bikeKg: Config.defaultBikeKg, avgSpeedKmh: 0,
  returnMode: 'roundTrip', brouterProfile: 'fastbike', mapMode: 'planned', mapStyle: 'topo', activitiesPage: 1, athleteId: 0, exploreAvailable: null };

function nextFullHour() { const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0); return d; }

export class AppState {
  constructor() {
    this.segments = Store.get('segments', {});
    this.routes = Store.get('routes', {});
    this.activities = Store.get('activities', {});
    this.powerCurve = Store.get('curve', []);
    this.settings = { ...DEFAULTS, ...Store.get('settings', {}) };
    this.selected = new Set(Store.get('selected', []));
    this.filter = 'onRoute'; this.sort = 'routeOrder'; this.showAll = false;
    const ctx = Store.get('ctx', {}); this.selectedTour = ctx.tour ?? null; this.routeFilter = ctx.route ?? null;
    this.rideDate = nextFullHour();
    this.wind = {}; this.windCache = {};
    this.location = null;
    this.busy = null; this.info = null; this.error = null;
    this.route = null; this.gpxText = null; this.returnGpxText = null;
    this.placementCache = {}; this.trackCache = {}; this.profileCache = null;
    this.sync = new LiveSegmentSync();
    this.sync.onStarChanged = (id, on) => { if (this.segments[id]) { this.segments[id].starred = on; this.persist(); } this.emit(); };
    this.sync.onProgress = () => this.emit();
    this.listeners = [];
  }
  on(fn) { this.listeners.push(fn); }
  emit() { Store.set('ctx', { tour: this.selectedTour, route: this.routeFilter }); for (const l of this.listeners) l(); }
  persist() { Store.set('segments', this.segments); Store.set('routes', this.routes); Store.set('activities', this.activities); Store.set('selected', [...this.selected]); this.profileCache = null; }
  setSetting(k, v) { this.settings[k] = v; Store.set('settings', this.settings); this.profileCache = null; this.emit(); }
  setRideDate(d) { this.rideDate = d; this.wind = {}; this.profileCache = null; this.emit(); this.loadWind([...this.selected]); }

  // ---------- Profil / Chance ----------
  get effectiveRiderKg() { return this.settings.riderKg > 30 ? this.settings.riderKg : Config.defaultRiderKg; }
  get profile() {
    if (this.profileCache) return this.profileCache;
    this.profileCache = new RiderProfile(Object.values(this.segments), { riderKg: this.effectiveRiderKg, bikeKg: this.settings.bikeKg, top10Percent: this.settings.top10Percent, curve: this.powerCurve, pessimismPct: this.settings.pessimismPct });
    return this.profileCache;
  }
  headwind(s) { const w = this.wind[s.id]; return w ? Seg.headwind(s, w) : null; }
  feasibility(s) { return this.profile.feasibility(s, this.headwind(s)); }
  bestAchievable(s, f) {
    const c = []; const b = Seg.bestSeconds(s); if (b != null) c.push([b, false]);
    if (f.kind === 'power' && f.estimatedSeconds != null) c.push([f.estimatedSeconds, true]);
    if (!c.length) return null; c.sort((x, y) => x[0] - y[0]); return { seconds: c[0][0], modelled: c[0][1] };
  }
  komDeficit(s, f) { const k = s.komSeconds; const b = this.bestAchievable(s, f); if (!k || !b) return null; return { seconds: b.seconds - k, percent: (b.seconds - k) / k * 100, modelled: b.modelled }; }
  top10Deficit(s, f) { const t = Seg.top10Seconds(s, this.settings.top10Percent); const b = this.bestAchievable(s, f); if (!t || !b) return null; return { seconds: b.seconds - t, percent: (b.seconds - t) / t * 100, modelled: b.modelled }; }

  // ---------- Kontext (Tour oder Route) ----------
  get context() { if (this.selectedTour != null) return { kind: 'tour', id: this.selectedTour }; if (this.routeFilter != null) return { kind: 'route', id: this.routeFilter }; return null; }
  get contextKey() { const c = this.context; return c ? (c.kind === 'tour' ? 't' : 'r') + c.id : null; }
  get contextName() { const c = this.context; return c ? (c.kind === 'tour' ? this.activities[c.id]?.name : this.routes[c.id]?.name) : null; }
  get contextPolyline() { const c = this.context; return c ? (c.kind === 'tour' ? this.activities[c.id]?.polyline : this.routes[c.id]?.polyline) : null; }
  get contextSegmentIds() { const c = this.context; return c ? ((c.kind === 'tour' ? this.activities[c.id]?.segmentIds : this.routes[c.id]?.segmentIds) || []) : []; }
  contextTrack() {
    const key = this.contextKey; if (!key) return { coords: [], cum: [] };
    if (this.trackCache[key]) return this.trackCache[key];
    const coords = decodePolyline(this.contextPolyline) || [];
    const t = { coords, cum: coords.length >= 2 ? Geo.cumulative(coords) : [] };
    this.trackCache[key] = t; return t;
  }
  get routeLengthM() { const c = this.contextTrack().cum; return c.length ? c[c.length - 1] : 0; }
  get routeIsLoop() { const c = this.contextTrack().coords; return c.length > 2 && Geo.distanceM(c[0], c[c.length - 1]) < 500; }
  get userRoutePosM() {
    if (!this.location) return null; const t = this.contextTrack(); if (t.coords.length < 2) return null;
    const [i, d] = Geo.nearestIndex(this.location, t.coords); return d <= 2000 ? t.cum[i] : null;
  }
  kmFromHere(id) {
    const p = this.placements()[id], u = this.userRoutePosM; if (!p || u == null) return null;
    let d = p.posM - u; if (d < 0 && this.routeIsLoop) d += this.routeLengthM; return d;
  }
  placements() {
    const key = this.contextKey; if (!key) return {};
    const n = Object.keys(this.segments).length;
    const c = this.placementCache[key]; if (c && c.count === n) return c.map;
    const { coords, cum } = this.contextTrack(); if (coords.length < 2) return {};
    const listed = new Set(this.contextSegmentIds), corridor = Config.routeCorridorM, isTour = this.context.kind === 'tour';
    const map = {};
    for (const s of Object.values(this.segments)) {
      const [si, sd] = Geo.nearestIndex(s.start, coords), [, ed] = Geo.nearestIndex(s.end, coords);
      const isListed = listed.has(s.id);
      if (!isListed && Math.min(sd, ed) > corridor) continue;
      const bothNear = sd <= corridor && ed <= corridor;
      if (isTour && isListed) map[s.id] = { kind: 'onRoute', posM: cum[si], distanceM: Math.max(sd, ed), listed: true };
      else if (isListed || bothNear) {
        const t = Geo.traversal(Seg.coords(s), coords, cum, corridor);
        if (t.kind === 'forward') map[s.id] = { kind: 'onRoute', posM: t.posM, distanceM: Math.max(sd, ed), listed: isListed };
        else if (t.kind === 'backward') map[s.id] = { kind: 'opposite', posM: t.posM, distanceM: Math.max(sd, ed), listed: isListed };
        else map[s.id] = { kind: 'adjacent', posM: cum[si], distanceM: Math.min(sd, ed), listed: isListed };
      } else map[s.id] = { kind: 'adjacent', posM: cum[si], distanceM: Math.min(sd, ed), listed: false };
    }
    this.placementCache[key] = { count: n, map }; return map;
  }
  get contextSegments() {
    const pl = this.placements();
    return Object.keys(pl).filter(id => pl[id].kind === 'onRoute').map(id => this.segments[id]).filter(Boolean).sort((a, b) => (pl[a.id].posM - pl[b.id].posM) || a.name.localeCompare(b.name));
  }
  get routeNumbers() { const m = {}; this.contextSegments.forEach((s, i) => m[s.id] = i + 1); return m; }
  get placementCounts() { const v = Object.values(this.placements()); return { onRoute: v.filter(p => p.kind === 'onRoute').length, opposite: v.filter(p => p.kind === 'opposite').length, adjacent: v.filter(p => p.kind === 'adjacent').length }; }
  get contextMissingRecords() { return this.contextSegments.filter(s => !Seg.hasRecords(s)).length; }
  routeRelation(id) { const p = this.placements()[id]; if (!p) return null; return p.kind === 'onRoute' ? null : p.kind === 'opposite' ? 'Gegenrichtung' : `Abzweig ${Fmt.kmShort(p.distanceM)}`; }
  clearContext() { this.selectedTour = null; this.routeFilter = null; this.wind = {}; this.emit(); }
  selectRoute(id) { this.selectedTour = null; this.setSetting('mapMode', 'planned'); this.wind = {}; if (this.routes[id]?.loaded) { this.routeFilter = this.routeFilter === id ? null : id; this.emit(); } else this.loadRoute(id); }
  selectTour(id) { if (id == null) { this.selectedTour = null; this.emit(); return; } this.routeFilter = null; this.setSetting('mapMode', 'ridden'); this.wind = {}; if (this.activities[id]?.segmentIds) { this.selectedTour = id; this.emit(); } else this.loadTour(id); }

  // ---------- Liste ----------
  get scored() { return Object.values(this.segments).map(s => [s, this.feasibility(s)]); }
  get filtered() {
    const ctx = this.context; if (!ctx && !this.showAll) return [];
    const pl = ctx ? this.placements() : {}; const loc = this.location, r = this.settings.radiusKm;
    const list = this.scored.filter(([s]) => {
      if (ctx) { const p = pl[s.id]; if (!p) return false; return this.filter === 'onRoute' ? p.kind === 'onRoute' : p.kind !== 'onRoute'; }
      if (r > 0 && loc && Geo.distanceM(loc, s.start) > r * 1000) return false; return true;
    });
    const chanceKey = f => f.hasChance ? 1 - f.score : 2;
    const key = (s, f) => {
      switch (this.sort) {
        case 'routeOrder': { const k = this.kmFromHere(s.id); return k != null ? (k < 0 ? k + 1e6 : k) : (pl[s.id]?.posM ?? chanceKey(f)); }
        case 'chance': return chanceKey(f);
        case 'gapKom': return this.komDeficit(s, f)?.percent ?? Infinity;
        case 'length': return -s.distance;
        case 'grade': return -s.avgGrade;
        case 'popularity': return -(s.athleteCount ?? s.starCount ?? -1);
        case 'distanceFromMe': return loc ? Geo.distanceM(loc, s.start) : Infinity;
      }
      return 0;
    };
    return list.sort((a, b) => (key(a[0], a[1]) - key(b[0], b[1])) || a[0].name.localeCompare(b[0].name));
  }
  sortValue(s, f) {
    switch (this.sort) {
      case 'routeOrder': { const d = this.kmFromHere(s.id); if (d != null) return d < 0 ? `${(-d / 1000).toFixed(1)} km zurück` : `in ${(d / 1000).toFixed(1)} km`; const p = this.placements()[s.id]; return p ? `km ${(p.posM / 1000).toFixed(1)}` : null; }
      case 'chance': return f.hasChance ? `${Math.round(f.score * 100)} %` : 'KOM ?';
      case 'gapKom': { const d = this.komDeficit(s, f); return d ? (d.modelled ? '~' : '') + Fmt.gapPercent(d.percent) : 'KOM ?'; }
      case 'length': return Fmt.km(s.distance);
      case 'grade': return Fmt.grade(s.avgGrade);
      case 'popularity': return s.athleteCount != null ? `${s.athleteCount} Fahrer` : s.starCount != null ? `${s.starCount} ★` : '–';
      case 'distanceFromMe': return this.location ? '↔ ' + Fmt.kmShort(Geo.distanceM(this.location, s.start)) : '–';
    }
    return null;
  }
  get selectedSegments() { return [...this.selected].map(id => this.segments[id]).filter(Boolean); }
  toggle(id) { if (this.selected.has(id)) this.selected.delete(id); else { this.selected.add(id); if (!this.wind[id]) this.loadWind([id]); } Store.set('selected', [...this.selected]); this.emit(); }

  // ---------- Hilfen ----------
  async run(label, body) {
    this.busy = label; this.error = null; this.emit();
    try { await body(); this.persist(); }
    catch (e) { this.error = e.message; this.info = `Fehler bei „${label.replace('…', '')}“: ${e.message}`; console.error(e); }
    finally { this.busy = null; this.emit(); }
  }
  setBusy(l) { this.busy = l; this.emit(); }
  requestLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => { this.location = [p.coords.latitude, p.coords.longitude]; this.emit(); }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  }
  async ensureAthlete() {
    if (this.settings.athleteId && this.settings.riderKg > 30) return;
    const a = await API.athlete();
    this.settings.athleteId = a.id; if (a.weight > 30 && !(this.settings.riderKg > 30)) this.settings.riderKg = a.weight;
    Store.set('settings', this.settings);
  }
  mergeSummary(s, source, starred, effort = null) {
    const st = s.start_latlng, en = s.end_latlng; if (!st || !en || st.length !== 2 || en.length !== 2) return;
    let c = this.segments[s.id];
    if (!c) c = this.segments[s.id] = { id: s.id, name: s.name, distance: s.distance, avgGrade: s.average_grade, maxGrade: s.maximum_grade ?? null,
      elevGain: Seg.gain(s.distance, s.average_grade, s.elevation_high, s.elevation_low, null), start: st, end: en, polyline: null,
      climbCategory: s.climb_category || 0, starred: !!starred, sources: [], efforts: [], prSeconds: null, city: s.city || null };
    if (!c.sources.includes(source)) c.sources.push(source);
    c.starred = c.starred || !!starred;
    if (s.pr_time > 0) c.prSeconds = s.pr_time;
    if (s.athlete_pr_effort?.pr_elapsed_time > 0) c.prSeconds = s.athlete_pr_effort.pr_elapsed_time;
    if (effort && !c.efforts.some(e => e.elapsed === effort.elapsed && e.date === effort.date)) c.efforts.push(effort);
  }

  // ---------- Quellen ----------
  async loadStarred() {
    await this.run('Gestarrte Segmente…', async () => {
      let page = 1, total = 0;
      for (;;) { const b = await API.starredSegments(page); if (!b.length) break; for (const s of b) this.mergeSummary(s, 'starred', true); total += b.length; if (b.length < 200) break; page++; }
      this.info = `${total} gestarrte Segmente geladen`;
    });
  }
  async ingestTour(a) {
    const d = await API.activity(a.id); const ids = [];
    for (const e of d.segment_efforts || []) {
      if (!e.segment) continue;
      this.mergeSummary(e.segment, 'activities', e.segment.starred, { elapsed: e.elapsed_time, date: Fmt.parseDate(e.start_date), watts: e.average_watts ?? null, komRank: e.kom_rank ?? null, deviceWatts: !!e.device_watts });
      if (this.segments[e.segment.id]) ids.push(e.segment.id);
    }
    const t = this.activities[a.id] || { id: a.id, name: a.name, date: Fmt.parseDate(a.start_date), distance: a.distance, elevationGain: a.total_elevation_gain || 0, polyline: null };
    t.name = a.name; t.distance = a.distance; t.polyline = a.map?.summary_polyline || t.polyline; t.segmentIds = ids;
    this.activities[a.id] = t; delete this.placementCache['t' + a.id]; delete this.trackCache['t' + a.id];
    return ids;
  }
  async loadActivities(perPage = 30) {
    await this.run(`Fahrten (Seite ${this.settings.activitiesPage})…`, async () => {
      const list = await API.activities(this.settings.activitiesPage, perPage);
      const rides = list.filter(a => /ride/i.test(a.sport_type || ''));
      let effortCount = 0; try { await this.ensureAthlete(); } catch {}
      for (const a of rides) { this.setBusy(`Fahrt „${a.name}“…`); effortCount += (await this.ingestTour(a)).length; }
      this.settings.activitiesPage++; Store.set('settings', this.settings);
      this.info = `${rides.length} Fahrten, ${effortCount} Efforts (${Object.keys(this.segments).length} Segmente gesamt)`;
    });
  }
  async loadActivityMap(maxPages = 5) {
    await this.run('Fahrten für die Karte…', async () => {
      let seen = 0;
      for (let page = 1; page <= maxPages; page++) {
        this.setBusy(`Fahrten für die Karte… Seite ${page}`);
        const list = await API.activities(page, 200); if (!list.length) break;
        for (const a of list) {
          if (!/ride/i.test(a.sport_type || '') || !a.map?.summary_polyline) continue;
          const t = this.activities[a.id] || { id: a.id, segmentIds: null };
          Object.assign(t, { name: a.name, date: Fmt.parseDate(a.start_date), distance: a.distance, elevationGain: a.total_elevation_gain || 0, polyline: a.map.summary_polyline });
          this.activities[a.id] = t; seen++;
        }
        if (list.length < 200) break;
      }
      this.info = `${seen} Fahrten mit Track auf der Karte. Tour antippen → Segmente laden (1 Call).`;
    });
  }
  async loadTour(id) {
    const t = this.activities[id]; if (!t) return;
    await this.run(`Tour „${t.name}“…`, async () => { const ids = await this.ingestTour({ id: t.id, name: t.name, start_date: t.date, distance: t.distance, total_elevation_gain: t.elevationGain, map: null }); this.selectedTour = id; this.info = `„${t.name}“: ${ids.length} Segmente.`; });
  }
  applyRouteSegments(segs, routeId) {
    const ids = []; let unridden = 0;
    for (const s of segs) { this.mergeSummary(s, 'routes', s.starred); if (this.segments[s.id]) { ids.push(s.id); if (!Seg.ridden(this.segments[s.id])) unridden++; } }
    const r = this.routes[routeId]; r.segmentIds = ids; r.loaded = Date.now();
    delete this.placementCache['r' + routeId]; delete this.trackCache['r' + routeId];
    return { count: ids.length, unridden };
  }
  async loadRouteList() {
    await this.run('Routenliste…', async () => {
      await this.ensureAthlete();
      const all = [];
      for (let page = 1; page <= 10; page++) { this.setBusy(`Routenliste… Seite ${page}`); const b = await API.routes(this.settings.athleteId, page, 200); if (!b.length) break; all.push(...b); }
      const before = new Set(Object.keys(this.routes).map(Number));
      for (const r of all) {
        const poly = r.map?.polyline || r.map?.summary_polyline || null;
        const ex = this.routes[r.id];
        if (ex) { ex.name = r.name; ex.distance = r.distance; ex.elevationGain = r.elevation_gain ?? ex.elevationGain; if (poly && poly !== ex.polyline) { ex.polyline = poly; ex.segmentIds = []; ex.loaded = null; delete this.placementCache['r' + r.id]; delete this.trackCache['r' + r.id]; } }
        else this.routes[r.id] = { id: r.id, name: r.name, distance: r.distance, elevationGain: r.elevation_gain || 0, polyline: poly, segmentIds: [], loaded: null };
        if (r.segments?.length && !this.routes[r.id].loaded) this.applyRouteSegments(r.segments, r.id);
      }
      const live = new Set(all.map(r => r.id));
      const removed = [...before].filter(id => !live.has(id)).length, added = [...live].filter(id => !before.has(id)).length;
      for (const id of Object.keys(this.routes)) if (!live.has(Number(id))) delete this.routes[id];
      this.placementCache = {}; this.trackCache = {};
      if (this.routeFilter != null && !this.routes[this.routeFilter]) this.routeFilter = null;
      if (!all.length) { this.info = 'Keine eigenen Routen bei Strava. Gespeicherte Routen anderer Athleten liefert die API nicht.'; return; }
      this.info = `${all.length} eigene Routen · ${added} neu · ${removed} entfernt · ${Object.values(this.routes).filter(r => r.loaded).length} mit Segmenten.`;
    });
  }
  async loadRoute(id) {
    const r = this.routes[id]; if (!r) return;
    await this.run(`Route „${r.name}“…`, async () => {
      const d = await API.route(id); const res = this.applyRouteSegments(d.segments || [], id);
      if (!r.polyline) r.polyline = d.map?.polyline || d.map?.summary_polyline || null;
      this.selectedTour = null; this.routeFilter = id; this.info = `„${r.name}“: ${res.count} Segmente, ${res.unridden} davon ungefahren.`;
    });
  }
  async tryExplore() {
    if (this.settings.exploreAvailable === false) { this.info = 'Explore ist für diese API-App gesperrt (Extended Access Tier).'; this.emit(); return; }
    if (!this.location) { this.error = 'Kein Standort verfügbar.'; this.emit(); return; }
    await this.run('Explore…', async () => {
      const d = this.settings.radiusKm > 0 ? this.settings.radiusKm / 111 : Config.exploreHalfSpan, [lat, lng] = this.location;
      try {
        const r = await API.explore(lat - d, lng - d, lat + d, lng + d);
        for (const e of r.segments || []) {
          let c = this.segments[e.id];
          if (!c) c = this.segments[e.id] = { id: e.id, name: e.name, distance: e.distance, avgGrade: e.avg_grade, maxGrade: null, elevGain: Math.max(0, e.elev_difference), start: e.start_latlng, end: e.end_latlng, polyline: e.points, climbCategory: e.climb_category || 0, starred: !!e.starred, sources: [], efforts: [], prSeconds: null };
          if (!c.sources.includes('explore')) c.sources.push('explore'); if (!c.polyline) c.polyline = e.points;
        }
        this.settings.exploreAvailable = true; this.info = `Explore: ${(r.segments || []).length} Segmente`;
      } catch (e) {
        if (e instanceof StravaError && e.status >= 400 && e.status < 500 && e.status !== 429) { this.settings.exploreAvailable = false; this.info = `Explore gesperrt (HTTP ${e.status}, Extended Access nötig).`; } else throw e;
      }
      Store.set('settings', this.settings);
    });
  }

  // ---------- Rekorde / Profil / Streams ----------
  async refreshDetails(ids) {
    for (const id of ids) {
      const d = await API.segment(id); const s = this.segments[id]; if (!s) continue;
      s.polyline = d.map?.polyline || s.polyline;
      s.elevGain = Seg.gain(d.distance, d.average_grade, d.elevation_high, d.elevation_low, d.total_elevation_gain);
      s.maxGrade = d.maximum_grade ?? s.maxGrade; s.starred = d.starred ?? s.starred;
      const pr = d.athlete_segment_stats?.pr_elapsed_time ?? d.athlete_pr_effort?.pr_elapsed_time; if (pr > 0) s.prSeconds = pr;
      s.prDate = Fmt.parseDate(d.athlete_segment_stats?.pr_date ?? d.athlete_pr_effort?.pr_date) ?? s.prDate ?? null;
      s.effortCount = d.athlete_segment_stats?.effort_count ?? d.athlete_pr_effort?.effort_count ?? s.effortCount ?? null;
      s.athleteCount = d.athlete_count ?? s.athleteCount ?? null; s.starCount = d.star_count ?? s.starCount ?? null;
      const kom = Fmt.parseClock(d.xoms?.kom) ?? Fmt.parseClock(d.xoms?.overall); if (kom != null) s.komSeconds = kom;
      s.komText = d.xoms?.kom ?? d.xoms?.overall ?? s.komText ?? null; s.recordsUpdated = Date.now();
    }
    this.profileCache = null;
  }
  get recordsPending() {
    const base = this.filtered.map(x => x[0]);
    return base.filter(s => Seg.recordsStale(s)).sort((a, b) => ((this.selected.has(a.id) ? 0 : 1) - (this.selected.has(b.id) ? 0 : 1)) || ((Seg.ridden(a) ? 0 : 1) - (Seg.ridden(b) ? 0 : 1)) || a.name.localeCompare(b.name)).map(s => s.id);
  }
  async loadRecords(limit = 40) {
    const pending = this.recordsPending;
    if (!pending.length) { this.info = 'Rekorde in dieser Ansicht sind aktuell (jünger als 7 Tage).'; this.emit(); return; }
    const batch = pending.slice(0, limit); let done = 0;
    await this.run(`Rekorde 1/${batch.length}…`, async () => {
      try { for (const id of batch) { this.setBusy(`Rekorde ${done + 1}/${batch.length}…`); await this.refreshDetails([id]); done++; } }
      catch (e) { if (e instanceof StravaError && e.rateLimited) { this.info = `Rate-Limit nach ${done} Segmenten – in 15 Minuten weiter.`; return; } throw e; }
      const rest = pending.length - done, withKom = batch.filter(id => Seg.hasRecords(this.segments[id])).length;
      this.info = rest > 0 ? `Rekorde für ${done} Segmente geladen (${withKom} mit KOM), ${rest} offen – erneut tippen.` : `Rekorde für ${done} Segmente geladen (${withKom} mit KOM).`;
      if (withKom > 0) this.sort = 'chance';
    });
  }
  async refreshRecords(id) { await this.run('Rekorde…', () => this.refreshDetails([id])); }
  async loadProfile(id) {
    const s = this.segments[id]; if (!s || s.profile) return;
    try {
      const st = await API.segmentStreams(id); const dd = st.distance?.data, ee = st.altitude?.data; if (!dd || !ee || dd.length !== ee.length) return;
      const pairs = dd.map((d, i) => d != null && ee[i] != null ? { d, e: ee[i] } : null).filter(Boolean); if (pairs.length < 2) return;
      const step = Math.max(1, Math.floor(pairs.length / 200)); const pts = []; for (let i = 0; i < pairs.length; i += step) pts.push(pairs[i]);
      if (pts[pts.length - 1] !== pairs[pairs.length - 1]) pts.push(pairs[pairs.length - 1]);
      s.profile = pts; this.persist(); this.emit();
    } catch (e) { this.error = e.message; this.emit(); }
  }
  async loadPowerCurve() {
    await this.run('Leistungskurve…', async () => {
      let rides = [], page = 1;
      while (rides.length < Config.powerCurveRides && page <= 4) { const list = await API.activities(page, 30); if (!list.length) break; rides.push(...list.filter(a => /ride/i.test(a.sport_type || '') && a.device_watts)); page++; }
      rides = rides.slice(0, Config.powerCurveRides);
      if (!rides.length) { this.info = 'Keine Fahrten mit Powermeter-Daten in den letzten Aktivitäten.'; return; }
      const best = Object.fromEntries(this.powerCurve.map(p => [p.seconds, p])); let done = 0;
      for (const r of rides) {
        this.setBusy(`Leistungskurve ${done + 1}/${rides.length}…`);
        const st = await API.activityStreams(r.id);
        if (st.watts?.data && st.time?.data) for (const { seconds, watts } of PowerModel.meanMax(st.watts.data, st.time.data)) if (watts > (best[seconds]?.watts ?? 0)) best[seconds] = { seconds, watts, date: Fmt.parseDate(r.start_date), source: r.name };
        done++;
      }
      this.powerCurve = Object.values(best).sort((a, b) => a.seconds - b.seconds); Store.set('curve', this.powerCurve); this.profileCache = null;
      this.info = `Leistungskurve aus ${done} Fahrten aktualisiert (Bestwerte bleiben erhalten).`;
    });
  }
  resetPowerCurve() { this.powerCurve = []; Store.set('curve', []); this.profileCache = null; this.emit(); }

  // ---------- Wind / ETA ----------
  get effectiveAvgSpeed() { return this.settings.avgSpeedKmh > 0 ? this.settings.avgSpeedKmh : Math.min(32, Math.max(18, this.profile.speedKmh(1))); }
  etaAt(s) {
    const p = this.context ? this.placements()[s.id] : null; if (!p) return this.rideDate;
    const k = this.kmFromHere(s.id); const dist = k != null && k >= 0 ? k : p.posM;
    return new Date(this.rideDate.getTime() + dist / (this.effectiveAvgSpeed / 3.6) * 1000);
  }
  async loadWind(ids) {
    for (const id of ids) {
      const s = this.segments[id]; if (!s) continue;
      const c = Seg.mid(s), eta = this.etaAt(s), hour = Math.floor(eta.getTime() / 3600e3);
      const key = `${c[0].toFixed(2)},${c[1].toFixed(2)},${hour}`;
      if (this.windCache[key]) { this.wind[id] = this.windCache[key]; continue; }
      try { const w = await windAt(c[0], c[1], eta); if (w) { this.windCache[key] = w; this.wind[id] = w; } }
      catch (e) { this.error = e.message; this.emit(); return; }
    }
    this.profileCache = null; this.emit();
  }

  // ---------- Route ----------
  async planRoute() {
    const segs = this.selectedSegments; if (!segs.length) { this.error = 'Keine Segmente ausgewählt.'; this.emit(); return; }
    await this.run('Route…', async () => {
      const missing = segs.filter(s => !s.polyline).map(s => s.id); if (missing.length) await this.refreshDetails(missing);
      const fresh = this.selectedSegments, start = this.location || fresh[0].start, mode = this.settings.returnMode, profile = this.settings.brouterProfile;
      const ordered = Planner.order(fresh, start), wps = Planner.waypoints(start, ordered, mode === 'roundTrip');
      const r = await brouterRoute(wps, profile);
      const planned = { segments: ordered, track: r.track, lengthM: r.lengthM, ascendM: r.ascendM, returnTrack: null, returnLengthM: 0, returnAscendM: 0, returnAvoidsSegments: false };
      if (mode === 'separate' && ordered.length) {
        this.setBusy('Rückweg…');
        const last = ordered[ordered.length - 1], from = Seg.coords(last).slice(-1)[0];
        let back, avoided = true;
        try { back = await brouterRoute([from, start], profile, Planner.nogos(ordered, [from, start])); } catch { avoided = false; back = await brouterRoute([from, start], profile); }
        Object.assign(planned, { returnTrack: back.track, returnLengthM: back.lengthM, returnAscendM: back.ascendM, returnAvoidsSegments: avoided });
      }
      this.route = planned; this.gpxText = null; this.returnGpxText = null;
      this.info = planned.returnTrack ? `Hinweg ${Fmt.km(r.lengthM)} · Rückweg ${Fmt.km(planned.returnLengthM)}${planned.returnAvoidsSegments ? '' : ' (keine Alternativstraßen)'} · gesamt ${Fmt.km(r.lengthM + planned.returnLengthM)}` : `Route: ${Fmt.km(r.lengthM)}, ${Fmt.hm(r.ascendM)}`;
    });
  }
  buildGpx() {
    const r = this.route; if (!r) return null;
    const stamp = new Date().toISOString().slice(0, 10), name = `Segmente ${stamp}`;
    if (r.returnTrack) return [[`SegmentRouter-${stamp}-Hinweg.gpx`, gpx(r.track, r.segments, `${name} – Hinweg`)], [`SegmentRouter-${stamp}-Rueckweg.gpx`, gpx(r.returnTrack, [], `${name} – Rückweg`)]];
    return [[`SegmentRouter-${stamp}.gpx`, gpx(r.track, r.segments, name)]];
  }
  async setStar(id, on) { await this.run(on ? 'Starre…' : 'Stern entfernen…', async () => { await API.star(id, on); if (this.segments[id]) this.segments[id].starred = on; this.info = on ? 'Gestarrt – erscheint nach dem nächsten Sync als Live Segment.' : 'Stern entfernt.'; }); }
  clearCache() { this.segments = {}; this.routes = {}; this.activities = {}; this.selected = new Set(); this.route = null; this.selectedTour = null; this.routeFilter = null; this.wind = {}; this.placementCache = {}; this.trackCache = {}; this.settings.activitiesPage = 1; Store.set('settings', this.settings); this.persist(); this.emit(); }
  logout() { Auth.logout(); this.emit(); }
}
