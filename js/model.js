// Modell: Geometrie, Polyline, Physik, Leistungskurve, Fahrerprofil, Chance – 1:1 aus der iOS-App portiert.

export const Config = {
  routeCorridorM: 600,
  crr: 0.0045, cda: 0.32, rho: 1.2, drivetrain: 0.975,
  defaultRiderKg: 75, defaultBikeKg: 8.5,
  windHeightFactor: 0.75,
  powerCurveRides: 15,
  defaultPessimismPct: 5,
  brouterBase: 'https://brouter.de/brouter',
  brouterProfiles: ['fastbike', 'trekking', 'shortest'],
  exploreHalfSpan: 0.15,
};

// ---------- Polyline (Google encoded) ----------
export function decodePolyline(str) {
  if (!str) return null;
  const out = []; let lat = 0, lng = 0, i = 0;
  const read = () => {
    let shift = 0, value = 0, b;
    do { if (i >= str.length) return null; b = str.charCodeAt(i++) - 63; value |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return (value & 1) ? ~(value >> 1) : (value >> 1);
  };
  while (i < str.length) {
    const dLat = read(); if (dLat == null) break;
    const dLng = read(); if (dLng == null) break;
    lat += dLat; lng += dLng;
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out.length ? out : null;
}

// ---------- Geo ([lat, lng]) ----------
const R = 6371000, D2R = Math.PI / 180;
export const Geo = {
  distanceM(a, b) {
    const dLat = (b[0] - a[0]) * D2R, dLng = (b[1] - a[1]) * D2R;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  },
  fast(p, q, cosLat) { const dx = (q[1] - p[1]) * cosLat, dy = q[0] - p[0]; return Math.sqrt(dx * dx + dy * dy) * 111320; },
  bearing(a, b) {
    const p1 = a[0] * D2R, p2 = b[0] * D2R, dl = (b[1] - a[1]) * D2R;
    return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  },
  nearestIndex(p, pts) {
    const c = Math.cos(p[0] * D2R); let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) { const dx = (pts[i][1] - p[1]) * c, dy = pts[i][0] - p[0]; const d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = i; } }
    return [best, Math.sqrt(bd) * 111320];
  },
  minDistanceM(p, pts) { return this.nearestIndex(p, pts)[1]; },
  cumulative(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + this.distanceM(pts[i - 1], pts[i])); return c; },
  bounds(pts) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]); }
    return pts.length ? [[minLat, minLng], [maxLat, maxLng]] : null;
  },
  resample(pts, count) {
    if (pts.length < 2 || count < 2) return pts;
    const cum = this.cumulative(pts), total = cum[cum.length - 1];
    if (total <= 0) return [pts[0], pts[pts.length - 1]];
    const out = []; let j = 1;
    for (let k = 0; k < count; k++) {
      const target = total * k / (count - 1);
      while (j < cum.length - 1 && cum[j] < target) j++;
      const a = pts[j - 1], b = pts[j], t = cum[j] > cum[j - 1] ? (target - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  },
  /// Folgt dem Segment entlang der Route; steigende Indizes = in Fahrtrichtung. Vorwärts gewinnt bei Hin+Rück.
  traversal(seg, route, cum, corridor) {
    if (seg.length < 2 || route.length < 2 || cum.length !== route.length) return { kind: 'none' };
    const cosLat = Math.cos(seg[0][0] * D2R);
    const samples = this.resample(seg, 8);
    let segLen = 0; for (let i = 1; i < samples.length; i++) segLen += this.fast(samples[i - 1], samples[i], cosLat);
    const window = segLen / 7 * 3 + 400;
    const cands = []; let runBest = null, lastIn = -1;
    for (let i = 0; i < route.length; i++) {
      const d = this.fast(samples[0], route[i], cosLat);
      if (d <= corridor) {
        if (lastIn >= 0 && cum[i] - cum[lastIn] > 300 && runBest) { cands.push(runBest[0]); runBest = null; }
        if (!runBest || d < runBest[1]) runBest = [i, d];
        lastIn = i;
      }
    }
    if (runBest) cands.push(runBest[0]);
    if (!cands.length) return { kind: 'none' };
    let best = null;
    for (const c of cands) {
      let idx = c, err = 0, delta = 0, ok = true;
      for (let k = 1; k < samples.length; k++) {
        let lo = idx, hi = idx;
        while (lo > 0 && cum[idx] - cum[lo - 1] <= window) lo--;
        while (hi < route.length - 1 && cum[hi + 1] - cum[idx] <= window) hi++;
        let bi = idx, bd = Infinity;
        for (let j = lo; j <= hi; j++) { const d = this.fast(samples[k], route[j], cosLat); if (d < bd) { bd = d; bi = j; } }
        if (bd > corridor) { ok = false; break; }
        err += bd; delta += bi - idx; idx = bi;
      }
      if (!ok || delta === 0) continue;
      const dir = delta > 0 ? 1 : -1;
      if (!best || (dir === 1 && best.dir === -1) || (dir === best.dir && err < best.err)) best = { dir, pos: cum[c], err };
    }
    if (!best) return { kind: 'none' };
    return { kind: best.dir === 1 ? 'forward' : 'backward', posM: best.pos };
  },
  directionMarkers(pts, count = 12) {
    if (pts.length < 2) return [];
    const cum = this.cumulative(pts), total = cum[cum.length - 1];
    if (total < 50) return [];
    const out = []; let j = 1;
    for (let k = 0; k < count; k++) {
      const target = total * (k + 0.5) / count;
      while (j < cum.length - 1 && cum[j] < target) j++;
      const a = pts[j - 1], b = pts[j], t = cum[j] > cum[j - 1] ? (target - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
      out.push({ coord: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearingDeg: this.bearing(a, b) / D2R });
    }
    return out;
  },
};

// ---------- Segment-Helfer (Segmente sind einfache Objekte) ----------
export const Seg = {
  gain(distance, grade, high, low, total) {
    if (total > 0) return total;
    if (high != null && low != null && high > low && grade > 0) return high - low;
    return Math.max(0, distance * grade / 100);
  },
  coords(s) { const p = decodePolyline(s.polyline); return p && p.length >= 2 ? p : [s.start, s.end]; },
  mid(s) { const c = this.coords(s); return c.length > 2 ? c[c.length >> 1] : [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2]; },
  ridden(s) { return (s.efforts && s.efforts.length > 0) || s.prSeconds != null; },
  bestSeconds(s) {
    const e = s.efforts?.length ? Math.min(...s.efforts.map(x => x.elapsed)) : null;
    if (e != null && s.prSeconds != null) return Math.min(e, s.prSeconds);
    return e ?? s.prSeconds ?? null;
  },
  bestEffort(s) { return s.efforts?.length ? s.efforts.reduce((a, b) => a.elapsed < b.elapsed ? a : b) : null; },
  hasRecords(s) { return s.komSeconds != null; },
  bestKomRank(s) { const r = (s.efforts || []).map(e => e.komRank).filter(x => x != null); return r.length ? Math.min(...r) : null; },
  komGap(s) { const b = this.bestSeconds(s); return b != null && s.komSeconds != null ? b - s.komSeconds : null; },
  onPodium(s) { return this.bestKomRank(s) != null || (this.komGap(s) ?? 1) <= 0; },
  knownRank(s) { const g = this.komGap(s); if (g != null && g <= 0) return 1; return this.bestKomRank(s); },
  top10Seconds(s, pct) { return s.komSeconds != null ? Math.round(s.komSeconds * (1 + pct / 100)) : null; },
  recordsStale(s) { return !s.recordsUpdated || Date.now() - s.recordsUpdated > 7 * 86400e3; },
  /// Gegenwind-Komponente in m/s (längengewichtet), auf Fahrerhöhe reduziert. + gegen, − mit.
  headwind(s, w) {
    const pts = this.coords(s); if (pts.length < 2) return 0;
    const from = w.fromDeg * D2R; let num = 0, den = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Geo.distanceM(pts[i - 1], pts[i]); if (len <= 1) continue;
      num += Math.cos(from - Geo.bearing(pts[i - 1], pts[i])) * len; den += len;
    }
    return den > 0 ? w.speed * Config.windHeightFactor * num / den : 0;
  },
};

// ---------- Physik & Leistung ----------
export const Physics = {
  windExposure(gradePct) { return gradePct <= 0 ? 1 : Math.max(0.35, 1 - 0.07 * gradePct); },
  watts(distance, gradePct, seconds, totalKg, headwind = 0) {
    const v = distance / Math.max(seconds, 1), theta = Math.atan(gradePct / 100), vAir = v + headwind;
    const aero = 0.5 * Config.rho * Config.cda * vAir * Math.abs(vAir) * v;
    const p = v * totalKg * 9.81 * (Math.sin(theta) + Config.crr * Math.cos(theta)) + aero;
    return Math.max(0, p / Config.drivetrain);
  },
  achievableSeconds(distance, gradePct, totalKg, power, headwind = 0, capacityFactor = 1) {
    let lo = distance / (70 / 3.6), hi = distance / (3 / 3.6);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (this.watts(distance, gradePct, mid, totalKg, headwind) > power.capacity(mid) * capacityFactor) lo = mid; else hi = mid;
    }
    return Math.max(1, Math.round(hi));
  },
};

