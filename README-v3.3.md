# Lyng v3.3

Denne versjonen bygger videre på v3.2 og tilbakemeldinger fra en tidlig felttest. App-ID-en er fortsatt `no.lyng.baer`, og eksisterende data normaliseres ved innlasting og import.

## Endringer i appen

- **Valg før turstart:** `Start tur` åpner nå et valg mellom Auto, Plukker, Går og Transport. Turen opprettes først etter at brukeren har valgt.
- **Tydelig avslutning:** `Avslutt tur` vises under hele den aktive eller pausede turen. v3.2 hadde en CSS-feil som holdt knappen skjult.
- **Enklere modusbytte:** Aktivitetsknappen åpner samme eksplisitte valg som ved turstart, i stedet for å bla gjennom moduser ett trykk av gangen.
- **Trygg avbryting:** Valgene for ny måling, ny plukksone og kartmerke har en tydelig `Avbryt`-knapp før data opprettes.
- **Retningspil:** Posisjonsmarkøren viser kompassretning når en gyldig retning finnes. GPS-kurs brukes som reserve under bevegelse.
- **Bærarter:** Blåbær, tyttebær, multer, bringebær, bjørnebær og andre bær kan registreres som egne funn.
- **Soppmerker:** Kantarell, steinsopp, matpiggsopp, traktkantarell, matriske, fåresopp, matblekksopp, skrubb og annen/usikker sopp kan registreres. Et merke er en egen observasjon, ikke en artsbestemmelse eller bekreftelse på at soppen er spiselig.
- **Bakoverkompatible merker:** Artsdata legges til som `kategori` og `art` på eksisterende `type: "funn"`. Gamle generiske bærmerker beholdes.
- **Kartzoom:** Kartet kan zoomes til nivå 20. Kartverkets nåværende WMTS-fliser stopper på nivå 18, så nivå 19–20 er oppskalering som gir enklere plassering, men ikke mer kildedetalj.
- **Tåke ved knipezoom:** Tåkecanvaset har fått overscan, synkronisert zoomtransform, full bredde-/høydekontroll og samlet nytegning. Det hindrer at kartkanter blir synlige når zoombevegelsen avsluttes.
- **Fotruter som temalag:** Merkede og umerkede fotruter kan slås av og på uavhengig av grunnkartet. Lagene ligger under tåken, slik at de ikke røper uutforsket terreng.

## Kartkilder og avgrensninger

Fotrutene hentes fra Kartverkets åpne `friluftsruter2`-WMS. Implementasjonen bruker samme `Fotrute`-lag og samme feltverdier (`Merket` / `Ikke merket`) som [Kartverkets Norgeskart](https://github.com/kartverket/Norgeskart/blob/eb7350311e7094f2fff9214d5dd53a0bbbbc7e07/src/map/layers/config/themeLayers/outdoorRecreation.ts). «Umerkede fotruter» betyr registrerte ruter i Turrutebasen, ikke alle fysiske skogsstier.

Kartverket tilbyr bare native WMTS-nivå 0–18 i dagens [WMTS Capabilities](https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml). En mulig senere forbedring er en hybrid som bruker rask WMTS til nivå 18 og Topografisk Norgeskart WMS for reell detalj på nivå 19–20. Dette bør ytelsestestes på telefon før innføring.

**Flyfoto/satellitt er undersøkt, men ikke aktivert i v3.3.** Norge i bilder krever nå avtale/GeoID og et tidsbegrenset token som bindes til IP-adresse eller HTTP-referer. Legitimasjon skal ikke hardkodes i APK-en. En forsvarlig løsning krever avklart tilgang og trolig en liten backend/proxy, eller en annen leverandør med egnet mobilavtale.

Kartverkets åpne tjenester brukes med kreditering i henhold til [vilkårene for åpne data](https://www.kartverket.no/api-og-data/vilkar-for-bruk).

## Videre muligheter

- Trykk på en fotrute og vis navn, gradering, merking og vedlikeholdsansvarlig via WMS `GetFeatureInfo`.
- Legg til egne brytere for skiruter, sykkelruter, naturstier, kulturstier, kyststier og ruteinfopunkter.
- Undersøk FKB-TraktorvegSti for fysiske stier som ikke er registrert som friluftsruter.
- Feltkalibrer Auto-modus og kompasspilen på flere Android-modeller.
- Lagre en pågående måling robust over prosessavslutning, med et eksplisitt valg om å fortsette eller forkaste etter omstart.
- Utvid funn med bilde, mengdeklasse, kvalitet, favoritt og «sist kontrollert»-dato uten å fremstille appen som artsbestemmelse.
- Vurder kobling til Digital soppkontroll som en sikkerhetslenke. Ved mulig forgiftning gjelder rådene fra [Giftinformasjonen](https://www.helsenorge.no/giftinformasjon/sopp/).
- Ytelsestest et detaljert WMS-grunnkart og avklar en bærekraftig flyfotoavtale.

## Bygg

GitHub Actions kopierer appen til Capacitor, bygger Android debug-APK og publiserer den som siste release. Versjonsnavnet blir `3.3.<GitHub run number>`.

## Kontroll før levering

- Inline JavaScript kompilerer med Node 22.
- `package.json` og `capacitor.config.json` er gyldig JSON.
- Mobilflyter og kartlag kontrolleres i nettleser ved smal skjermbredde.
- Android-bygget kontrolleres i GitHub Actions etter push.

Kompass, bakgrunns-GPS, automatisk aktivitetsklassifisering og tåke ved fysisk knipezoom bør i tillegg feltprøves på en Android-enhet.
