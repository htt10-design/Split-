# Split 💸

Eine schlanke App, mit der zwei Personen gemeinsame Ausgaben eintragen und am Monatsende abrechnen,
ganz ohne gemeinsames Konto. Backend ist die bestehende **PocketBase (SGS-Plattform)**, die App selbst
besteht nur aus statischen Dateien (HTML/CSS/JS) und hat keine Abhängigkeiten.

- **Schnell eintragen:** Betrag, wofür, fertig (Standard: 50/50, heute, ich habe bezahlt)
- **Flexible Aufteilung:** Halbe-halbe · nur für die andere Person · individuell (z.B. 70/30)
- **Live-Kontostand:** „Du schuldest X 23,40 €“, und trägt die andere Person etwas ein, aktualisiert sich die Anzeige sofort (PocketBase Realtime, grüner Punkt oben)
- **Abrechnen:** ein Klick schließt alle offenen Ausgaben ab (atomar), danach startet ihr wieder bei 0
- **Verlauf** aller Abrechnungen mit Details, **CSV-Export**
- **Als App installierbar** (PWA), Hell/Dunkel-Modus, fürs Handy optimiert

```
public/                         die komplette App (statisch)
  config.js                     ← API-URL der PocketBase
pocketbase/split_collections.json   Collections + API-Regeln zum Importieren
```

---

## 1. PocketBase einrichten (Admin, intern über Tailscale)

Admin-UI: `https://heimserver.tail8f2780.ts.net/_/`

### a) Collections importieren
**Settings → Import collections** → Inhalt von [`pocketbase/split_collections.json`](pocketbase/split_collections.json)
einfügen (oder „Load from JSON file“).

> ⚠️ **Unbedingt den Schalter „Merge with the existing collections“ einschalten!**
> Ohne ihn ersetzt PocketBase *alle* Collections durch die eingefügte Liste, löscht also `users`,
> die Collections der anderen Apps und deren Daten.
> Kontrolle: Unter „Detected changes“ dürfen **nur vier Einträge „Added“** (`split_…`) stehen, kein „Deleted“.

Dann *Review* → *Confirm and import*.

Es werden vier Collections mit dem Präfix `split_` angelegt:

| Collection          | Inhalt                                             |
|---------------------|----------------------------------------------------|
| `split_groups`      | ein „Haushalt“ (ihr beide)                         |
| `split_members`     | wer gehört zum Haushalt + Anzeigename              |
| `split_expenses`    | die Ausgaben                                       |
| `split_settlements` | abgeschlossene Abrechnungen                        |

> Die Relationen zeigen auf die Auth-Collection `users` mit ihrer Standard-ID `_pb_users_auth_`.
> Falls eure `users`-Collection eine andere ID hat (steht in der Collection unter ⚙️), die ID in der
> JSON-Datei vor dem Import per Suchen/Ersetzen anpassen.

### b) Batch-API aktivieren (für „Abrechnen“)
**Settings → Application → Batch API**: aktivieren, *Max allowed batch requests* auf z.B. **500** setzen.
Eine Abrechnung = 1 Request + 1 pro offener Ausgabe. Alles läuft in **einer** Transaktion: Entweder wird
komplett abgerechnet oder gar nichts.

### c) Euch beide eintragen
1. Beide Benutzer existieren in `users` (Selbstregistrierung ist gesperrt, also über den Admin anlegen).
2. `split_groups` → *New record*: Name z.B. „Wir“.
3. `split_members` → zwei Einträge: jeweils `group` = dieser Haushalt, `user` = Person, `display_name` = Anzeigename.

Fertig. Login in der App erfolgt mit E-Mail + Passwort aus `users`.

### API-Regeln (Kurzfassung)

Alle Regeln setzen `@request.auth.id != ''` voraus **und** prüfen zusätzlich, dass der eingeloggte Benutzer
Mitglied des jeweiligen Haushalts ist. Andere Plattform-Benutzer sehen also nichts.

