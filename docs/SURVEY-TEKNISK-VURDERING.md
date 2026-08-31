# Survey Mode – teknisk vurdering

## Utgangspunkt

Lyng er i dag en liten, frameworkfri Capacitor-app. Den sporbare frontend-kilden er `lyng.html`, som inneholder HTML, CSS, state, kartlogikk og GPS-flyt i én fil. Leaflet 1.9.4 brukes til kartet, og Android-appen bygges med Capacitor 7.6.8. `www/` og `android/` er genererte og git-ignorerte; byggflyten kopierer `lyng.html` til `www/index.html` og oppretter Android-prosjektet på nytt.

Eksisterende arkitektur skal beholdes der den fungerer. Oppgraderingen innfører ikke React, Redux eller en total UI-omskriving. Survey bygges som et avgrenset domene med rene tjenester, et persistensgrensesnitt og tynne koblinger til dagens Leaflet- og DOM-kode.

## Det som kan gjenbrukes

- Turflyten har allerede start, pause, fortsett, fullfør og gjenåpning av en uavsluttet tur.
- Hvert lagret sporpunkt har posisjon, tidspunkt, accuracy, aktivitet og informasjon om sporbrudd.
- Aktivitetene `gaa`, `plukk` og `transport` kan mappes til `SEARCHING`, `PICKING` og `TRANSPORT`. Manuell overstyring og dagens auto-klassifisering kan beholdes.
- Plukksoner gir et godt utgangspunkt for `SurveyArea`: polygon kan tegnes med karttrykk eller ved å gå grensen, forenkles, navngis og lagres.
- Leaflet-lagene for spor, soner, merker og posisjon kan utvides. Det eksisterende canvas-baserte tåkelaget er et nyttig mønster for effektiv visualisering.
- Marker-FAB, bottom sheet, toast, aktivitetsknapp, status-pill, progressbar, bearing-hjelpere og haptisk kvittering kan brukes i Survey-UI.
- Backup/import har allerede schema- og geometrimetadata og kan utvides med Survey-data.

Dagens griddekning er inkrementell og dobbeltteller ikke samme celle. Den beholdes som legacy-historikk, sektor-/debugvisning eller spatial indeks. Den skal ikke være eneste sannhetskilde for ny Survey-dekning, fordi cellene er globale per år og ikke knyttet til én session.

## Nye modulgrenser

Første moduldeling er bevisst liten:

- `src/survey-core.js`: UI-uavhengige modeller, konfigurasjon, GPS-kvalitetsfilter, coverage-profiler, Turf-baserte geometrioperasjoner, dekningsstatistikk og hullrangering.
- `src/survey-geometry-worker.js`: kjører eksakt samme batch-/bulk-union, target clipping, differanse og hullrangering utenfor UI-tråden, med serialisert commit og konservativ synkron fallback.
- `src/survey-storage.js`: ett repository-grensesnitt for rå GPS-prøver. Android bruker den native SurveyLocation-databasen; nettleserutgaven bruker IndexedDB.
- `src/survey-track-view.js`: flyktig, segmentbevarende og hardt begrenset kartrepresentasjon av lange Survey-spor. Det komplette aksepterte sporet og råprøvene beholdes uendret.
- `lyng.html`: beholder Leaflet, eksisterende UI og integrasjonskontrolleren. GIS-operasjoner og lagringsdetaljer skal ikke ligge i DOM-eventhandlere.
- En sporet lokal Capacitor-plugin `SurveyLocation` skal eie Android foreground service og SQLite-lagring. Kode under generert `android/` er ikke en varig kilde.

Ved behov kan kjernen senere deles videre i `location-quality-filter`, `coverage-engine`, `hole-analyzer`, `survey-store` og `survey-layers`, men dette er ikke nødvendig før filene blir vanskelige å teste eller vedlikeholde.

Kartet skal få separate layer groups/panes for target, uncovered, valid coverage, uncertain coverage, GPS-track, hullmarkering og observations. Leaflet skal bare rendre ferdige view models/GeoJSON fra Survey-kjernen.

## Datamodell og migrasjon

Dagens legacy-lagring er ett JSON-dokument under `lyng:data`; Survey-utvidelsen bruker schema 42. Tur- og cellehistorikk beholdes foreløpig her for kompatibilitet, mens rå Survey-prøver lagres append-only utenfor hoveddokumentet.

Migrasjonen skal være idempotent og konservativ:

