// Oberfläche: Tabs (Touren, Segmente, Route, Profil), Segment-Detail, Wahoo-Sync – Leaflet-Karten, dunkles Design.
import { Auth, StravaError } from './strava.js';
import { AppState, SORTS, RETURN_MODES, RADIUS_OPTIONS, MAP_STYLES } from './state.js';
import { Config, Geo, Seg, Fmt, BIN_LABELS, DURATIONS } from './model.js';
import { shareGpx } from './routing.js';

const S = new AppState();
window.S = S;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACCENT = '#fc4c02', PLANNED = '#73b8ff', LINE = '#3d3d3d', MUTED = '#858585';

// ---------- Leaflet-Hilfen ----------
const TILES = {
  topo: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM · © OpenTopoMap (CC-BY-SA)' }],
  standard: ['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }],
  satellite: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: '© Esri' }],
};
const maps = {}; window.maps = maps;
function mapFor(id) {
  if (maps[id]) { applyTiles(maps[id]); return maps[id]; }
  const m = L.map(id, { zoomControl: false, attributionControl: true, zoomAnimation: id !== 'map-detail' });
  L.control.zoom({ position: 'bottomright' }).addTo(m);
  m.layers = L.layerGroup().addTo(m);
  m.setView([48.1, 11.5], 10);
  maps[id] = m; applyTiles(m); return m;
}
function applyTiles(m) {
  const style = S.settings.mapStyle;
  if (m.tileStyle === style) return;
  if (m.tiles) m.removeLayer(m.tiles);
  const [url, opts] = TILES[style] || TILES.topo;
  m.tiles = L.tileLayer(url, opts).addTo(m); m.tileStyle = style;
}
function userMarker(m) { if (S.location) L.circleMarker(S.location, { radius: 6, color: '#fff', weight: 2, fillColor: '#2f7cf6', fillOpacity: 1 }).addTo(m.layers); }
function fitTo(m, pts, pad = 0.15) { const b = Geo.bounds(pts); if (b) m.fitBounds(b, { padding: [24, 24], maxZoom: 15 }); }
function arrowIcon(bearingDeg, color = '#fff', size = 10) { return L.divIcon({ className: 'dir', html: `<div style="width:${size}px;height:${size}px;transform:rotate(${bearingDeg}deg)"><svg viewBox="0 0 10 10" width="${size}" height="${size}"><path d="M5 0 L10 10 L5 7.5 L0 10 Z" fill="${color}"/></svg></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }); }
function numIcon(n, color, fg = '#121212', ring = '#121212') { return L.divIcon({ className: 'num', html: `<div style="background:${color};color:${fg};border:1.5px solid ${ring}">${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }); }
function directionArrows(m, pts, count, color, size) { for (const d of Geo.directionMarkers(pts, count)) L.marker(d.coord, { icon: arrowIcon(d.bearingDeg, color, size), interactive: false }).addTo(m.layers); }

// ---------- Router ----------
let tab = 'map', overlay = null;
function route() {
  const h = location.hash.slice(1) || 'map';
  if (h.startsWith('seg/')) { overlay = { kind: 'seg', id: Number(h.slice(4)) }; }
  else if (h === 'wahoo') overlay = { kind: 'wahoo' };
  else { overlay = null; tab = ['map', 'segments', 'route', 'profile'].includes(h) ? h : 'map'; }
  render();
}
window.addEventListener('hashchange', route);
function go(h) { location.hash = h; }
function closeOverlay() { history.length > 1 ? history.back() : go(tab); }

// ---------- Render ----------
function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 'tab-' + tab);
  $('#banner').innerHTML = (S.busy ? `<div class="busy"><span class="spin"></span>${esc(S.busy)}</div>` : '') + (S.error ? `<div class="err" data-act="clearError">${esc(S.error)}</div>` : '');
  if (!Auth.hasCredentials || !Auth.isLoggedIn) { renderLogin(); return; }
  switch (tab) { case 'map': renderMapTab(); break; case 'segments': renderSegments(); break; case 'route': renderRoute(); break; case 'profile': renderProfile(); break; }
  renderOverlay();
}

function renderLogin() {
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 'tab-login');
  const c = Auth.cfg, standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('#tab-login').innerHTML = `
    <div class="login">
      <div class="logo">${komLogo(56)}</div>
      <h1>SegmentRouter</h1>
      <p class="muted">Machbare Strava-Segmente finden, Route bauen, GPX aufs Gerät.</p>
      ${!Auth.hasCredentials ? `
      <div class="card">
        <div class="section">Strava-API-App</div>
        <p class="hint">Einmalig unter <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> anlegen. Authorization Callback Domain: <b>${esc(location.hostname)}</b>. Client-ID und Secret bleiben nur in diesem Browser.</p>
        <input id="cid" placeholder="Client-ID" inputmode="numeric" value="${esc(c.clientId || '')}">
        <input id="csec" placeholder="Client Secret" value="${esc(c.clientSecret || '')}">
        <button class="btn prominent" data-act="saveCreds">Speichern</button>
        <p class="hint" style="margin-top:12px">Oder: in Safari schon verbunden? Dort im Profil „Übernahme-Code kopieren“ und hier einfügen.</p>
        <input id="handover" placeholder="Übernahme-Code einfügen"><button class="btn" data-act="importHandover">Anmeldung übernehmen</button>
      </div>` : `
      <button class="btn prominent" data-act="login">Mit Strava verbinden</button>
      ${standalone ? `<div class="card"><div class="section">Anmeldung klappt hier nicht?</div><p class="hint">Diese Home-Bildschirm-App hat einen eigenen Speicher. Wenn Strava dich per E-Mail-Link anmeldet, landet die Anmeldung in Safari. Lösung: in <b>Safari</b> die gleiche Adresse öffnen, dort verbinden, im Profil „Übernahme-Code kopieren“ und hier einfügen.</p><input id="handover" placeholder="Übernahme-Code einfügen"><button class="btn" data-act="importHandover">Anmeldung übernehmen</button></div>` : ''}
      <p class="hint">Zeigt Strava danach „Bad Request“, stimmt die <b>Authorization Callback Domain</b> der API-App nicht: Sie muss exakt <b>${esc(location.hostname)}</b> lauten (ohne https://, ohne Pfad). Client-ID: ${esc(c.clientId)}.</p>
      <button class="btn link" data-act="editCreds">Zugangsdaten ändern</button>`}
      ${S.info ? `<p class="hint">${esc(S.info)}</p>` : ''}
    </div>`;
}

