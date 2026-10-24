// Windvorhersage über Open-Meteo (frei, kein Key): stündlich, 7 Tage, Wind 10 m.
export async function windAt(lat, lon, date) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m', wind_speed_unit: 'ms', timezone: 'UTC', forecast_days: '7',
  });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Windvorhersage: HTTP ${r.status}`);
  const j = await r.json(), h = j.hourly;
  let best = -1, bd = Infinity;
  const target = date.getTime();
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i] + 'Z'); const d = Math.abs(t - target);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || h.wind_speed_10m[best] == null || h.wind_direction_10m[best] == null) return null;
  return { speed: h.wind_speed_10m[best], gust: h.wind_gusts_10m[best], fromDeg: h.wind_direction_10m[best], time: Date.parse(h.time[best] + 'Z') };
}
