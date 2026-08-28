# Lyng v3.2

Denne versjonen bygger videre på v3.1 uten å endre app-ID (`no.lyng.baer`). Eksisterende v3.1-data migreres ved innlasting.

## Viktigste endringer

- **Turer/sessions:** Start, pause/fortsett og avslutt tur. Gålinje og distanse hører til hver tur, og turhistorikk vises i Innstillinger.
- **Sikker oppstart:** En uavsluttet tur åpnes pauset etter omstart. Pauset tid trekkes fra turvarigheten.
- **Aktivitetsklassifisering:** Auto vurderer `Plukker`, `Går`, `Stille` og `Transport` fra et rullerende GPS-vindu. Du kan overstyre med `Auto → Plukker → Går → Transport`.
- **To nivåer av dekning:** Gange registrerer `passert` med egen gåradius og lysner tåken delvis. Plukking registrerer `undersøkt` og åpner tåken helt.
- **Sporbrudd:** Pause, transport og forkastede GPS-hopp lager separate linjesegmenter i stedet for kunstige rette streker. Slike hopp teller heller ikke i returavstand.
- **Sesonghistorikk:** En rute kan nå ha dekning i flere år. Et besøk i 2027 overskriver ikke 2026.
- **Benchmark:** Tid og distanse fryses idet `Ferdig` trykkes, før liter legges inn.
- **Grid-sikkerhet:** Rutestørrelsen endres først etter bekreftelse. Avbryt beholder gammel geometri.
- **Tryggere backup/import:** Backup inneholder schema-/geometrimetadata. Inkompatible dekningsruter hoppes over i stedet for å tolkes med feil rutenett.
- **GPX:** Eksporterer alle turer som egne sporsegmenter.
- **Mobil-UX:** Større verktøyknapper, safe-area for telefonkanter og vibrasjonskvittering når et merke lagres.
- **Leaflet:** APK-bygget kopierer Leaflet inn lokalt fra npm, slik at selve kartmotoren ikke er CDN-avhengig etter bygg.

## Viktig om Auto-modus

Tersklene i Auto er en første feltversjon, ikke ferdig kalibrert. Se på aktivitetsknappen under reelle turer. Hvis den ofte sier `Går` mens du plukker, eller `Plukker` mens du går målrettet, bør tersklene justeres etter innsamlede turdata. Manuell overstyring finnes nettopp for at feilklassifisering ikke skal ødelegge dekningskartet mens dette kalibreres.

## Kart offline

Leaflet-runtime blir lokal i APK-en, men Kartverket-flisene lastes fortsatt fra nettet. v3.2 er derfor **ikke full offline-kartstøtte**. Det er en naturlig neste større funksjon.

## Bygg

Eksisterende GitHub Actions-workflow bygger Android-versjonen. Den gjør `npm install`, kopierer `lyng.html` til `www/index.html`, legger Leaflet i `www/vendor/`, oppretter Capacitor Android-prosjekt og bygger debug-APK.

Versjonsnavn blir `3.2.<GitHub run number>`.

## Kontrollert før levering

- JavaScript syntakssjekket med Node 22 (`node --check`).
- `package.json` og `capacitor.config.json` validert som JSON.
- GitHub Actions YAML parsbar.
- Alle bokstavelige `getElementById(...)`-referanser peker på eksisterende HTML-ID-er.
- Ingen gjenstående kall til gammel `merkBesokt`-funksjon.

Full GPS-/bakgrunnstest må gjøres på en fysisk Android-enhet. Auto-klassifiseringen bør kalibreres fra faktiske turer.