| Collection          | list / view | create | update | delete |
|---------------------|-------------|--------|--------|--------|
| `split_groups`      | Mitglied    | nur Admin | nur Admin | nur Admin |
| `split_members`     | Mitglied    | nur Admin | nur Admin | nur Admin |
| `split_expenses`    | Mitglied    | Mitglied; `created_by` = ich; Zahler ist Mitglied | Mitglied, nur solange **nicht abgerechnet**; Haushalt/Ersteller unveränderbar | Mitglied, nur solange nicht abgerechnet |
| `split_settlements` | Mitglied    | Mitglied; `created_by` = ich | nur Admin | nur Admin |

„nur Admin“ heißt: Regel ist **gesperrt** (`null`, das Schloss-Symbol in der Admin-UI), also nicht leer
und nicht öffentlich. Leere Regeln (= öffentlich) gibt es keine.

Getestet gegen PocketBase v0.40.6, Import über die Admin-UI (u.a.: Fremde sehen/ändern nichts, falscher Zahler/Ersteller wird
abgelehnt, abgerechnete Ausgaben sind gesperrt, Abrechnung wird bei Fehler komplett zurückgerollt).

---

## 2. App ausliefern (öffentlich, ohne Tailscale-Client)

Die App sind nur die Dateien in `public/`. Sie spricht direkt mit der öffentlichen API
`https://heimserver.tail8f2780.ts.net:10000` (eingetragen in `public/config.js`).


### GitHub Pages (eingerichtet)
Die App liegt unter **https://htt10-design.github.io/Split-/**.
Jeder Push auf `main` veröffentlicht den Ordner `public/` automatisch neu
(Workflow `.github/workflows/pages.yml`). Einmalig nötig:
1. Repo → *Settings → General → Default branch*: **main**
2. Repo → *Settings → Pages → Build and deployment → Source*: **GitHub Actions**

Port 10000 (Funnel) bleibt ausschließlich für `/api`.

### Alternative: beliebiger anderer Webspace
Einfach den Inhalt von `public/` hochladen (Netlify, Cloudflare Pages, …).

> CORS: PocketBase erlaubt standardmäßig alle Origins. Falls die Plattform mit `--origins` gestartet wird,
> muss die Adresse der App dort ergänzt werden (Origin von GitHub Pages: `https://htt10-design.github.io`).

---

## 3. Auf dem Handy installieren

- **iPhone (Safari):** App-Adresse öffnen → Teilen → „Zum Home-Bildschirm“
- **Android (Chrome):** App-Adresse öffnen → ⋮ → „App installieren“

Die Anmeldung wird beim Öffnen automatisch verlängert (Token-Refresh).

## 4. Lokal entwickeln

```bash
cd public && python3 -m http.server 8080   # http://localhost:8080
```
Für eine lokale PocketBase `apiUrl` in `public/config.js` anpassen.

---

## So wird gerechnet

Jede Ausgabe speichert, wer bezahlt hat und welchen Anteil (%) der Zahler **selbst** trägt (`payer_share`):

| Aufteilung          | `payer_share` | Die andere Person schuldet |
|---------------------|---------------|----------------------------|
| Halbe-halbe         | 50            | 50 % des Betrags           |
| Nur für die andere  | 0             | 100 % des Betrags          |
| Individuell (70/30) | 70            | 30 % des Betrags           |

Alle offenen Ausgaben werden verrechnet, am Ende bleibt **eine** Zahl: wer wem wie viel überweist.
Ab dem 1. eines Monats erscheint oben ein Hinweis „Abrechnung <Monat>“: Er rechnet nur die Ausgaben bis Ende des Vormonats ab (nach Ausgabedatum), Einträge aus dem laufenden Monat bleiben offen. Nach der Überweisung „Erledigt“ tippen. Der Button „Abrechnen“ in der Liste rechnet dagegen alles Offene ab.
Beim Abrechnen gilt: Es entsteht ein Eintrag in `split_settlements`, und alle
offenen Ausgaben werden ihm zugeordnet (`settlement`). Beträge werden in Cent gespeichert (`amount_cents`).