- Gamle `turer` forblir vanlige turer. De skal ikke automatisk presenteres som gjennomførte surveys.
- Gamle trackpunkter kan leses som `source: LEGACY` og `accepted: true`. Manglende altitude, speed, heading og quality kan ikke rekonstrueres.
- Tidligere avviste GPS-prøver og transportpunkter finnes ikke i lagringen og kan ikke migreres.
- `soner[].pkt` kan konverteres til `SurveyArea`, men koordinatene må snus eksplisitt fra `[lat, lng]` til GeoJSONs `[lng, lat]`.
- Eksisterende `celler` beholdes som historisk legacy-dekning og knyttes ikke kunstig til en bestemt session.
- Eksisterende `merker` beholdes. Nye `SurveyObservation` får eget `surveyId` og rating; gamle bær-/soppmerker skal ikke tolkes som ratings.
- Derived data, som coverage, hull og statistikk, skal kunne regenereres fra raw samples. Cacheformatet må derfor versjoneres separat fra rådata.

## Native P0: bakgrunnssporing

Den installerte community-pluginen er ikke tilstrekkelig for P0. Tjenesten er bundet til Capacitor-aktiviteten, sender punkter til JavaScript og stopper watchers når UI-et kobles fra eller prosessen dør. Den persisterer ingen rådata.

`SurveyLocation` må derfor:

1. starte en Android foreground service av type `location` når en survey starter;
2. vise permanent notification og håndtere nødvendige tillatelser for target SDK 35;
3. hente høyoppløselig posisjon med konfigurerbart intervall og minimumsdistanse;
4. skrive hver råprøve direkte og transaksjonelt til SQLite før eventuell levering til UI;
5. lagre survey-ID, timestamp, accuracy, altitude, speed, heading, source og aktivitet;
6. støtte `start`, `pause`, `resume`, `setActivity`, `stop`, `getState`, full øktliste og paginert `getSamples(afterId)`;
7. overleve skjermlås, appbytte og WebView/UI-død, og gjenopprette aktiv session etter ny åpning.

Frontend skal lese nye samples med cursor og prosessere dem i batch. Live events er en optimalisering, ikke sannhetskilden. Foreground service skal starte og stoppe sammen med surveyen, ikke ved generell appoppstart.

Siden Android-prosjektet regenereres i CI, må plugin-kilden og nødvendige manifest-/buildtilpasninger være sporet og kobles inn gjennom byggscript/workflow. Endringer bare i `android/` vil gå tapt.

## Implementert i denne oppgraderingen

- `SurveyLocation` er koblet inn som `file:native/android` og oppdages automatisk av Capacitor-byggingen.
- Den startede, sticky foreground-tjenesten er uavhengig av Activity/WebView, og råprøver skrives append-only til SQLite før UI-varsling.
- Sesjonstilstander og akkumulert pausetid oppdateres atomisk i databasen. Monotone state-revisjoner og en lokal transition-generasjon gjør at sene bridge-/pollsvar ikke kan skrive over en nyere pause, resume eller aktivitetsendring. STOP-kommandoer er sesjonsavgrenset, slik at et sent kall fra en gammel survey ikke kan stoppe en ny.
- Hver prøve har boot-identitet. Reboot eller GPS-opphold bryter dekningssegmentet, slik at appen ikke tegner falsk korridor gjennom ukjent terreng.
- Frontend bruker paginert cursor-recovery, checkpointet coverage og bare en liten punkt-hale etter siste checkpoint. Råhistorikken serialiseres ikke inn i hoved-JSON-dokumentet. Liveflyten bruker små batcher. Også en lang eller cache-løs JSON-hale hydreres asynkront i bulk i stedet for å replays ved synkron karttegning; recovery slipper UI-tråden mellom avgrensede 12-punktsdeler, og den balanserte sluttunionen kjøres i en Web Worker. Checkpoint kan først committe etter at worker-resultatet er validert og atomisk tatt inn.
- Target-statistikk, uncovered-differanse og hullrangering bruker samme worker. Worker-dispatch er single-flight, slik at en jobbs timeout først løper når jobben faktisk starter. En generasjonsstyrt kø slår sammen samtidige UI-forespørsler og avviser sene resultater etter mål-, view- eller engine-bytte. Ikke-flushende visninger får et eksakt worker-snapshot av pending geometri uten å endre batch-/overlaptilstanden; checkpoint trimmer bare punktprefikset snapshotet faktisk representerer. Bulkstart er selv en atomisk operasjon i engine-køen, så preview og recovery ikke kan passere hverandre mellom «idle» og bulkmodus.
- Live-sporet tegnes fra en maksimalt 2400 punkter stor visningsbuffer og oppdateres batchvis. Dermed vokser ikke Leaflet-arbeidet per GPS-event med et råspor på titusenvis av punkter.
- Pause og fullføring venter på køen, native terminalstatus og siste kjente SQLite-sekvens. Dersom siste avledning ikke kan leses inn etter en allerede committet fullføring, markeres den for sikker synk ved neste åpning.
- Start feiler lukket dersom hovedmetadata ikke kan persisteres. Tvetydige bridge-svar for start, pause, resume, aktivitet og fullføring avstemmes mot scope-et native state, og en lett statuspoll oppdager også om foreground-tjenesten pauser seg selv mens WebView fortsatt lever. Native feilkode, siste sample-tid og en konservativ no-fix-timeout driver samme GPS-status og haptikk som webprøver.
- «Slette ALT» lister alle native SQLite-økter før sletting, slik at også fullførte råspor uten et gjenværende WebView-snapshot blir funnet, stoppet ved behov og fjernet.
- Target-polygon og exclusions snapshots per survey. Målområdet kan byttes under en åpen survey; senere redigering eller sletting av originalsonen endrer derfor ikke historisk prosent eller sluttstatistikk.
- Coverage, target clipping, uncovered geometry, hullrangering, exclusions, observasjoner, historiske lag, overlap-varsel og haptikk er integrert i dagens Leaflet-grensesnitt.
- Utviklervisning aktiveres uten å påvirke vanlig UX med `?surveyDebug=1`. Den viser raw/accepted/rejected-tellere, accuracy, quality, cursor, hull og geometristatus; kartlagene viser samtidig coverage og hull.

