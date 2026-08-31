# Lyng SurveyLocation (Android source module)

This directory contains the source-controlled Android half of Lyng's survey
tracker. It is intentionally independent of `BridgeActivity` and the WebView:

- `SurveyLocationService` is a **started**, sticky foreground service of type
  `location`.
- `SurveyLocationStore` appends every raw `Location` to an app-private SQLite
  database before any best-effort event is sent to JavaScript.
- Raw and derived fields coexist: accuracy, altitude, speed, heading, provider,
  mock status, activity, quality, accepted and rejection reason.
- An active session is recovered from SQLite after Android recreates a killed
  service. Paused and completed sessions never restart themselves.
- Capacitor events are only a live UI optimization. `getState` and paginated
  `getSamples` are the recovery path after a WebView is recreated.

## Integration

The repository currently regenerates `android/` in CI, so do not copy these
files into the generated app tree by hand. This directory is integrated as a
source-controlled local Capacitor dependency:

1. The root `package.json` contains
   `"@lyng/survey-location": "file:native/android"` and the lockfile pins it.
2. The legacy background-geolocation plugin remains available only for ordinary
   trips. Survey start stops that watcher before starting `SurveyLocation`, so
   two foreground location services never run for the same survey.
3. Run `npm ci`, build the web assets, then
   `npx cap sync android`. The package metadata uses `capacitor.android.src =
   "."`, so Capacitor will add this Gradle library and discover
   `no.lyng.baer.survey.SurveyLocationPlugin`.
4. Call the inherited Capacitor `requestPermissions()` before `start`. P0
   intentionally requires precise location and, on Android 13+, notification
   permission so the ongoing foreground notification is actually visible.
5. Start/resume only from a user action while the Activity is visible. Android
   14+ rejects creation of a location foreground service from the background.
6. On every app launch/foreground transition, call `getState`, then page
   `getSamples` from the last processed sequence until `hasMore` is false.

The module API is described in `definitions.d.ts`. Required control methods are
`start`, `pause`, `resume`, `stop`, `getState`, `getSessions`, `getSamples`, `setActivity`, and
`deleteSamples`/`deleteSession`. `deleteSamples` removes only raw rows and retains
the completed session record. `deleteSession` removes a completed session and
its raw rows via the SQLite foreign-key cascade. Both deletion operations require
the exact session id, terminal `COMPLETED` state, and `confirm: true`.

## Expected limitations

- Android **force-stop** is an explicit user/system stop and cannot be survived
  by any ordinary app service. A normal Activity/WebView destruction and a
  system process reclaim are the supported recovery cases.
- There is no boot receiver in P0. A device reboot leaves the session marked
  active for user-visible recovery but does not start location collection from
  the background.
- `POOR` samples are persisted with `accepted=true` so the survey engine can
  render them as uncertain; they must not count as full coverage.
- Mock locations are retained as raw rows but rejected for coverage.

## Verification after integration

Run `testDebugUnitTest` for the pure quality-filter tests and an Android debug
build for manifest/API validation. Device acceptance should cover Android
13/14/15, 30+ minutes with the screen locked, another app in front, Activity
destruction, process reclaim/sticky recovery, offline mode, pause/resume/stop,
and denied/approximate permissions.
