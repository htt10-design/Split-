# Split 💸

Eine schlanke, selbst gehostete App, mit der zwei Personen gemeinsame Ausgaben eintragen und
am Monatsende abrechnen, ganz ohne gemeinsames Konto.

- **Schnell eintragen:** Betrag, wofür, wer bezahlt hat, fertig (Standard: 50/50, heute, eigene Person)
- **Flexible Aufteilung:** Halbe-halbe · nur für die andere Person · individuell (z.B. 70/30)
- **Live-Kontostand:** „Du schuldest X 23,40 €“ bzw. „X schuldet dir …“
- **Abrechnen:** ein Klick schließt alle offenen Ausgaben ab, danach startet ihr wieder bei 0
- **Verlauf:** alle bisherigen Abrechnungen inkl. Details und Kategorie-Übersicht
- **CSV-Export** aller Ausgaben
- **Als App installierbar** (PWA): im Browser „Zum Home-Bildschirm“ wählen, dann läuft sie wie eine native App
- Hell/Dunkel-Modus automatisch, optimiert fürs Handy

**Technik:** Node.js (≥ 22.13) mit eingebautem SQLite, **keine npm-Abhängigkeiten**.
Die gesamte Datenbank ist eine einzige Datei (`split.db`).

---

## 1. Schnellstart mit Docker (auf dem Server)

```bash
git clone https://github.com/htt10-design/Split-.git split
cd split
cp .env.example .env
nano .env            # Namen + Passwörter für euch beide setzen
docker compose up -d --build
```

Die App läuft jetzt auf dem Server unter `http://127.0.0.1:3000` (absichtlich nur lokal).
Wie sie von außen erreichbar wird, steht im nächsten Abschnitt.

Passwort ändern: in `.env` anpassen und `docker compose up -d` ausführen. Die Person wird dann
auf allen Geräten abgemeldet.

## 2. Zugriff von außen, ohne Tailscale

Deine Freundin soll die App einfach über eine normale Adresse wie `https://split.deine-domain.de`
im Browser öffnen können. Dafür gibt es zwei Wege:

### Variante A: Cloudflare Tunnel (empfohlen)

✅ Keine Portfreigabe am Router · ✅ automatisch HTTPS · ✅ kostenlos · ✅ IP des Servers bleibt verborgen
➖ Du brauchst eine eigene Domain, die bei Cloudflare verwaltet wird (ab ca. 1 €/Jahr, z.B. `.de` oder `.xyz`)

1. Domain bei Cloudflare hinzufügen (kostenloser Plan reicht).
2. Im Cloudflare-Dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel** → Typ *Cloudflared*.
3. Den angezeigten **Token** kopieren und in `.env` bei `CLOUDFLARE_TUNNEL_TOKEN=` eintragen.
4. Im Tunnel unter **Public Hostname** hinzufügen:
   - Subdomain: `split`, Domain: `deine-domain.de`
   - Service: `HTTP` → `split:3000`
5. Starten:
   ```bash
   docker compose --profile tunnel up -d
   ```

Fertig, die App ist unter `https://split.deine-domain.de` erreichbar.

> **Optional, noch mehr Sicherheit:** Unter *Zero Trust → Access → Applications* lässt sich davor
> eine zusätzliche Hürde schalten, z.B. „nur diese zwei E-Mail-Adressen“ (Login per Code an die E-Mail).

### Variante B: Portfreigabe + Caddy (eigener Reverse-Proxy)

Falls du keine Cloudflare-Domain willst: Port 80/443 am Router auf den Server weiterleiten,
eine (Dyn)DNS-Adresse einrichten und [Caddy](https://caddyserver.com) davor setzen.
Caddy holt sich das HTTPS-Zertifikat automatisch. Beispiel-`Caddyfile`:

```
split.deine-domain.de {
    reverse_proxy 127.0.0.1:3000
}
```

In `.env` muss dabei `TRUST_PROXY=1` stehen (Standard).

> ⚠️ Die App bitte **nie ohne HTTPS** ins Internet stellen, sonst gehen Passwörter im Klartext übers Netz.

## 3. Auf dem Handy installieren

- **iPhone (Safari):** Adresse öffnen → Teilen-Symbol → „Zum Home-Bildschirm“
- **Android (Chrome):** Adresse öffnen → ⋮ → „App installieren“ / „Zum Startbildschirm hinzufügen“

Der Login bleibt 180 Tage gespeichert.

## 4. Backup

Die Daten liegen im Docker-Volume `split-data`. Ein Backup als Datei:

```bash
docker compose exec split sh -c "rm -f /data/backup.db && node -e \"new (require('node:sqlite').DatabaseSync)('/data/split.db').exec('VACUUM INTO \\'/data/backup.db\\'')\""
docker cp split:/data/backup.db ./split-backup-$(date +%F).db
```

Zusätzlich bekommst du über das Menü (⋯) → **CSV exportieren** jederzeit alle Ausgaben als Tabelle.

## 5. Lokale Entwicklung (ohne Docker)

```bash
cp .env.example .env   # PORT=3000, TRUST_PROXY=0
npm run dev            # http://localhost:3000
```

---

## So wird gerechnet

Jede Ausgabe speichert, wer bezahlt hat und welchen Anteil (in %) der Zahler **selbst** trägt:

| Aufteilung          | Anteil Zahler | Die andere Person schuldet |
|---------------------|---------------|----------------------------|
| Halbe-halbe         | 50 %          | 50 % des Betrags           |
| Nur für die andere  | 0 %           | 100 % des Betrags          |
| Individuell (70/30) | 70 %          | 30 % des Betrags           |

Alle offenen Ausgaben werden verrechnet, und am Ende bleibt **eine** Zahl: wer wem wie viel überweist.
Nach der Überweisung auf „Abrechnen“ tippen, dann wandern die Ausgaben ins Archiv.

## Projektstruktur

```
src/
  server.js   HTTP-Server + API
  db.js       SQLite-Schema
  auth.js     Login, Sessions, Passwort-Hashing (scrypt), Brute-Force-Schutz
public/       Oberfläche (HTML/CSS/JS, PWA-Manifest, Service Worker)
Dockerfile, docker-compose.yml
```