export const DURATIONS = [5, 15, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600];

export class PowerModel {
  /// efforts: [{seconds, watts, device}], curve: [{seconds, watts}]. null, wenn zu wenig Daten.
  static make(efforts, curve = []) {
    const device = efforts.filter(e => e.device);
    const pool = device.length >= 5 ? device : efforts;
    const valid = pool.filter(e => e.watts > 50 && e.seconds >= 30 && e.seconds <= 7200);
    if (valid.length < 3 && curve.length < 3) return null;
    const m = new PowerModel();
    m.usesDeviceWatts = device.length >= 5 || curve.length > 0;
    m.fromStreams = curve.length > 0;
    m.sampleCount = valid.length;
    m.envelope = [];
    for (const d of DURATIONS) {
      const fe = valid.filter(e => e.seconds >= d * 0.85).map(e => e.watts);
      const fc = curve.find(c => c.seconds === d)?.watts;
      const cands = [...(fe.length ? [Math.max(...fe)] : []), ...(fc != null ? [fc] : [])];
      if (cands.length) m.envelope.push({ seconds: d, watts: Math.max(...cands) });
    }
    const pts = m.envelope.filter(p => p.seconds >= 120);
    if (pts.length >= 3) {
      const xs = pts.map(p => 1 / p.seconds), ys = pts.map(p => p.watts), n = pts.length;
      const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
      m.wPrime = Math.min(Math.max(sxx > 0 ? sxy / sxx : 15000, 4000), 40000);
      m.cp = Math.min(Math.max(my - m.wPrime * mx, 80), 550);
    } else if (m.envelope.length) {
      m.cp = Math.max(80, m.envelope[m.envelope.length - 1].watts * 0.95); m.wPrime = 15000;
    } else { m.cp = 200; m.wPrime = 15000; }
    return m;
  }
  capacity(t) {
    const model = this.cp + this.wPrime / Math.max(t, 30);
    const obs = this.envelope.filter(p => p.seconds >= t * 0.85).map(p => p.watts);
    return Math.max(model, obs.length ? Math.max(...obs) : 0);
  }
  /// Mean-Max aus Watt/Zeit-Stream (1-s-Raster, Lücken gehalten).
  static meanMax(watts, time) {
    const series = []; let lastT = -1, lastW = 0;
    for (let i = 0; i < time.length; i++) {
      const t = time[i]; if (t == null) continue; const w = watts[i] ?? 0;
      if (lastT < 0) { series.push(w); lastT = t; lastW = w; continue; }
      const gap = Math.floor(t - lastT); if (gap <= 0) continue;
      if (gap > 1) for (let g = 1; g < gap; g++) series.push(gap > 30 ? 0 : lastW);
      series.push(w); lastT = t; lastW = w;
    }
    if (series.length <= 10) return [];
    const prefix = [0]; for (const w of series) prefix.push(prefix[prefix.length - 1] + w);
    const out = [];
    for (const d of DURATIONS) {
      const n = d; if (n >= series.length) continue;
      let best = 0; for (let i = 0; i + n <= series.length; i++) best = Math.max(best, (prefix[i + n] - prefix[i]) / n);
      if (best > 0) out.push({ seconds: d, watts: best });
    }
    return out;
  }
}

