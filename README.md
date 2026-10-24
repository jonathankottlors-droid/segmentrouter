# SegmentRouter Web

Web-/PWA-Fassung der iOS-App SegmentRouter: machbare Strava-Segmente auf geplanten Routen oder gefahrenen Touren finden, Top-10-Chance aus eigener Leistungskurve und Physik schätzen, Wind zur Ankunftszeit einrechnen, Route per BRouter bauen, GPX an Garmin Connect / Wahoo geben, Live Segments per Sternen auf den Wahoo bringen.

Reines HTML/JS ohne Build-Schritt. Karten: Leaflet mit OpenTopoMap (Relief + Höhenlinien), OSM, Esri-Satellit. Alle Daten bleiben im Browser (`localStorage`), nichts läuft über einen eigenen Server.

## Einrichten

1. **Strava-API-App** unter <https://www.strava.com/settings/api> anlegen (eine je Account).
   *Authorization Callback Domain* = Domain, unter der die Web-App läuft, z. B. `jonathankottlors-droid.github.io` (für lokale Tests `localhost`).
2. Web-App öffnen, Client-ID und Client Secret eintragen (bleiben nur in diesem Browser), „Mit Strava verbinden“.
3. Auf dem iPhone: in Safari „Zum Home-Bildschirm“ → läuft als App im Vollbild.

Die iOS-App nutzt dieselbe Strava-App; ihr Redirect muss dann `segmentrouter://<dieselbe Domain>/callback` lauten.

## Lokal testen

```sh
python3 -m http.server 8768 --directory .
```

## Deploy

GitHub Pages aus `main` (Root). Nach Änderungen `VERSION` in `sw.js` erhöhen, damit installierte PWAs die neue Fassung ziehen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/model.js` | Polyline, Geometrie (inkl. Richtungsprüfung `Geo.traversal`), Physik, Leistungskurve (CP/W′, Mean-Max), Fahrerprofil, Chance, Formatierung |
| `js/state.js` | App-Zustand: Lader (Routen, Touren, Rekorde, Streams, Leistungskurve), Lage zur Route, Filter/Sortierung, ETA + Wind, Routenplanung |
| `js/strava.js` | OAuth (Code-Flow mit Token-Refresh), API-Client, Stern-Service |
| `js/wind.js` | Open-Meteo |
| `js/routing.js` | BRouter (Sperrkreise für separaten Rückweg), Nearest-Neighbour, GPX + Web Share |
| `js/sync.js` | Wahoo-Live-Segment-Sync (Limit, Schutzliste, Dry-Run) |
| `js/app.js` | Oberfläche: Touren-Karte, Segmentliste, Detail (Höhenprofil, Platzierung, Wind-Strömung), Route, Profil, Wahoo-Sheet |

## Grenzen

- Strava-API: keine Leaderboards (Top 10 = KOM + x %), Explore nur im Extended Access Tier, nur eigene Routen, 200 Reads / 15 min.
- Erinnerung vor der Fahrt läuft als Browser-Mitteilung nur bei geöffneter Seite (keine Hintergrund-Notifications in iOS-PWAs).
- Browser muss CORS zu `strava.com`, `brouter.de`, `open-meteo.com` erlauben (alle drei setzen die nötigen Header).