function komLogo(size) { return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${ACCENT}"/><path d="M7 78 L36 41 L47 53 L63 29 L93 78 Z" fill="#fff"/><path d="M63 29 L93 78 L63 78 Z" fill="#ffe2d4"/><path d="M55 26 L55 22 L58 14 L61 21 L63 12 L65 21 L68 14 L71 22 L71 26 Z" fill="#fff"/><text x="50" y="94" text-anchor="middle" font-family="-apple-system,Helvetica,Arial" font-weight="700" font-size="15" fill="#fff">KOM</text></svg>`; }

// ---------- Tab: Touren (Karte) ----------
function renderMapTab() {
  const m = mapFor('map-main');
  const mode = S.settings.mapMode, rides = Object.values(S.activities), routes = Object.values(S.routes);
  m.layers.clearLayers();
  if (mode === 'ridden') for (const a of rides) { if (S.selectedTour !== a.id) { const c = Seg.coords({ polyline: a.polyline, start: [0, 0], end: [0, 0] }); if (c.length > 2) L.polyline(c, { color: ACCENT, weight: 2, opacity: 0.35, interactive: false }).addTo(m.layers); } }
  else for (const r of routes) { if (S.routeFilter !== r.id) { const c = Seg.coords({ polyline: r.polyline, start: [0, 0], end: [0, 0] }); if (c.length > 2) L.polyline(c, { color: PLANNED, weight: 2, opacity: 0.7, dashArray: '5 4', interactive: false }).addTo(m.layers); } }
  if (S.context) {
    const { coords } = S.contextTrack();
    if (coords.length > 1) {
      L.polyline(coords, { color: S.selectedTour != null ? ACCENT : PLANNED, weight: 4, interactive: false }).addTo(m.layers);
      directionArrows(m, coords, 16, '#fff', 10);
      L.marker(coords[0], { icon: numIcon('S', '#eee', '#121212', ACCENT), interactive: false }).addTo(m.layers);
      L.marker(coords[coords.length - 1], { icon: numIcon('Z', '#eee', '#121212', ACCENT), interactive: false }).addTo(m.layers);
    }
    S.contextSegments.forEach((s, i) => {
      const f = S.feasibility(s), c = f.hasChance ? Fmt.chance(f.score) : '#2a2a2a';
      if (f.hasChance) L.polyline(Seg.coords(s), { color: c, weight: 6, lineCap: 'round', interactive: false }).addTo(m.layers);
      L.marker(s.start, { icon: numIcon(i + 1, c, f.hasChance ? '#121212' : '#eee', S.selected.has(s.id) ? '#ffd60a' : (f.hasChance ? '#121212' : ACCENT)) }).on('click', () => go('seg/' + s.id)).addTo(m.layers);
    });
  }
  userMarker(m);
  if (!m._framed) { m._framed = true; if (S.location) m.setView(S.location, 10); setTimeout(() => m.invalidateSize(), 50); }
  // Nach dem Laden von Routen/Touren einmal auf alle zoomen (sonst bleibt der Ausschnitt beim Standort).
  if (m._fitAll) { m._fitAll = false; const pts = (mode === 'ridden' ? rides : routes).flatMap(t => { const c = Seg.coords({ polyline: t.polyline, start: [0, 0], end: [0, 0] }); return c.length > 2 ? c.filter((_, i) => i % 10 === 0) : []; }); if (pts.length) setTimeout(() => { m.invalidateSize(); fitTo(m, pts); }, 60); }
  // Bei Wechsel der Tour/Route auf deren Ausdehnung zoomen.
  const ck = S.contextKey;
  if (ck !== m._ctxKey) { m._ctxKey = ck; if (ck) { const { coords } = S.contextTrack(); if (coords.length > 1) setTimeout(() => { m.invalidateSize(); fitTo(m, coords); }, 60); } }
  const empty = mode === 'planned' ? !routes.length : !rides.length;
  const name = S.contextName;
  $('#map-top').innerHTML = `<div class="seg-ctl"><button class="${mode === 'planned' ? 'on' : ''}" data-act="mapMode" data-arg="planned">Geplante Routen</button><button class="${mode === 'ridden' ? 'on' : ''}" data-act="mapMode" data-arg="ridden">Gefahrene Touren</button></div>
    <div class="map-btns"><button class="iconbtn" data-act="styleCycle" title="Kartenstil">▦</button><button class="iconbtn" data-act="locate" title="Standort">◎</button><button class="iconbtn" data-act="tourList" title="Liste">☰</button></div>`;
  let panel = '';
  if (empty) panel = `<div class="chooser"><div class="section">${mode === 'planned' ? 'Geplante Routen' : 'Gefahrene Touren'}</div><p class="hint">${mode === 'planned' ? 'Lädt die Liste deiner bei Strava gespeicherten Routen (1–2 Calls). Segmente je Route beim Antippen.' : 'Lädt deine Fahrten mit Track (200 je Call, keine Efforts). Segmente je Tour beim Antippen.'}</p>
    <button class="btn prominent" data-act="${mode === 'planned' ? 'loadRoutes' : 'loadActivityMap'}">${mode === 'planned' ? 'Geplante Routen laden' : 'Gefahrene Touren laden'}</button>
    <button class="btn link" data-act="mapMode" data-arg="${mode === 'planned' ? 'ridden' : 'planned'}">Stattdessen ${mode === 'planned' ? 'gefahrene Touren' : 'geplante Routen'}</button>${S.info ? `<p class="hint">${esc(S.info)}</p>` : ''}</div>`;
  else if (name) {
    const segs = S.contextSegments, unridden = segs.filter(s => !Seg.ridden(s)).length, ctx = S.context;
    const stats = ctx.kind === 'tour' ? `${Fmt.date(S.activities[ctx.id].date)} · ${Fmt.km(S.activities[ctx.id].distance)}` : `geplant · ${Fmt.km(S.routes[ctx.id].distance)} · ${Fmt.hm(S.routes[ctx.id].elevationGain)}`;
    const numbered = segs.map((s, i) => [i + 1, s, S.feasibility(s)]), any = numbered.some(x => x[2].hasChance);
    const ordered = any ? numbered.sort((a, b) => (a[2].hasChance ? 1 - a[2].score : 2) - (b[2].hasChance ? 1 - b[2].score : 2)) : numbered;
    panel = `<div class="ctxhead"><div><div class="title">${esc(name)}</div><div class="mono muted">${stats} · ${segs.length} Segmente · ${unridden} ungefahren</div></div>
      <button class="iconbtn" data-act="go" data-arg="segments" title="Liste">≡</button><button class="iconbtn" data-act="selectAll" title="Alle zur Route">＋</button><button class="iconbtn" data-act="clearContext" title="Schließen">✕</button></div>
      ${S.contextMissingRecords ? `<button class="btn prominent" data-act="loadRecords">KOMs laden für ${Math.min(40, S.contextMissingRecords)} Segmente → Chancen anzeigen</button>` : ''}
      <div class="chips">${ordered.map(([n, s, f]) => `<span class="chip ${S.selected.has(s.id) ? 'sel' : ''}"><button data-act="toggle" data-arg="${s.id}">${S.selected.has(s.id) ? '●' : '○'}</button><button data-act="go" data-arg="seg/${s.id}"><i style="background:${f.hasChance ? Fmt.chance(f.score) : LINE}"></i>${n}. ${esc(s.name)}${f.hasChance ? ` <b style="color:${Fmt.chance(f.score)}">${Math.round(f.score * 100)} %</b>` : ''}${Seg.knownRank(s) ? ` <b class="rank">#${Seg.knownRank(s)}</b>` : ''}${s.starred ? ' ★' : ''}</button></span>`).join('') || '<span class="hint">Keine befahrbaren Segmente auf dieser Tour.</span>'}</div>`;
  } else panel = `<div class="hint">${mode === 'planned' ? `${routes.length} geplante Routen` : `${rides.length} gefahrene Touren`} · Tour antippen oder Liste öffnen.</div>${S.info ? `<div class="hint">${esc(S.info)}</div>` : ''}`;
  $('#map-panel').innerHTML = panel;
  if (!m._tapBound) { m._tapBound = true; m.on('click', e => handleMapTap([e.latlng.lat, e.latlng.lng], m)); }
  m.off('moveend'); m.on('moveend', () => {}); 
}
function handleMapTap(c, m) {
  const px = m.latLngToContainerPoint(c), p2 = m.containerPointToLatLng([px.x + 22, px.y]); const tol = Geo.distanceM(c, [p2.lat, p2.lng]);
  if (S.context) { const hit = S.contextSegments.map(s => [s, Geo.minDistanceM(c, Seg.coords(s))]).filter(x => x[1] <= tol).sort((a, b) => a[1] - b[1])[0]; if (hit) { go('seg/' + hit[0].id); return; } }
  const pool = S.settings.mapMode === 'ridden' ? Object.values(S.activities) : Object.values(S.routes);
  const best = pool.map(t => [t, Geo.minDistanceM(c, Seg.coords({ polyline: t.polyline, start: [0, 0], end: [0, 0] }))]).filter(x => x[1] <= tol).sort((a, b) => a[1] - b[1])[0];
  if (best) { S.settings.mapMode === 'ridden' ? S.selectTour(best[0].id) : S.selectRoute(best[0].id); } else S.clearContext();
}
function frameContext() { const m = maps['map-main']; if (!m) return; const { coords } = S.contextTrack(); if (coords.length > 1) fitTo(m, coords); }

function tourListSheet() {
  const mode = S.settings.mapMode;
  const items = mode === 'planned'
    ? Object.values(S.routes).sort((a, b) => a.name.localeCompare(b.name)).map(r => `<button class="row" data-act="selectRoute" data-arg="${r.id}"><span class="dot" style="color:${r.loaded ? PLANNED : MUTED}">${r.loaded ? '●' : '◌'}</span><span><div>${esc(r.name)}</div><div class="mono muted">${Fmt.km(r.distance)} · ${Fmt.hm(r.elevationGain)}${r.loaded ? ` · ${r.segmentIds.length} Seg.` : ''}</div></span></button>`)
    : Object.values(S.activities).sort((a, b) => (b.date || 0) - (a.date || 0)).map(a => `<button class="row" data-act="selectTour" data-arg="${a.id}"><span class="dot" style="color:${a.segmentIds ? ACCENT : MUTED}">${a.segmentIds ? '●' : '◌'}</span><span><div>${esc(a.name)}</div><div class="mono muted">${Fmt.date(a.date)} · ${Fmt.km(a.distance)} · ${Fmt.hm(a.elevationGain)}${a.segmentIds ? ` · ${a.segmentIds.length} Seg.` : ''}</div></span></button>`);
  return `<div class="sheet"><div class="sheethead"><b>${mode === 'planned' ? 'Geplante Routen' : 'Gefahrene Touren'}</b><button class="btn small" data-act="${mode === 'planned' ? 'loadRoutes' : 'loadActivityMap'}">Laden</button><button class="iconbtn" data-act="closeSheet">✕</button></div><div class="list">${items.join('') || '<p class="hint">Noch nichts geladen.</p>'}</div></div>`;
}

// ---------- Tab: Segmente ----------
function renderSegments() {
  const name = S.contextName, ctx = S.context;
  let head;
  if (name) { const c = S.placementCounts, un = S.contextSegments.filter(s => !Seg.ridden(s)).length;
    head = `<div class="ctxhead"><div><div class="title">${esc(name)}</div><div class="mono muted">${c.onRoute} auf Route (${un} ungefahren) · ${c.opposite} Gegenrichtung · ${c.adjacent} Abzweig</div></div><button class="iconbtn" data-act="clearContext">✕</button>${dataMenu()}</div>`; }
  else head = `<div class="ctxhead"><div class="title">${S.showAll ? 'Alle Segmente' : 'Keine Tour gewählt'}</div>${dataMenu()}</div>`;
  if (ctx && S.contextMissingRecords) head += `<button class="btn prominent" data-act="loadRecords">KOMs laden für ${Math.min(40, S.contextMissingRecords)} Segmente → Chancen berechnen</button>`;
  if (S.info) head += `<p class="hint">${esc(S.info)}</p>`;
  if (!ctx && !S.showAll) { $('#tab-segments').innerHTML = head + `<div class="placeholder">${komLogo(40)}<p>Erst eine Tour wählen</p><p class="hint">Auf der Karte eine gefahrene Fahrt oder geplante Strava-Route antippen. Dann erscheinen hier ihre Segmente mit Rückstand, Chance und Wind.</p><button class="btn" data-act="go" data-arg="map">Zur Karte</button><button class="btn link" data-act="showAll">Alle ${Object.keys(S.segments).length} Segmente anzeigen</button></div>`; return; }
  const c = S.placementCounts, list = S.filtered, nums = S.routeNumbers, pl = S.placements();
  const bar = `<div class="filterbar">${ctx ? `<button class="chipbtn ${S.filter === 'onRoute' ? 'on' : ''}" data-act="filter" data-arg="onRoute">Auf Route · ${c.onRoute}</button><button class="chipbtn ${S.filter === 'adjacent' ? 'on' : ''}" data-act="filter" data-arg="adjacent">Angrenzend · ${c.opposite + c.adjacent}</button>` : ''}
    <select class="sel" data-set="sort">${SORTS.filter(s => s[0] !== 'routeOrder' || ctx).map(s => `<option value="${s[0]}" ${S.sort === s[0] ? 'selected' : ''}>${s[1]}</option>`).join('')}</select>
    ${!ctx ? `<select class="sel" data-setting="radiusKm">${RADIUS_OPTIONS.map(r => `<option value="${r}" ${S.settings.radiusKm === r ? 'selected' : ''}>${r ? r + ' km' : 'Kein Limit'}</option>`).join('')}</select>` : ''}
    <span class="mono muted right">${list.length} / ${Object.keys(S.segments).length}</span></div>`;
  const rows = list.map(([s, f]) => {
    const kom = S.komDeficit(s, f), t10 = S.top10Deficit(s, f), rel = S.routeRelation(s.id), be = Seg.bestEffort(s), pr = Seg.bestSeconds(s), n = nums[s.id];
    let rec = '';
    if (Seg.hasRecords(s) || pr != null || f.headwind != null) rec = `<div class="mono muted rec">${pr != null ? `PR ${Fmt.time(pr)} ` : ''}${be?.watts ? `${Math.round(be.watts)} W ` : ''}${s.komSeconds ? `KOM ${Fmt.time(s.komSeconds)} ` : ''}${kom ? `<span style="color:${kom.seconds <= 0 ? ACCENT : '#eee'}">${kom.modelled ? '~' : ''}${Fmt.gapPercent(kom.percent)}</span> ` : ''}${t10 ? `<span style="color:${t10.seconds <= 0 ? ACCENT : MUTED}">T10 ${t10.modelled ? '~' : ''}${Fmt.gapPercent(t10.percent)}</span> ` : ''}${Seg.knownRank(s) ? `<span class="rank">#${Seg.knownRank(s)}</span> ` : ''}${f.windDelta != null && Math.abs(f.windDelta) >= 3 ? `<span style="color:${f.windDelta > 0 ? MUTED : ACCENT}">Wind ${Fmt.gap(f.windDelta)}</span>` : ''}</div>`;
    const t10s = Seg.top10Seconds(s, S.settings.top10Percent);
    return `<div class="segrow"><i class="bar" style="background:${f.hasChance ? Fmt.chance(f.score) : LINE}"></i><button class="check" data-act="toggle" data-arg="${s.id}">${S.selected.has(s.id) ? '●' : '○'}</button>
      <button class="body" data-act="go" data-arg="seg/${s.id}"><div class="name">${n ? `<span class="num">${n}</span>` : ''}${esc(s.name)}${rel ? ` <small style="color:${rel === 'Gegenrichtung' ? Fmt.chance(0.1) : MUTED}">${rel}</small>` : ''}</div>
      <div class="mono muted">${S.sort !== 'routeOrder' && pl[s.id] ? (S.kmFromHere(s.id) != null ? (S.kmFromHere(s.id) < 0 ? `${(-S.kmFromHere(s.id) / 1000).toFixed(1)} km zurück` : `in ${(S.kmFromHere(s.id) / 1000).toFixed(1)} km`) : `km ${(pl[s.id].posM / 1000).toFixed(1)}`) + ' · ' : ''}${Fmt.km(s.distance)} · ${Fmt.grade(s.avgGrade)} · ${Fmt.hm(s.elevGain)}${!ctx && S.location ? ` · ↔ ${Fmt.kmShort(Geo.distanceM(S.location, s.start))}` : ''}${s.starred ? ' ★' : ''}${Seg.ridden(s) ? ' ✓' : ''}</div>${rec}
      ${s.komSeconds && t10s ? rankBar(s.komSeconds, t10s, pr, f.kind === 'power' ? f.estimatedSeconds : null, true) : ''}</button>
      <div class="right"><div class="sortval">${esc(S.sortValue(s, f) || '')}</div>${f.estimatedSeconds ? `<div class="mono muted">~${Fmt.time(f.estimatedSeconds)}</div>` : ''}</div></div>`;
  }).join('');
  $('#tab-segments').innerHTML = head + bar + `<div class="seglist">${rows || '<p class="hint">Keine Segmente in dieser Ansicht.</p>'}</div>`;
}
function dataMenu() {
  return `<details class="menu"><summary class="iconbtn">⤓</summary><div class="menubody">
    <button data-act="loadRecords">🏆 Rekorde (PR · KOM) für diese Ansicht</button><button data-act="starSelected">★ Ausgewählte starren (Live Segments)</button><hr>
    <button data-act="loadActivityMap">🌍 Fahrten für die Karte</button><button data-act="loadRoutes">🗺 Strava-Routen (Liste)</button><button data-act="loadStarred">☆ Gestarrte Segmente</button><button data-act="loadActivities">🚲 Fahrten mit Efforts (Seite ${S.settings.activitiesPage})</button><button data-act="loadPowerCurve">⚡ Leistungskurve</button>${S.settings.exploreAvailable !== false ? '<button data-act="explore">◎ Explore</button>' : ''}<hr>
    <button data-act="toggleShowAll">${S.showAll ? '☑' : '☐'} Alle Segmente ohne Tour zeigen</button></div></details>`;
}
function rankBar(kom, top10, best, model, compact) {
  const minT = kom * 0.96, maxT = Math.max(top10 * 1.25, (best || 0) * 1.08, (model || 0) * 1.08);
  const x = t => Math.min(100, Math.max(0, (t - minT) / (maxT - minT) * 100));
  return `<div class="rankbar ${compact ? 'compact' : ''}"><div class="zone" style="left:${x(kom)}%;width:${Math.max(1, x(top10) - x(kom))}%"></div><span class="crown" style="left:${x(kom)}%">♛</span><span class="tick" style="left:${x(top10)}%"></span>${model ? `<span class="model" style="left:${x(model)}%"></span>` : ''}${best ? `<span class="best" style="left:${x(best)}%"></span>` : ''}</div>`;
}

// ---------- Detail ----------
let windAnim = null;
function renderOverlay() {
  const o = $('#overlay');
  if (!overlay) { o.hidden = true; o.innerHTML = ''; dropDetailMap(); stopWind(); return; }
  o.hidden = false;
  if (overlay.kind === 'wahoo') { renderWahoo(); return; }
  const s = S.segments[overlay.id]; if (!s) { o.innerHTML = '<div class="sheet"><p class="hint">Segment nicht im Cache.</p></div>'; return; }
  const f = S.feasibility(s), kom = S.komDeficit(s, f), t10 = S.top10Deficit(s, f), pr = Seg.bestSeconds(s), be = Seg.bestEffort(s), w = S.wind[s.id], kg = S.effectiveRiderKg, t10s = Seg.top10Seconds(s, S.settings.top10Percent);
  // Karte nur einmal je Segment aufbauen; bei weiteren Renders nur Ebenen, Windrose und Legende erneuern.
  const roseHtml = w ? `<div class="rose"><div class="arrow" style="transform:rotate(${w.fromDeg + 180}deg)">↑</div><div class="mono">${Fmt.compass(w.fromDeg)} ${Math.round(w.speed * 3.6)} km/h</div>${w.gust ? `<div class="mono muted small">Böen ${Math.round(w.gust * 3.6)}</div>` : ''}</div><div class="legend"><i style="background:${Fmt.windColor(3)}"></i>Gegenwind <i style="background:${Fmt.windColor(-3)}"></i>Rückenwind · Strömung = Windrichtung</div>` : '';
  const styleBtn = `<button class="iconbtn stylebtn" data-act="styleCycle">▦ ${esc(MAP_STYLES.find(x => x[0] === S.settings.mapStyle)?.[1].split(' ')[0] || '')}</button>`;
  if (!o.querySelector('#map-detail') || o.dataset.seg != String(s.id)) {
    o.dataset.seg = s.id;
    dropDetailMap();
    o.innerHTML = `<div class="detail"><div class="sheethead"><button class="iconbtn" data-act="closeOverlay">‹</button><b class="title">${esc(s.name)}</b><button class="iconbtn" data-act="toggle" data-arg="${s.id}">${S.selected.has(s.id) ? '●' : '○'}</button></div><div class="detailmap"><div id="map-detail"></div><canvas id="windfield"></canvas><div id="map-deco">${roseHtml}${styleBtn}</div></div><div id="detail-body"></div></div>`;
    S.loadProfile(s.id); if (!w) S.loadWind([s.id]);
  } else { $('#map-deco').innerHTML = roseHtml + styleBtn; }
  drawDetailMap(s, w);
  const prof = s.profile;
  let html = '';
  if (prof?.length > 1) { const st = prof[0].e, en = prof[prof.length - 1].e; let gain = 0, loss = 0; for (let i = 1; i < prof.length; i++) { const d = prof[i].e - prof[i - 1].e; d > 0 ? gain += d : loss -= d; }
    html += `<div class="card"><div class="section">Höhenprofil<span class="mono muted">${Math.round(st)} → ${Math.round(en)} m · +${Math.round(gain)} / −${Math.round(loss)} hm</span></div>${elevationSvg(prof)}</div>`; }
  html += `<div class="tiles two">${tile('Deine Bestzeit', pr != null ? Fmt.time(pr) : '–', null, pr != null ? `${(s.distance / pr * 3.6).toFixed(1)} km/h` : null)}${tile('KOM', s.komSeconds ? Fmt.time(s.komSeconds) : '–', null, s.komSeconds ? `${(s.distance / s.komSeconds * 3.6).toFixed(1)} km/h` : '„Rekorde“ laden')}
    ${tile(kom ? (kom.modelled ? 'Rückstand KOM (Modell)' : 'Rückstand KOM') : 'Rückstand KOM', kom ? Fmt.gapPercent(kom.percent) : '–', kom ? (kom.seconds <= 0 ? ACCENT : '#eee') : MUTED, kom ? Fmt.gap(kom.seconds) : null)}
    ${tile('Top-10-Chance', f.hasChance ? `${Math.round(f.score * 100)} %` : '–', f.hasChance ? Fmt.chance(f.score) : MUTED, f.hasChance ? (t10 ? `T10 ${t10.modelled ? '~' : ''}${Fmt.gapPercent(t10.percent)} · Modell ${Fmt.time(f.estimatedSeconds)}` : null) : (s.komSeconds == null ? 'erst KOM laden' : 'erst Leistungskurve laden'))}</div>`;
  // Platzierung
  html += `<div class="card"><div class="section">Platzierung<span class="mono muted">${Seg.knownRank(s) ? `Rang #${Seg.knownRank(s)}` : 'Rang unbekannt'}</span></div>${s.komSeconds && t10s ? rankBar(s.komSeconds, t10s, pr, f.kind === 'power' ? f.estimatedSeconds : null, false) + `<div class="mono muted small">♛ ${Fmt.time(s.komSeconds)} │ Top 10 ~${Fmt.time(t10s)}${pr != null ? ` ● ${Fmt.time(pr)}` : ''}${f.kind === 'power' ? ` ○ ${Fmt.time(f.estimatedSeconds)}` : ''}</div>` : '<p class="hint">KOM-Zeit fehlt – „Rekorde“ laden.</p>'}
    <p class="hint">${Seg.knownRank(s) ? (Seg.knownRank(s) === 1 && (Seg.komGap(s) ?? 1) <= 0 ? 'Du hältst den KOM (Bestzeit ≤ KOM-Zeit).' : `Platz #${Seg.knownRank(s)} zum Zeitpunkt deiner Fahrt. Ob der Platz noch gilt, sagt die API nicht.`) : 'Strava liefert keinen aktuellen Rang mehr; nur Top-10-Platzierungen zum Zeitpunkt einer Fahrt sind bekannt.'}</p></div>`;
  // Efforts
  html += `<div class="card"><div class="section">Deine Efforts<span class="mono muted">${s.recordsUpdated ? `Rekorde: ${Fmt.date(s.recordsUpdated)}` : ''}</span></div>`;
  if (be) html += `<div class="tiles three">${tile('Bester Effort', Fmt.time(be.elapsed), null, Fmt.date(be.date))}${tile('Leistung', be.watts != null ? `${Math.round(be.watts)} W` : '–', null, be.watts != null ? `${(be.watts / kg).toFixed(1)} W/kg${be.deviceWatts ? '' : ' · geschätzt'}` : null)}${tile('Versuche', String(s.effortCount ?? s.efforts.length), null, Seg.bestKomRank(s) ? `beste Platzierung #${Seg.bestKomRank(s)}` : null)}</div>`;
  else if (s.prSeconds) html += `<div class="statrow"><span>PR laut Strava</span><span class="mono">${Fmt.time(s.prSeconds)}${s.prDate ? ` · ${Fmt.date(s.prDate)}` : ''}</span></div><p class="hint">Efforts mit Watt kommen über „Fahrten“.</p>`;
  else html += '<p class="hint">Noch nicht gefahren.</p>';
  if (s.efforts.length > 1) html += `<table class="tbl"><tr><th>Datum</th><th>Zeit</th><th>W</th><th>Rang</th></tr>${[...s.efforts].sort((a, b) => a.elapsed - b.elapsed).slice(0, 8).map(e => `<tr><td>${Fmt.date(e.date)}</td><td>${Fmt.time(e.elapsed)}</td><td>${e.watts != null ? Math.round(e.watts) : '–'}</td><td class="rank">${e.komRank ? '#' + e.komRank : ''}</td></tr>`).join('')}</table>`;
  html += `<button class="btn" data-act="refreshRecords" data-arg="${s.id}">${Seg.hasRecords(s) ? 'Rekorde aktualisieren' : 'Rekorde laden (KOM, PR)'}</button></div>`;
  // Modell
  if (!f.hasChance) html += `<div class="card"><div class="section">Chance berechnen</div><p class="hint">${s.komSeconds == null ? 'Die Top-10-Chance braucht die KOM-Zeit dieses Segments (1 Strava-Call).' : 'Die Top-10-Chance braucht deine Leistungskurve (Profil → Leistungskurve laden).'}</p>${s.komSeconds == null ? `<button class="btn prominent" data-act="refreshRecords" data-arg="${s.id}">KOM laden → Chance berechnen</button>` : `<button class="btn prominent" data-act="go" data-arg="profile">Zum Profil (Leistungskurve)</button>`}</div>`;
  else html += `<div class="card"><div class="section">Leistungsmodell</div><div class="tiles three">${tile('Nötig für Top 10', `${Math.round(f.requiredWattsTop10)} W`, null, `${(f.requiredWattsTop10 / kg).toFixed(1)} W/kg`)}${tile('Nötig für KOM', `${Math.round(f.requiredWattsKom)} W`, null, `${(f.requiredWattsKom / kg).toFixed(1)} W/kg`)}${tile('Deine Kapazität', `${Math.round(f.capacityWattsTop10)} W`, f.capacityWattsTop10 >= f.requiredWattsTop10 ? ACCENT : null, `${(f.capacityWattsTop10 / kg).toFixed(1)} W/kg · Dauer Top 10`)}</div><div class="statrow"><span>KOM-Chance</span><span class="mono">${Math.round(f.komProbability * 100)} %</span></div>${f.reasons.map(r => `<p class="hint">· ${esc(r)}</p>`).join('')}<p class="hint">Top 10 = KOM + ${S.settings.top10Percent} % (Schätzung, im Profil einstellbar). Strava liefert keine Leaderboards mehr.</p></div>`;
  // Wind
  const eta = S.etaAt(s);
  html += `<div class="card"><div class="section">Wind bei Ankunft<span class="mono muted">${w ? `Prognose ${Fmt.dateTime(w.time)}` : ''}</span></div><label class="statrow"><span>Fahrtbeginn</span><input type="datetime-local" data-set="rideDate" value="${localIso(S.rideDate)}"></label>${S.context ? `<div class="statrow"><span>Voraussichtlich am Segment</span><span class="mono">${Fmt.dateTime(eta)} · Ø ${Math.round(S.effectiveAvgSpeed)} km/h</span></div>` : ''}`;
  if (w) { const hw = f.headwind ?? 0, eff = f.effectiveHeadwind ?? 0, ex = (await0 => await0)(0); html += `<div class="tiles three">${tile('Wind (10 m)', `${Math.round(w.speed * 3.6)} km/h`, null, `aus ${Fmt.compass(w.fromDeg)}${w.gust ? ` · Böen ${Math.round(w.gust * 3.6)}` : ''}`)}${tile(hw > 0.3 ? 'Gegenwind' : hw < -0.3 ? 'Rückenwind' : 'Seitenwind', `${Math.abs(hw).toFixed(1)} m/s`, hw > 0.3 ? Fmt.windColor(3) : hw < -0.3 ? Fmt.windColor(-3) : MUTED, `wirksam ${Math.abs(eff).toFixed(1)} m/s · ${Math.round(100 * (1 - 0.07 * Math.max(0, s.avgGrade)) > 35 ? 100 * (1 - 0.07 * Math.max(0, s.avgGrade)) : 35)} % am Berg`)}${tile('Mit Wind', f.windSeconds ? Fmt.time(f.windSeconds) : '–', (f.windDelta ?? 0) <= 0 ? ACCENT : null, f.windDelta != null ? `${Fmt.gap(f.windDelta)} vs. windstill` : null)}</div>${f.windScore != null ? `<div class="statrow"><span>Top-10-Chance mit Wind</span><span class="mono">${Math.round(f.windScore * 100)} % (windstill ${Math.round(f.score * 100)} %)</span></div>` : ''}<p class="hint">Liste, Sortierung und Chance bleiben windstill. Wind ist ein Zusatzeffekt zur Ankunftszeit; am Berg wird er gedämpft.</p>`; }
  else html += '<p class="hint">Keine Vorhersage geladen.</p>';
  html += `<button class="btn" data-act="reloadWind" data-arg="${s.id}">Wind aktualisieren</button></div>`;
  // Fakten
  const p = S.placements()[s.id], kfh = S.kmFromHere(s.id);
  html += `<div class="card"><div class="section">Segment</div><div class="tiles four">${tile('Länge', Fmt.km(s.distance))}${tile('Ø Steigung', Fmt.grade(s.avgGrade), null, s.maxGrade != null ? `max ${Fmt.grade(s.maxGrade)}` : null)}${tile('Höhenmeter', Fmt.hm(s.elevGain))}${tile('Fahrer', s.athleteCount != null ? String(s.athleteCount) : '–', null, s.starCount != null ? `${s.starCount} Sterne` : null)}</div>${p ? `<div class="statrow"><span>Position auf der Route</span><span class="mono">km ${(p.posM / 1000).toFixed(1)}${kfh != null ? (kfh < 0 ? ` · ${(-kfh / 1000).toFixed(1)} km hinter dir` : ` · ab hier in ${(kfh / 1000).toFixed(1)} km`) : ''}</span></div>` : ''}<div class="statrow"><span>Quellen</span><span class="mono">${s.sources.join(', ')}${s.starred ? ' · gestarrt' : ''}</span></div></div>`;
  html += `<div class="btnrow"><button class="btn" data-act="toggle" data-arg="${s.id}">${S.selected.has(s.id) ? 'Aus Route entfernen' : 'Zur Route'}</button><button class="btn ${s.starred ? '' : 'prominent'}" data-act="setStar" data-arg="${s.id}">${s.starred ? 'Stern entfernen' : 'Starren'}</button></div><p class="hint">Gestarrte Segmente erscheinen nach dem nächsten Strava-Sync als Live Segments auf Garmin/Wahoo.</p>`;
  o.querySelector('#detail-body').innerHTML = html;
}
function localIso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function tile(label, value, color, sub) { return `<div class="tile"><div class="l">${esc(label)}</div><div class="v" style="${color ? 'color:' + color : ''}">${esc(value)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`; }
function elevationSvg(pts, highlights = []) {
  const W = 600, H = 130, padL = 34, padB = 16, padT = 8;
  const dMax = pts[pts.length - 1].d || 1, es = pts.map(p => p.e), eMin = Math.min(...es), eMax = Math.max(...es), pad = Math.max(5, (eMax - eMin) * 0.12);
  const x = d => padL + d / dMax * (W - padL - 4), y = e => padT + (1 - (e - (eMin - pad)) / ((eMax + pad) - (eMin - pad))) * (H - padT - padB);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join('');
  const area = line + `L${x(pts[pts.length - 1].d).toFixed(1)},${(H - padB).toFixed(1)}L${padL},${(H - padB).toFixed(1)}Z`;
  const hl = highlights.map(h => `<rect x="${x(h.fromM)}" y="${padT}" width="${Math.max(1, x(h.toM) - x(h.fromM))}" height="${H - padT - padB}" fill="${h.color}" opacity="0.28"/><text x="${x(h.fromM) + 2}" y="${padT + 9}" font-size="8" fill="${h.color}" font-family="monospace">${h.label}</text>`).join('');
  const ticks = [0, 0.5, 1].map(t => `<text x="${x(dMax * t)}" y="${H - 3}" font-size="9" fill="${MUTED}" text-anchor="${t === 1 ? 'end' : t === 0 ? 'start' : 'middle'}">${(dMax * t / 1000).toFixed(1)}</text>`).join('') + [eMin, eMax].map(e => `<text x="2" y="${y(e) + 3}" font-size="9" fill="${MUTED}">${Math.round(e)}</text>`).join('');
  return `<svg class="elev" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.55"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0.05"/></linearGradient></defs>${hl}<path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="1.5"/>${ticks}</svg>`;
}
function drawDetailMap(s, w) {
  const m = mapFor('map-detail'); m.layers.clearLayers();
  const { coords: route } = S.contextTrack();
  if (route.length > 1) { L.polyline(route, { color: ACCENT, weight: 3, opacity: 0.3, interactive: false }).addTo(m.layers); directionArrows(m, route, 24, 'rgba(252,76,2,0.6)', 9); }
  const pts = Seg.coords(s);
  if (w) { for (const ch of windChunks(pts, w)) L.polyline(ch.coords, { color: Fmt.windColor(ch.component), weight: 5, lineCap: 'round', interactive: false }).addTo(m.layers); }
  else L.polyline(pts, { color: ACCENT, weight: 4, interactive: false }).addTo(m.layers);
  directionArrows(m, pts, 3, '#fff', 11);
  L.circleMarker(s.start, { radius: 5, color: ACCENT, weight: 1.5, fillOpacity: 0 }).addTo(m.layers);
  userMarker(m);
  let all = [...pts]; if (S.location && Geo.distanceM(S.location, Seg.mid(s)) < 60000) all.push(S.location);
  if (!m._framedFor || m._framedFor !== s.id) { m._framedFor = s.id; setTimeout(() => { m.invalidateSize(); fitTo(m, all); }, 30); }
  startWind(w);
}
function windChunks(pts, w) {
  if (pts.length < 2) return []; const per = Math.max(1, Math.floor((pts.length - 1) / 14)), out = []; const from = w.fromDeg * Math.PI / 180;
  for (let i = 0; i < pts.length - 1;) { const j = Math.min(pts.length - 1, i + per), slice = pts.slice(i, j + 1); let num = 0, den = 0;
    for (let k = 1; k < slice.length; k++) { const len = Geo.distanceM(slice[k - 1], slice[k]); if (len <= 1) continue; num += Math.cos(from - Geo.bearing(slice[k - 1], slice[k])) * len; den += len; }
    out.push({ coords: slice, component: den > 0 ? w.speed * Config.windHeightFactor * num / den : 0 }); i = j; }
  return out;
}
const SEED = Array.from({ length: 70 }, () => ({ x: Math.random() * 1.4 - 0.2, y: Math.random() * 1.4 - 0.2, phase: Math.random(), len: 0.6 + Math.random() * 0.9, jitter: 0.75 + Math.random() * 0.5 }));
function startWind(w) {
  stopWind(); const cv = $('#windfield'); if (!cv || !w) return;
  const ctx = cv.getContext('2d');
  const theta = (w.fromDeg + 180) * Math.PI / 180, dir = [Math.sin(theta), -Math.cos(theta)], pxPerSec = 10 + w.speed * 7, period = 7, baseTail = 14 + w.speed * 5;
  const draw = () => {
    const r = cv.getBoundingClientRect(); if (cv.width !== r.width * devicePixelRatio) { cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio; }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    const t = performance.now() / 1000;
    for (const p of SEED) {
      const life = ((t * p.jitter / period) + p.phase) % 1, travel = life * period * pxPerSec * p.jitter;
      const sx = p.x * r.width - dir[0] * period * pxPerSec * 0.5, sy = p.y * r.height - dir[1] * period * pxPerSec * 0.5;
      const hx = sx + dir[0] * travel, hy = sy + dir[1] * travel, tl = baseTail * p.len, tx = hx - dir[0] * tl, ty = hy - dir[1] * tl, a = Math.sin(life * Math.PI) * 0.8;
      const g = ctx.createLinearGradient(tx, ty, hx, hy); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, `rgba(255,255,255,${a})`);
      ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(hx, hy, 1.2, 0, 7); ctx.fill();
    }
    windAnim = requestAnimationFrame(draw);
  };
  windAnim = requestAnimationFrame(draw);
}
function dropDetailMap() { const m = maps['map-detail']; if (!m) return; try { m.stop(); m.off(); m.remove(); } catch {} delete maps['map-detail']; }
function stopWind() { if (windAnim) cancelAnimationFrame(windAnim); windAnim = null; }

// ---------- Tab: Route ----------
function renderRoute() {
  const m = mapFor('map-route'); m.layers.clearLayers();
  const ordered = S.route?.segments || S.selectedSegments, r = S.route;
  if (r) { L.polyline(r.track.map(p => [p.lat, p.lon]), { color: '#ddd', weight: 3, opacity: 0.7, interactive: false }).addTo(m.layers); if (r.returnTrack) L.polyline(r.returnTrack.map(p => [p.lat, p.lon]), { color: ACCENT, weight: 3, opacity: 0.8, dashArray: '6 5', interactive: false }).addTo(m.layers); }
  ordered.forEach((s, i) => { const f = S.feasibility(s), c = f.hasChance ? Fmt.chance(f.score) : ACCENT; L.polyline(Seg.coords(s), { color: c, weight: 5, lineCap: 'round', interactive: false }).addTo(m.layers); L.marker(s.start, { icon: numIcon(i + 1, c) }).on('click', () => go('seg/' + s.id)).addTo(m.layers); });
  userMarker(m);
  const all = [...ordered.flatMap(s => Seg.coords(s)), ...(r ? r.track.map(p => [p.lat, p.lon]) : []), ...(S.location ? [S.location] : [])];
  setTimeout(() => { m.invalidateSize(); if (all.length) fitTo(m, all); }, 30);
  let html = r ? `<div class="mapstats mono">${Fmt.km(r.lengthM + r.returnLengthM)} · ${Fmt.hm(r.ascendM + r.returnAscendM)} · ${r.segments.length} Seg.${r.returnTrack ? ` · ↩ ${Fmt.km(r.returnLengthM)}` : ''}</div>` : '';
  if (r && r.track.some(p => p.ele != null)) html += routeProfileCard(r);
  html += `<div class="card"><div class="section">Planung</div><label class="statrow"><span>Fahrtbeginn</span><input type="datetime-local" data-set="rideDate" value="${localIso(S.rideDate)}"></label>
    <label class="statrow"><span>Rückweg</span><select class="sel" data-setting="returnMode">${RETURN_MODES.map(x => `<option value="${x[0]}" ${S.settings.returnMode === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label>
    ${S.settings.returnMode === 'separate' ? '<p class="hint">Rückweg als zweiter Track, meidet die gefahrenen Segmente (Sperrkreise für BRouter). Beim Teilen zwei GPX-Dateien.</p>' : ''}
    <label class="statrow"><span>Routing-Profil</span><select class="sel" data-setting="brouterProfile">${Config.brouterProfiles.map(p => `<option ${S.settings.brouterProfile === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <div class="statrow"><span>Start</span><span class="mono">${S.location ? 'aktueller Standort' : 'erstes Segment'}</span></div></div>`;
  const est = S.selectedSegments.map(s => S.feasibility(s).estimatedSeconds).filter(x => x != null);
  html += `<div class="card"><div class="section">Segmente<span class="mono muted">${est.length ? `Segmentzeit ~${Fmt.time(est.reduce((a, b) => a + b, 0))}` : ''}</span>${S.selected.size ? '<button class="btn link small" data-act="clearSelection">Leeren</button>' : ''}</div>`;
  if (!ordered.length) html += '<p class="hint">Im Segmente-Tab Segmente auswählen.</p>';
  else html += `<table class="tbl"><tr><th>Segment</th><th>km/%</th><th>Modell</th><th>Wind</th></tr>${ordered.map((s, i) => { const f = S.feasibility(s); return `<tr data-act="go" data-arg="seg/${s.id}"><td><i class="dot" style="background:${f.hasChance ? Fmt.chance(f.score) : LINE}"></i>${i + 1}. ${esc(s.name)}</td><td>${(s.distance / 1000).toFixed(1)}/${Math.round(s.avgGrade)}</td><td>${f.estimatedSeconds ? Fmt.time(f.estimatedSeconds) : '–'}</td><td>${f.windDelta != null ? Fmt.gap(f.windDelta) : '–'}</td></tr>`; }).join('')}</table><p class="hint">Modell = windstill. Wind = Zeiteffekt zur Ankunftszeit (am Berg gedämpft).</p>`;
  if (r?.returnTrack) html += `<div class="statrow"><span>Hinweg</span><span class="mono">${Fmt.km(r.lengthM)} · ${Fmt.hm(r.ascendM)}</span></div><div class="statrow"><span>${r.returnAvoidsSegments ? 'Rückweg (andere Straßen)' : 'Rückweg (direkt)'}</span><span class="mono">${Fmt.km(r.returnLengthM)} · ${Fmt.hm(r.returnAscendM)}</span></div>`;
  html += '</div>';
  html += `<div class="btncol"><button class="btn ${r ? '' : 'prominent'}" data-act="planRoute">Route berechnen</button>${ordered.length ? '<button class="btn" data-act="go" data-arg="wahoo">Auf Wahoo bringen (Live Segments)</button>' : ''}${r ? `<button class="btn prominent" data-act="shareGpx">${r.returnTrack ? '2 GPX teilen: Hinweg + Rückweg' : 'GPX teilen (Garmin Connect / Wahoo)'}</button>` : ''}</div>${S.info ? `<p class="hint">${esc(S.info)}</p>` : ''}`;
  $('#route-body').innerHTML = html;
}
function routeProfileCard(r) {
  const track = [...r.track, ...(r.returnTrack || [])]; const pts = [], cum = []; let d = 0;
  track.forEach((p, i) => { if (i) d += Geo.distanceM([track[i - 1].lat, track[i - 1].lon], [p.lat, p.lon]); cum.push(d); if (p.ele != null) pts.push({ d, e: p.ele }); });
  const step = Math.max(1, Math.floor(pts.length / 300)), thin = pts.filter((_, i) => i % step === 0);
  const tc = track.map(p => [p.lat, p.lon]);
  const hl = r.segments.map((s, i) => { const f = S.feasibility(s); const a = cum[Geo.nearestIndex(s.start, tc)[0]], b = cum[Geo.nearestIndex(s.end, tc)[0]]; return { fromM: Math.min(a, b), toM: Math.max(a, b), color: f.hasChance ? Fmt.chance(f.score) : MUTED, label: String(i + 1) }; });
  return thin.length > 1 ? `<div class="card"><div class="section">Höhenprofil<span class="mono muted">${Fmt.km(r.lengthM + r.returnLengthM)} · ${Fmt.hm(r.ascendM + r.returnAscendM)}</span></div>${elevationSvg(thin, hl)}</div>` : '';
}

// ---------- Tab: Profil ----------
function renderProfile() {
  const p = S.profile, kg = S.effectiveRiderKg, pw = p.power, sy = S.sync, st = S.settings;
  let html = `<div class="card"><div class="section">Leistungsfähigkeit<span class="mono muted">${pw ? (pw.fromStreams ? 'Streams + Efforts' : pw.usesDeviceWatts ? 'Efforts (Powermeter)' : 'Efforts (geschätzt)') : ''}</span></div>`;
  if (pw) html += `<div class="tiles three">${tile('Critical Power', `${Math.round(pw.cp)} W`, null, `${(pw.cp / kg).toFixed(1)} W/kg`)}${tile('W′ (anaerob)', `${Math.round(pw.wPrime / 1000)} kJ`, null, 'Reserve über CP')}${tile('Datenbasis', `${pw.sampleCount} Eff.`, null, S.powerCurve.length ? `${S.powerCurve.length} Kurvenpunkte` : 'keine Streams')}</div><table class="tbl"><tr><th>Dauer</th><th>W</th><th>W/kg</th><th>aus</th></tr>${pw.envelope.map(pt => { const src = S.powerCurve.find(c => c.seconds === pt.seconds && Math.abs(c.watts - pt.watts) < 0.5); return `<tr><td>${pt.seconds < 60 ? pt.seconds + ' s' : pt.seconds < 3600 ? pt.seconds / 60 + ' min' : '1 h'}</td><td>${Math.round(pt.watts)}</td><td>${(pt.watts / kg).toFixed(1)}</td><td>${src ? Fmt.date(src.date) : 'Effort'}</td></tr>`; }).join('')}</table>`;
  else html += '<p class="hint">Noch keine Leistungsdaten. Leistungskurve aus deinen Strava-Fahrten laden (Powermeter nötig) oder „Fahrten“ laden.</p>';
  html += `<button class="btn" data-act="loadPowerCurve">Leistungskurve aus Strava laden (${Config.powerCurveRides} Fahrten)</button>${S.powerCurve.length ? '<button class="btn link small" data-act="resetCurve">Kurve zurücksetzen</button>' : ''}<p class="hint">Mean-Max je Dauer aus den Watt-Streams deiner letzten Fahrten mit Powermeter; Bestwerte bleiben erhalten.</p></div>`;
  // Wahoo
  const appCount = Object.values(sy.appStars).filter(s => !sy.protected.has(s.id)).length;
  html += `<div class="card"><div class="section">Wahoo Live Segments<span class="mono muted">${sy.starredLoadedAt ? `${sy.currentStarred.length} gesternt · ${Fmt.date(sy.starredLoadedAt)}` : 'Sterne nicht geladen'}</span></div>
    <label class="statrow"><span>Stern-Limit</span><span class="mono">${sy.limit}</span></label><input type="range" min="20" max="100" step="5" value="${sy.limit}" data-set="limit">
    <p class="hint">Wahoo übernimmt nur etwa 100 gesternte Segmente. Der Sync entsternt bei Bedarf App-Sterne (älteste zuerst), dann fremde – nie geschützte.</p>
    <button class="btn" data-act="refreshStars">Sterne von Strava laden</button>
    ${sy.currentStarred.length ? `<details><summary class="hint">Gesternte Segmente (${sy.currentStarred.length}) · ${sy.protected.size} geschützt · ${Object.keys(sy.appStars).length} von der App</summary>${[...sy.currentStarred].sort((a, b) => (b.appStarredAt || 0) - (a.appStarredAt || 0)).map(it => `<label class="statrow"><span><div>${esc(it.name)}</div><div class="mono muted small">${it.distance ? Fmt.km(it.distance) + ' · ' : ''}${sy.appStars[it.id] ? `App · ${Fmt.date(sy.appStars[it.id].starredAt)}` : 'fremd'}</div></span><span><input type="checkbox" data-protect="${it.id}" ${sy.protected.has(it.id) ? 'checked' : ''}> ${sy.protected.has(it.id) ? '🔒' : '🔓'}</span></label>`).join('')}<p class="hint">Schloss = geschützt, wird nie entsternt.</p></details>` : ''}
    <button class="btn" data-act="unstarAll" ${appCount && !sy.isRunning ? '' : 'disabled'}>Alle App-Sterne entfernen (${appCount})</button>${sy.isRunning ? `<progress value="${sy.progress.done}" max="${Math.max(1, sy.progress.total)}"></progress>` : ''}</div>`;
  // Tempo-Historie
  const maxV = Math.max(...p.speedByBin.filter(v => v != null), 40);
  html += `<div class="card"><div class="section">Tempo-Historie<span class="mono muted">${p.samples.length} Efforts</span></div><div class="tiles three">${tile('Steigung P90', p.p90Grade != null ? Fmt.grade(p.p90Grade) : '–')}${tile('Max. hm am Stück', p.maxGain != null ? Fmt.hm(p.maxGain) : '–')}${tile('Längstes Segment', p.maxDistance != null ? Fmt.km(p.maxDistance) : '–')}</div>${!p.hasEnoughData ? '<p class="hint">Weniger als 5 Efforts – „Fahrten“ laden, damit die Zeitschätzung greift.</p>' : ''}<p class="hint">Median-Tempo nach Steigung (km/h)</p>${BIN_LABELS.map((l, i) => { const v = p.speedByBin[i]; return `<div class="bin"><span class="mono muted">${l} %</span><div class="track"><div style="width:${Math.max(2, (v ?? p.speedKmh(i === 0 ? -5 : [-3, 0, 2, 4, 6, 8, 10][i - 1] + 1)) / maxV * 100)}%;background:${v == null ? LINE : ACCENT}"></div></div><span class="mono muted">${v != null ? Math.round(v) : '–'}</span></div>`; }).join('')}<p class="hint">Graue Balken: Modellwert ohne eigene Daten.</p></div>`;
  // Einstellungen
  html += `<div class="card"><div class="section">Einstellungen</div>
    ${stepper('Gewicht Fahrer', 'riderKg', `${kg.toFixed(1)} kg${st.riderKg > 30 ? '' : ' (Standard)'}`, 0.5)}${stepper('Gewicht Rad', 'bikeKg', `${st.bikeKg.toFixed(1)} kg`, 0.5)}${stepper('Top-10-Schätzung', 'top10Percent', `KOM +${st.top10Percent} %`, 1)}
    <p class="hint">Strava liefert keine Leaderboards mehr. Platz 10 wird als KOM plus diesen Prozentsatz geschätzt.</p>${stepper('Modell konservativ', 'pessimismPct', `−${st.pessimismPct} % Kapazität`, 1)}<p class="hint">Deine Leistungskurve sind Allzeit-Bestwerte; an einem normalen Tag liegst du darunter.</p>
    ${stepper('Ø Tempo für Ankunftszeit', 'avgSpeedKmh', st.avgSpeedKmh > 0 ? `${st.avgSpeedKmh} km/h` : `auto · ${Math.round(S.effectiveAvgSpeed)} km/h`, 1)}
    <label class="statrow"><span>Kartenstil</span><select class="sel" data-setting="mapStyle">${MAP_STYLES.map(x => `<option value="${x[0]}" ${st.mapStyle === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label>
    <label class="statrow"><span>Umkreis um Standort</span><select class="sel" data-setting="radiusKm">${RADIUS_OPTIONS.map(r => `<option value="${r}" ${st.radiusKm === r ? 'selected' : ''}>${r ? r + ' km' : 'Kein Limit'}</option>`).join('')}</select></label>
    <label class="statrow"><span>Rückweg</span><select class="sel" data-setting="returnMode">${RETURN_MODES.map(x => `<option value="${x[0]}" ${st.returnMode === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label></div>`;
  html += `<div class="card"><div class="section">Daten</div><div class="tiles three">${tile('Segmente', String(Object.keys(S.segments).length), null, `${Object.values(S.segments).filter(Seg.hasRecords.bind(Seg)).length} mit KOM`)}${tile('Routen', String(Object.keys(S.routes).length), null, `${Object.values(S.routes).filter(r => r.loaded).length} geladen`)}${tile('Fahrten', String(Object.keys(S.activities).length), null, `${Object.values(S.activities).filter(a => a.segmentIds).length} mit Segmenten`)}</div>
    <div class="statrow"><span>Explore-Endpoint</span><span class="mono">${st.exploreAvailable == null ? 'ungetestet' : st.exploreAvailable ? 'verfügbar' : 'gesperrt'}</span></div>
    <button class="btn" data-act="copyHandover">Übernahme-Code kopieren (für Home-Bildschirm-App)</button><p class="hint">Damit lässt sich diese Strava-Anmeldung in die Home-Bildschirm-App übertragen: dort auf dem Startbildschirm einfügen. Der Code enthält dein Strava-Token – nicht weitergeben.</p>
    <button class="btn" data-act="clearCache">Cache leeren</button><button class="btn" data-act="logout">Strava trennen</button><button class="btn link small" data-act="editCreds">Zugangsdaten ändern</button><p class="hint">SegmentRouter Web · Daten bleiben in diesem Browser.</p></div>`;
  $('#tab-profile').innerHTML = html;
}
function stepper(label, key, text, step) { return `<div class="statrow"><span>${label}</span><span class="stepper"><button data-act="step" data-arg="${key}|${-step}">−</button><span class="mono">${text}</span><button data-act="step" data-arg="${key}|${step}">+</button></span></div>`; }

// ---------- Wahoo-Sync ----------
const wahoo = { stage: 'loading', plan: null, result: null, remind: false, remindAt: null, note: null };
async function openWahoo() {
  wahoo.stage = 'loading'; wahoo.plan = null; render();
  const planned = (S.route?.segments || S.selectedSegments).map(s => ({ id: s.id, name: s.name, distance: s.distance }));
  try { wahoo.plan = await S.sync.plan(planned); wahoo.stage = 'preview'; }
  catch (e) { wahoo.stage = 'failed'; wahoo.note = e instanceof StravaError && e.rateLimited ? 'Strava-Rate-Limit (429): 15 Minuten warten, dann erneut.' : e.message; }
  render();
}
function renderWahoo() {
  const o = $('#overlay'); const pl = wahoo.plan;
  const list = (title, items, icon, origin) => items.length ? `<div class="card"><div class="section">${title}<span class="mono muted">${items.length}</span></div>${items.map(it => `<div class="statrow"><span>${icon} ${esc(it.name)}</span><span class="mono muted">${origin ? (it.appStarredAt ? `App · ${Fmt.date(it.appStarredAt)}` : 'fremd') : it.distance ? Fmt.km(it.distance) : ''}</span></div>`).join('')}</div>` : '';
  let body = '';
  if (wahoo.stage === 'loading') body = '<div class="card"><span class="spin"></span> Aktuelle Sterne bei Strava laden…</div>';
  else if (wahoo.stage === 'failed') body = `<div class="card"><div class="section">Fehler</div><p>${esc(wahoo.note)}</p><button class="btn" data-act="wahooRetry">Erneut versuchen</button></div>`;
  else if (wahoo.stage === 'preview') body = `<div class="tiles three">${tile('Gesternt jetzt', String(pl.currentCount))}${tile('Limit', String(pl.limit), null, 'Wahoo zieht ~100')}${tile('Danach', String(pl.afterCount), pl.afterCount <= pl.limit ? ACCENT : Fmt.chance(0.1))}</div>
    ${pl.isEmpty ? `<div class="card"><div class="section">Nichts zu tun</div><p class="hint">${pl.alreadyStarred.length ? `Alle ${pl.alreadyStarred.length} geplanten Segmente sind bereits gesternt.` : 'Keine Segmente geplant.'}</p></div>` : list('Wird gesternt', pl.toStar, '★') + list('Wird entsternt', pl.toUnstar, '☆', true)}
    ${list('Bleibt (schon gesternt)', pl.alreadyStarred, '✓')}${list('Kein Platz unter dem Limit', pl.overLimit, '⚠')}
    <p class="hint">Dry-Run: Bis zur Bestätigung wird nichts bei Strava geändert. Wahoo übernimmt Sterne erst nach dem nächsten Strava-Sync.</p>
    ${pl.isEmpty ? '<button class="btn prominent" data-act="wahooChecklist">Weiter zur Checkliste</button>' : `<button class="btn prominent" data-act="wahooRun">Sync starten (${pl.toStar.length + pl.toUnstar.length} Änderungen)</button>`}`;
  else if (wahoo.stage === 'running') { const p = S.sync.progress || { done: 0, total: 1 }; body = `<div class="card"><div class="section">Sync läuft<span class="mono muted">${p.done}/${p.total}</span></div><progress value="${p.done}" max="${Math.max(1, p.total)}"></progress><p class="hint">${esc(S.sync.progressLabel)}</p><p class="hint">300 ms Pause je Änderung, damit Strava nicht drosselt.</p></div>`; }
  else if (wahoo.stage === 'done') { const r = wahoo.result; body = `<div class="tiles three">${tile('Gesternt', String(r.starred.length), ACCENT)}${tile('Entsternt', String(r.unstarred.length))}${tile('Übersprungen', String(r.skipped.length))}</div>${r.rateLimited ? '<div class="card"><div class="section">Strava-Rate-Limit (429)</div><p>Der Sync wurde abgebrochen; nach 15 Minuten erneut starten – bereits gesetzte Änderungen bleiben.</p></div>' : ''}${r.errors.length ? `<div class="card"><div class="section">Fehler</div>${r.errors.map(e => `<p class="hint">· ${esc(e.item.name)}: ${esc(e.message)}</p>`).join('')}</div>` : ''}<button class="btn prominent" data-act="wahooChecklist">Weiter zur Checkliste</button>`; }
  else if (wahoo.stage === 'checklist') {
    const step = (n, t, d) => `<div class="step"><span class="num">${n}</span><span><div>${t}</div><div class="hint">${d}</div></span></div>`;
    body = `<div class="card"><div class="section">Vor der Fahrt</div>${step(1, 'iPhone-Hotspot einschalten', 'Einstellungen → Persönlicher Hotspot. Der ELEMNT holt Live Segments über diese Verbindung.')}${step(2, 'ELEMNT einschalten, 60 s warten', 'Der Computer verbindet sich und synchronisiert Strava; das dauert bis zu einer Minute.')}${step(3, 'In der Wahoo-App Live Segments prüfen', 'Wahoo-App → Profil → Strava → Live Segments: Die gesternten Segmente müssen dort erscheinen.')}</div>
    <div class="card"><label class="statrow"><span>Vor der Fahrt erinnern</span><input type="checkbox" data-set="remind" ${wahoo.remind ? 'checked' : ''}></label>${wahoo.remind ? `<label class="statrow"><span>Uhrzeit</span><input type="datetime-local" data-set="remindAt" value="${localIso(wahoo.remindAt || defaultReminder())}"></label>` : ''}${wahoo.note ? `<p class="hint">${esc(wahoo.note)}</p>` : ''}<p class="hint">Erinnerung als Browser-Mitteilung, solange diese Seite geöffnet ist (Web-Apps dürfen auf dem iPhone keine Hintergrund-Mitteilungen planen).</p></div><button class="btn prominent" data-act="wahooFinish">Fertig</button>`;
  }
  o.innerHTML = `<div class="detail"><div class="sheethead"><button class="iconbtn" data-act="closeOverlay" ${wahoo.stage === 'running' ? 'disabled' : ''}>‹</button><b class="title">Auf Wahoo bringen</b><span></span></div><div class="pad">${body}</div></div>`;
}
function defaultReminder() { const d = new Date(Date.now() + 86400e3); d.setHours(7, 0, 0, 0); return d; }
let reminderTimer = null;
async function scheduleReminder(at) {
  if (!('Notification' in window)) return 'Mitteilungen werden von diesem Browser nicht unterstützt.';
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return 'Mitteilungen nicht erlaubt.';
  if (reminderTimer) clearTimeout(reminderTimer);
  const ms = at.getTime() - Date.now(); if (ms <= 0) return 'Zeitpunkt liegt in der Vergangenheit.';
  reminderTimer = setTimeout(() => new Notification('Wahoo Live Segments', { body: 'iPhone-Hotspot einschalten, ELEMNT starten und 60 s warten, dann in der Wahoo-App Live Segments prüfen.' }), Math.min(ms, 2147000000));
  return null;
}

// ---------- Aktionen ----------
let sheetHtml = null;
const actions = {
  clearError() { S.error = null; render(); },
  importHandover() { try { Auth.importHandover($('#handover').value); S.info = 'Anmeldung übernommen.'; S.requestLocation(); render(); } catch (e) { S.error = e.message; render(); } },
  async copyHandover() {
    const code = Auth.exportHandover(); if (!code) { S.error = 'Nicht verbunden.'; render(); return; }
    try { await navigator.clipboard.writeText(code); S.info = 'Übernahme-Code kopiert – in der Home-Bildschirm-App auf dem Startbildschirm einfügen.'; }
    catch { prompt('Übernahme-Code (kopieren):', code); }
    render();
  },
  saveCreds() { Auth.saveCredentials($('#cid').value, $('#csec').value); render(); },
  editCreds() { const c = Auth.cfg; Auth.saveCredentials('', ''); S.info = c.clientId ? `Bisherige Client-ID: ${c.clientId}` : null; render(); },
  login() { Auth.login(); },
  logout() { S.logout(); },
  go(h) { go(h); },
  closeOverlay() { closeOverlay(); },
  mapMode(m) { S.setSetting('mapMode', m); if ((m === 'planned' && S.selectedTour != null) || (m === 'ridden' && S.routeFilter != null)) S.clearContext(); const mm = maps['map-main']; if (mm) mm._framed = false; },
  styleCycle() { const i = MAP_STYLES.findIndex(x => x[0] === S.settings.mapStyle); S.setSetting('mapStyle', MAP_STYLES[(i + 1) % MAP_STYLES.length][0]); },
  locate() { S.requestLocation(); const m = maps['map-main']; if (m && S.location) m.setView(S.location, 11); },
  tourList() { sheetHtml = tourListSheet(); showSheet(); },
  closeSheet() { sheetHtml = null; showSheet(); },
  loadRoutes() { S.loadRouteList().then(() => { sheetHtml = sheetHtml && tourListSheet(); showSheet(); if (maps['map-main']) { maps['map-main']._fitAll = true; render(); } }); },
  loadActivityMap() { S.loadActivityMap().then(() => { sheetHtml = sheetHtml && tourListSheet(); showSheet(); if (maps['map-main']) { maps['map-main']._fitAll = true; render(); } }); },
  selectRoute(id) { sheetHtml = null; showSheet(); S.selectRoute(Number(id)); setTimeout(frameContext, 100); },
  selectTour(id) { sheetHtml = null; showSheet(); S.selectTour(Number(id)); setTimeout(frameContext, 100); },
  clearContext() { S.clearContext(); },
  selectAll() { for (const s of S.contextSegments) if (!S.selected.has(s.id)) S.toggle(s.id); },
  toggle(id) { S.toggle(Number(id)); },
  filter(f) { S.filter = f; render(); },
  showAll() { S.showAll = true; render(); },
  toggleShowAll() { S.showAll = !S.showAll; render(); },
  loadRecords() { S.loadRecords(); },
  starSelected() { (async () => { for (const s of S.selectedSegments) if (!s.starred) await S.setStar(s.id, true); })(); },
  loadStarred() { S.loadStarred(); }, loadActivities() { S.loadActivities(); }, loadPowerCurve() { S.loadPowerCurve(); }, explore() { S.tryExplore(); },
  refreshRecords(id) { S.refreshRecords(Number(id)); },
  reloadWind(id) { delete S.wind[Number(id)]; S.loadWind([Number(id)]); },
  setStar(id) { const s = S.segments[Number(id)]; S.setStar(s.id, !s.starred); },
  clearSelection() { S.selected.clear(); S.route = null; S.persist(); S.emit(); },
  planRoute() { S.planRoute(); },
  async shareGpx() { for (const [name, text] of S.buildGpx() || []) await shareGpx(name, text); },
  resetCurve() { S.resetPowerCurve(); },
  refreshStars() { S.run('Sterne laden…', () => S.sync.refreshStarred()); },
  unstarAll() { if (confirm('Alle von der App gesetzten Sterne bei Strava entfernen? Geschützte bleiben.')) S.sync.unstarAllAppStars().then(r => { S.info = r.starred.length + ' gesternt · ' + r.unstarred.length + ' entsternt' + (r.rateLimited ? ' · Rate-Limit' : ''); render(); }); },
  step(arg) { const [key, d] = arg.split('|'); const cur = key === 'riderKg' ? S.effectiveRiderKg : S.settings[key]; const lim = { riderKg: [40, 130], bikeKg: [5, 20], top10Percent: [1, 30], pessimismPct: [0, 20], avgSpeedKmh: [0, 40] }[key]; S.setSetting(key, Math.min(lim[1], Math.max(lim[0], Math.round((cur + Number(d)) * 10) / 10))); },
  clearCache() { if (confirm('Alle Segmente, Routen und Fahrten aus dem Browser löschen?')) S.clearCache(); },
  wahooRetry() { openWahoo(); },
  async wahooRun() { wahoo.stage = 'running'; render(); wahoo.result = await S.sync.execute(wahoo.plan); wahoo.stage = 'done'; render(); },
  wahooChecklist() { wahoo.stage = 'checklist'; render(); },
  async wahooFinish() { if (wahoo.remind) { const err = await scheduleReminder(wahoo.remindAt || defaultReminder()); if (err) { wahoo.note = err; render(); return; } } closeOverlay(); },
};
function showSheet() { const s = $('#sheet'); if (sheetHtml) { s.hidden = false; s.innerHTML = sheetHtml; } else { s.hidden = true; s.innerHTML = ''; } }

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.closest('details.menu'); if (d && el.tagName === 'BUTTON') d.open = false;
  const fn = actions[el.dataset.act]; if (fn) { e.preventDefault(); fn(el.dataset.arg); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.setting) { const v = el.value; S.setSetting(el.dataset.setting, isNaN(Number(v)) || el.dataset.setting === 'brouterProfile' ? v : Number(v)); return; }
  if (el.dataset.set === 'sort') { S.sort = el.value; render(); }
  else if (el.dataset.set === 'rideDate') { const d = new Date(el.value); if (!isNaN(d)) S.setRideDate(d); }
  else if (el.dataset.set === 'limit') { S.sync.setLimit(Number(el.value)); render(); }
  else if (el.dataset.set === 'remind') { wahoo.remind = el.checked; render(); }
  else if (el.dataset.set === 'remindAt') { const d = new Date(el.value); if (!isNaN(d)) wahoo.remindAt = d; }
  else if (el.dataset.protect) { S.sync.setProtected(Number(el.dataset.protect), el.checked); render(); }
});
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
window.addEventListener('hashchange', () => { if (overlay?.kind === 'wahoo') openWahoo(); });

// ---------- Start ----------
S.on(render);
(async () => {
  try { if (await Auth.handleRedirect()) S.info = 'Mit Strava verbunden.'; }
  catch (e) { S.error = e.message; }
  if (Auth.isLoggedIn) S.requestLocation();
  route();
  if (overlay?.kind === 'wahoo') openWahoo();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