const BIN_EDGES = [-100, -3, 0, 2, 4, 6, 8, 10, 100];
export const BIN_LABELS = ['< -3', '-3–0', '0–2', '2–4', '4–6', '6–8', '8–10', '> 10'];
function percentile(vals, p) { if (!vals.length) return null; const s = [...vals].sort((a, b) => a - b); return s[Math.round((s.length - 1) * p)]; }

export class RiderProfile {
  constructor(segments, { riderKg = Config.defaultRiderKg, bikeKg = Config.defaultBikeKg, top10Percent = 6, curve = [], pessimismPct = Config.defaultPessimismPct } = {}) {
    this.riderKg = riderKg; this.bikeKg = bikeKg; this.top10Percent = top10Percent;
    this.capacityFactor = Math.max(0.5, 1 - pessimismPct / 100);
    const s = [], pw = [];
    for (const seg of segments) {
      for (const e of seg.efforts || []) {
        if (e.elapsed > 0 && seg.distance > 50) {
          s.push({ grade: seg.avgGrade, distance: seg.distance, gain: seg.elevGain, seconds: e.elapsed });
          if (e.watts != null) pw.push({ seconds: e.elapsed, watts: e.watts, device: !!e.deviceWatts });
        }
      }
      if (!(seg.efforts || []).length && seg.prSeconds > 0 && seg.distance > 50) s.push({ grade: seg.avgGrade, distance: seg.distance, gain: seg.elevGain, seconds: seg.prSeconds });
    }
    this.power = PowerModel.make(pw, curve);
    this.samples = s;
    this.p90Grade = percentile(s.map(x => x.grade), 0.9);
    this.maxGain = s.length ? Math.max(...s.map(x => x.gain)) : null;
    this.maxDistance = s.length ? Math.max(...s.map(x => x.distance)) : null;
    const bins = BIN_LABELS.map(() => []);
    for (const x of s) { const kmh = x.distance / x.seconds * 3.6; if (kmh > 3 && kmh < 90) bins[RiderProfile.binIndex(x.grade)].push(kmh); }
    this.speedByBin = bins.map(b => b.length >= 2 ? percentile(b, 0.5) : null);
  }
  get hasEnoughData() { return this.samples.length >= 5; }
  static binIndex(g) { for (let i = 0; i < BIN_EDGES.length - 1; i++) if (g < BIN_EDGES[i + 1]) return i; return BIN_EDGES.length - 2; }
  speedKmh(g) {
    const i = RiderProfile.binIndex(g);
    if (this.speedByBin[i] != null) return this.speedByBin[i];
    const nb = [i - 1, i + 1].filter(j => j >= 0 && j < this.speedByBin.length).map(j => this.speedByBin[j]).filter(v => v != null);
    if (nb.length) return nb.reduce((a, b) => a + b) / nb.length;
    const flat = this.speedByBin[2] ?? this.speedByBin[3] ?? 28, scale = flat / 28;
    const generic = g <= 0 ? 32 + Math.min(10, -g * 2) : Math.max(7, 30 - 2.6 * g);
    return generic * scale;
  }
  modelSeconds(seg, headwind = 0) {
    if (this.power) return Physics.achievableSeconds(seg.distance, seg.avgGrade, this.riderKg + this.bikeKg, this.power, headwind, this.capacityFactor);
    const v = this.speedKmh(seg.avgGrade) / 3.6;
    const windFactor = 1 + headwind * 0.04 * Math.max(0.2, 1 - seg.avgGrade / 10);
    return Math.round(seg.distance / v * Math.max(0.6, windFactor));
  }
  /// Immer erst windstill (Anzeige/Sortierung); Wind nur als separater Effekt.
  feasibility(seg, headwind = null) {
    const est = this.modelSeconds(seg, 0);
    const exposure = Physics.windExposure(seg.avgGrade);
    const effHw = headwind != null ? headwind * exposure : null;
    const estWind = effHw != null ? this.modelSeconds(seg, effHw) : null;
    let f;
    const kom = seg.komSeconds, t10 = Seg.top10Seconds(seg, this.top10Percent), best0 = Seg.bestSeconds(seg);
    if (this.power && kom != null && t10 != null) {
      const prob = (target, time) => { const b = Math.min(time, best0 ?? time); return 1 / (1 + Math.exp(-(target - b) / (0.045 * target))); };
      const kg = this.riderKg + this.bikeKg;
      const req10 = Physics.watts(seg.distance, seg.avgGrade, t10, kg), reqK = Physics.watts(seg.distance, seg.avgGrade, kom, kg);
      const cap = this.power.capacity(t10) * this.capacityFactor;
      const reasons = [`Modellzeit windstill ${Fmt.time(est)}` + (best0 != null ? ` · deine Bestzeit ${Fmt.time(best0)}` : '')];
      if (this.capacityFactor < 1) reasons.push(`Kapazität konservativ mit ${Math.round(this.capacityFactor * 100)} % deiner Bestwerte angesetzt`);
      if (!this.power.usesDeviceWatts) reasons.push('Leistung aus Strava-Schätzung – kein Powermeter erkannt');
      f = { kind: 'power', score: prob(t10, est), estimatedSeconds: est, reasons, top10Probability: prob(t10, est), komProbability: prob(kom, est),
            requiredWattsTop10: req10, requiredWattsKom: reqK, capacityWattsTop10: cap };
      if (estWind != null) f.windScore = prob(t10, estWind);
    } else if (this.hasEnoughData && this.p90Grade != null) {
      const reasons = []; let gs = 1, gn = 1, ds = 1;
      if (seg.avgGrade > this.p90Grade) { gs = Math.max(0, 1 - (seg.avgGrade - this.p90Grade) / 4); reasons.push(`Ø ${seg.avgGrade.toFixed(1)} % liegt über deinem 90. Perzentil (${this.p90Grade.toFixed(1)} %)`); }
      const gainRef = this.maxGain * 1.15; if (seg.elevGain > gainRef) { gn = Math.max(0, 1 - (seg.elevGain - gainRef) / (this.maxGain * 0.5 + 50)); reasons.push(`${Math.round(seg.elevGain)} hm, dein Maximum war ${Math.round(this.maxGain)} hm`); }
      const distRef = this.maxDistance * 1.3; if (seg.distance > distRef) { ds = Math.max(0, 1 - (seg.distance - distRef) / (this.maxDistance + 1000)); reasons.push(`${(seg.distance / 1000).toFixed(1)} km lang, dein längstes Segment war ${(this.maxDistance / 1000).toFixed(1)} km`); }
      let score = gs * 0.5 + gn * 0.3 + ds * 0.2; if (Math.min(gs, gn, ds) === 0) score = Math.min(score, 0.3);
      if (Seg.ridden(seg)) { reasons.unshift('Bereits gefahren'); score = Math.max(score, 0.75); }
      if (kom == null) reasons.push('Für die Top-10-Chance „Rekorde“ laden (KOM-Zeit fehlt)'); else if (!this.power) reasons.push('Für die Top-10-Chance fehlt die Leistungskurve – im Profil laden');
      f = { kind: 'rule', score, estimatedSeconds: est, reasons };
    } else {
      const ok = seg.avgGrade <= 8 && seg.elevGain <= 300;
      f = { kind: 'rule', score: ok ? 0.6 : 0.3, estimatedSeconds: est, reasons: ['Zu wenig Effort-Historie – „Fahrten“ laden'] };
    }
    f.hasChance = f.kind === 'power';
    if (headwind != null && estWind != null) {
      f.headwind = headwind; f.effectiveHeadwind = effHw; f.windSeconds = estWind; f.windDelta = estWind - est;
      if (Math.abs(headwind) >= 0.3) f.reasons.push(`Wind: ${headwind > 0 ? 'Gegenwind' : 'Rückenwind'} ${Math.abs(headwind).toFixed(1)} m/s, am Berg zu ${Math.round(exposure * 100)} % wirksam → ${Fmt.time(estWind)} statt ${Fmt.time(est)}` + (f.windScore != null ? ` · Top-10-Chance ${Math.round(f.windScore * 100)} %` : ''));
    }
    return f;
  }
}