Automatiske tester dekker GPS-grenser og hopp, reboot/gap, transport, usikker dekning, unik union, clipping, hull, exclusions, cache-recovery, 10 000-punkters renderbuffer og JavaScript/native bridge-mapping. I tillegg dekker native enhetstester kvalitetsfilter og klokke-/bootkanttilfeller. Den fysiske 30–180 minutters Android-felttesten med låst skjerm er fortsatt et eksplisitt release-kriterium; den kan ikke erstattes av en skrivebordsbygging.

## Faser

### Fase 1 – robust GPS-grunnmur

- Native foreground service og SQLite.
- Raw/accepted/derived skilt i datamodellen.
- Konfigurerbart kvalitetsfilter og rejection reason.
- Start, pause, resume, stop, activity mode og recovery.
- Transportpunkter lagres og tegnes, men gir ingen coverage.

Fasen er ikke ferdig før en fysisk Android-test med låst skjerm og annen aktiv app viser et komplett spor, også etter at UI-et er drept og åpnet igjen.

### Fase 2 – coverage

- Radiusprofiler 3/5/8/12 meter.
- Turf-buffer rundt sammenhengende `SEARCHING`/`PICKING`-segmenter.
- `POOR` holdes separat som uncertain coverage; `REJECTED` gir ingen coverage.
- Union utføres i små live-batcher, caches og flyttes ut av UI-tråden. Target clipping og hullberegning offloades fra det samme atomiske snapshotet. Lang recovery bruker hierarkiske deler og en off-thread sluttunion, slik at full historikk ikke unioneres på nytt ved hvert GPS-event.
- Track og coverage vises som separate kartlag.

### Fase 3 – target og hull

- Lagret/valgt target polygon og senere exclusions.
- Area, intersection, difference og live prosent innen effective target.
- Hull over minimumsareal med centroid, avstand og rangering.
- «Finn neste hull» gjenbruker dagens bearing- og pulsmarkør-UI.

### Fase 4 – Survey-UX og videre hjelp

- Kompakt live dashboard, activity-toggle og GPS-status.
- Raske ratings for funn.
- Historikkfilter, ignored/inaccessible holes, overlap-varsler, haptikk og sektorer når kjernen er stabil.

## Bevisste kompromisser

- Nettleserfallbacken kan lagre i IndexedDB, men kan ikke love bakgrunnssporing etter at nettleseren suspenderes.
- GIS-beregning ligger i JavaScript, men coverage-union, target-statistikk og hull-differanse kjøres normalt i worker. Turf-buffer og små 12-punkts recovery-deler bygges fortsatt på UI-tråden med eksplisitte yields, og Leaflet må naturlig nok rendre det ferdige GeoJSON-laget der. Ved manglende eller faktisk krasjet worker brukes eksakt lokal fallback og debug/logg viser degraderingen; en worker-rapportert feil i selve målpolygonet kjøres ikke unødvendig én gang til på UI-tråden. Native-laget garanterer rådata, ikke ferdig coverage.
- Full offline kartnedlasting inngår ikke. GPS, Survey-data og beregning fungerer offline, mens kartdetaljer avhenger av allerede cachede nettfliser.
- Dagens grid og sesonghistorikk fjernes ikke, men blandes heller ikke automatisk inn i current-session coverage.
- Automatisk aktivitetsforslag er utsatt til advanced-fasen. I Survey Mode er brukerens manuelle aktivitet autoritativ.

Hovedregelen er at rå GPS-data aldri skal tapes, og at Lyng heller undervurderer dekning enn å vise falsk fullføring.
