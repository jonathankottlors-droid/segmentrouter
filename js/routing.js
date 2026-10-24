// BRouter-Client, Routenplanung (Nearest Neighbour, Rückweg mit Sperrkreisen) und GPX.
import { Config, Geo, Seg } from './model.js';

export async function brouterRoute(points, profile, nogos = []) {
  const u = new URL(Config.brouterBase);
  const q = { lonlats: points.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join('|'), profile, alternativeidx: '0', format: 'geojson' };
  if (nogos.length) q.nogos = nogos.map(n => `${n.coord[1].toFixed(6)},${n.coord[0].toFixed(6)},${Math.round(n.radiusM)}`).join('|');
  u.search = new URLSearchParams(q);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`BRouter HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const fc = await r.json();
  const f = fc.features?.[0];
  if (!f || f.geometry.coordinates.length < 2) throw new Error('BRouter hat keine Route geliefert.');
  const track = f.geometry.coordinates.map(c => ({ lat: c[1], lon: c[0], ele: c.length > 2 ? c[2] : null }));
  return { track, lengthM: parseFloat(f.properties['track-length'] || '0') || 0, ascendM: parseFloat(f.properties['filtered ascend'] || '0') || 0 };
}

export const Planner = {
  order(segs, start) {
    const remaining = [...segs], ordered = []; let pos = start;
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      remaining.forEach((s, i) => { const d = Geo.distanceM(pos, s.start); if (d < bd) { bd = d; bi = i; } });
      const s = remaining.splice(bi, 1)[0]; ordered.push(s); pos = s.end;
    }
    return ordered;
  },
  waypoints(start, segments, roundTrip) {
    const pts = [start];
    for (const s of segments) { const c = Seg.coords(s); pts.push(c[0]); if (c.length > 4) pts.push(c[c.length >> 1]); pts.push(c[c.length - 1]); }
    if (roundTrip) pts.push(start);
    return pts;
  },
  nogos(segments, keepClear, radiusM = 60, maxCount = 80) {
    let out = [];
    for (const s of segments) {
      const c = Seg.coords(s), step = Math.max(1, Math.floor(c.length / 8));
      for (let i = 0; i < c.length; i += step) { const p = c[i]; if (keepClear.some(k => Geo.distanceM(k, p) < radiusM + 120)) continue; out.push({ coord: p, radiusM }); }
    }
    if (out.length > maxCount) { const step = out.length / maxCount; out = Array.from({ length: maxCount }, (_, i) => out[Math.floor(i * step)]); }
    return out;
  },
};

export function gpx(track, segments, name) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="SegmentRouter" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name></metadata>\n`;
  segments.forEach((s, i) => { out += `<wpt lat="${s.start[0].toFixed(6)}" lon="${s.start[1].toFixed(6)}"><name>${esc(`${i + 1}. ${s.name}`)}</name><type>Segment</type></wpt>\n`; });
  out += `<trk><name>${esc(name)}</name><trkseg>\n`;
  for (const p of track) out += p.ele != null ? `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>\n` : `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>\n`;
  return out + '</trkseg></trk>\n</gpx>\n';
}

/// GPX weitergeben: auf dem iPhone per Share-Sheet (Garmin Connect / Wahoo), sonst Download.
export async function shareGpx(filename, text) {
  const file = new File([text], filename, { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