// ---------- Format ----------
export const Fmt = {
  km: m => `${(m / 1000).toFixed(1)} km`,
  kmShort: m => m < 950 ? `${Math.round(m)} m` : `${Math.round(m / 1000)} km`,
  hm: m => `${Math.round(m)} hm`,
  grade: g => `${g.toFixed(1)} %`,
  time: s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; },
  gap: s => s === 0 ? '0:00' : (s > 0 ? '+' : '−') + Fmt.time(Math.abs(s)),
  gapPercent: p => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)} %`,
  date: d => d ? new Date(d).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }) : '–',
  dateTime: d => d ? new Date(d).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–',
  parseClock(raw) {
    if (!raw) return null; let s = String(raw).trim(); if (!s) return null;
    if (s.endsWith('s')) { const n = parseInt(s.slice(0, -1), 10); return isNaN(n) ? null : n; }
    const parts = s.split(':').map(x => parseInt(x, 10)); if (parts.some(isNaN)) return null;
    return parts.reduce((a, b) => a * 60 + b, 0);
  },
  parseDate(raw) { if (!raw) return null; const t = Date.parse(raw); return isNaN(t) ? null : t; },
  /// Chance 0…1 → Rot → Gelb → Grün
  chance(score) {
    const s = Math.min(Math.max(score, 0), 1);
    const r = s < 0.5 ? 0.90 : 0.90 - (s - 0.5) * 2 * 0.60, g = s < 0.5 ? 0.25 + s * 2 * 0.55 : 0.80, b = s < 0.5 ? 0.20 : 0.20 + (s - 0.5) * 2 * 0.15;
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  },
  windColor(component) { const t = Math.min(1, Math.max(-1, component / 4)); return Fmt.chance(0.5 - t * 0.5); },
  compass(deg) { return ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.floor(((deg + 22.5) % 360) / 45) % 8]; },
};
