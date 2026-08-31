package no.lyng.baer.survey;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import java.util.List;

/**
 * Started foreground service that owns location collection and writes every raw
 * sample before attempting to notify a WebView. It deliberately has no binding
 * to the Activity or Capacitor plugin lifecycle.
 */
public final class SurveyLocationService extends Service {
    private static final String TAG = "LyngSurveyLocation";
    private static final String NOTIFICATION_CHANNEL_ID = "lyng_survey_tracking";
    private static final int NOTIFICATION_ID = 28_352;
    private static final long NOTIFICATION_REFRESH_MS = 15_000L;

    private SurveyLocationStore store;
    private LocationManager locationManager;
    private HandlerThread locationThread;
    private volatile String currentSessionId;
    private volatile boolean updatesRegistered;
    private volatile LocationQualityEvaluator.AcceptedPoint lastAcceptedPoint;
    private volatile long lastNotificationRefreshMs;
    private volatile long registrationGeneration;
    private volatile SessionLocationListener registeredListener;
    private long currentBootId;

    private final class SessionLocationListener implements LocationListener {
        private final String sessionId;
        private final long generation;

        SessionLocationListener(String sessionId, long generation) {
            this.sessionId = sessionId;
            this.generation = generation;
        }

        @Override
        public void onLocationChanged(Location location) {
            handleLocationChanged(sessionId, generation, location);
        }

        @Override
        public void onProviderDisabled(String provider) {
            handleProviderDisabled(sessionId, generation, provider);
        }

        @Override
        public void onProviderEnabled(String provider) {
            handleProviderEnabled(sessionId, generation, provider);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onStatusChanged(String provider, int status, Bundle extras) {
            // Kept for API 23 compatibility.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new SurveyLocationStore(getApplicationContext());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationThread = new HandlerThread("LyngSurveyLocationWorker");
        locationThread.start();
        currentBootId = readBootId();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        String requestedSessionId = intent == null
            ? null
            : intent.getStringExtra(SurveyContract.EXTRA_SESSION_ID);

        if (SurveyContract.ACTION_STOP.equals(action)) {
            return handleSessionStop(requestedSessionId, startId);
        }

        if (SurveyContract.ACTION_REFRESH.equals(action)) {
            SurveyLocationStore.SessionState state = activeState(requestedSessionId);
            if (state == null) {
                return recoverActiveOrStop(startId);
            }
            if (!updatesRegistered && !startTracking(state)) return START_NOT_STICKY;
            refreshNotification(state);
            broadcastState(state);
            return START_STICKY;
        }

        SurveyLocationStore.SessionState state = activeState(requestedSessionId);
        if (state == null) {
            // A null intent is an Android sticky restart. Only a DB-backed ACTIVE
            // session is allowed to resurrect collection.
            return recoverActiveOrStop(startId);
        }
        return startTracking(state) ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SurveyLocationStore.SessionState activeState(String requestedSessionId) {
        SurveyLocationStore.SessionState state = requestedSessionId == null
            ? store.getRecoverableSession()
            : store.getSession(requestedSessionId);
        return state != null && SurveyContract.STATUS_ACTIVE.equals(state.status)
            ? state
            : null;
    }

    private synchronized int handleSessionStop(String requestedSessionId, int startId) {
        SurveyLocationStore.SessionState requested = requestedSessionId == null
            ? null
            : store.getSession(requestedSessionId);
        // pause/stop commits the DB status before queuing STOP. If the same
        // session has already been resumed, this command is stale.
        if (requested != null && SurveyContract.STATUS_ACTIVE.equals(requested.status)) {
            return startTracking(requested) ? START_STICKY : START_NOT_STICKY;
        }

        String registeredSessionId = currentSessionId;
        if (registeredSessionId != null) {
            if (!registeredSessionId.equals(requestedSessionId)) {
                return recoverActiveOrStop(startId);
            }
            stopCleanly(startId);
            return START_NOT_STICKY;
        }

        return recoverActiveOrStop(startId);
    }

    private synchronized int recoverActiveOrStop(int startId) {
        // A stale command for A must never silence a newer DB-backed ACTIVE B.
        SurveyLocationStore.SessionState recoverable = store.getRecoverableSession();
        if (recoverable != null) {
            return startTracking(recoverable) ? START_STICKY : START_NOT_STICKY;
        }
        stopCleanly(startId);
        return START_NOT_STICKY;
    }

    private synchronized boolean startTracking(SurveyLocationStore.SessionState state) {
        if (!hasPreciseLocationPermission()) {
            failAndPause(
                state,
                "PRECISE_LOCATION_REQUIRED",
                "Precise location permission is required for survey tracking"
            );
            return false;
        }
        if (!hasNotificationPermission()) {
            failAndPause(
                state,
                "NOTIFICATION_PERMISSION_REQUIRED",
                "Notification permission is required for visible foreground tracking"
            );
            return false;
        }

        String previousSessionId = currentSessionId;
        boolean sessionChanged = previousSessionId != null
            && !previousSessionId.equals(state.sessionId);
        if (sessionChanged) {
            removeLocationUpdates();
            lastAcceptedPoint = null;
        }
        currentSessionId = state.sessionId;
        if (!promoteToForeground(state)) {
            failAndPause(
                state,
                "FOREGROUND_SERVICE_START_FAILED",
                "Android refused to start the location foreground service"
            );
            return false;
        }

        if (!updatesRegistered) {
            lastAcceptedPoint = store.getLastAcceptedPoint(state.sessionId);
            if (!requestLocationUpdates(state)) {
                failAndPause(
                    state,
                    "LOCATION_PROVIDER_UNAVAILABLE",
                    "No permitted Android location provider is available"
                );
                return false;
            }
        }
        store.setLastError(state.sessionId, null, null);
        broadcastState(store.getSession(state.sessionId));
        return true;
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private boolean requestLocationUpdates(SurveyLocationStore.SessionState state) {
        if (locationManager == null) return false;
        boolean registered = false;
        long generation = ++registrationGeneration;
        SessionLocationListener listener = new SessionLocationListener(
            state.sessionId,
            generation
        );
        registeredListener = listener;
        List<String> providers = locationManager.getAllProviders();
        for (String provider : new String[] {
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER
        }) {
            if (!providers.contains(provider)) continue;
            try {
                locationManager.requestLocationUpdates(
                    provider,
                    state.intervalMs,
                    (float) state.minDistanceMeters,
                    listener,
                    locationThread.getLooper()
                );
                registered = true;
            } catch (SecurityException | IllegalArgumentException exception) {
                Log.w(TAG, "Could not subscribe to " + provider, exception);
            }
        }
        updatesRegistered = registered;
        if (!registered) registeredListener = null;
        return registered;
    }

    private void handleLocationChanged(String sessionId, long generation, Location location) {
        if (!isCurrentRegistration(sessionId, generation) || location == null) return;

        SurveyLocationStore.SessionState state = null;
        SurveyLocationStore.RawSample raw;
        LocationQualityEvaluator.Result quality = null;
        SurveyLocationStore.Sample stored = null;
        long evaluatedStateRevision = -1L;
        try {
            raw = toRawSample(location);
            LocationQualityEvaluator.RawPoint point = new LocationQualityEvaluator.RawPoint(
                raw.latitude,
                raw.longitude,
                raw.recordedAtMs,
                raw.elapsedRealtimeNanos,
                raw.accuracyMeters != null,
                raw.accuracyMeters == null ? Double.NaN : raw.accuracyMeters,
                raw.mock,
                raw.bootId
            );
            for (int attempt = 0; attempt < 3; attempt++) {
                state = store.getSession(sessionId);
                if (state == null || !SurveyContract.STATUS_ACTIVE.equals(state.status)) return;
                evaluatedStateRevision = state.stateRevision;
                quality = LocationQualityEvaluator.evaluate(
                    point,
                    lastAcceptedPoint,
                    state.activity,
                    System.currentTimeMillis(),
                    SystemClock.elapsedRealtimeNanos(),
                    state.thresholds()
                );
                try {
                    stored = store.appendSample(sessionId, raw, state.activity, quality);
                    break;
                } catch (SurveyLocationStore.ActivityChangedException changed) {
                    state = changed.currentState;
                    if (attempt == 2) throw changed;
                }
            }
        } catch (RuntimeException exception) {
            Log.e(TAG, "Failed to persist location sample", exception);
            failAndPause(
                sessionId,
                generation,
                evaluatedStateRevision,
                "DATABASE_WRITE_FAILED",
                "The native location sample could not be persisted"
            );
            return;
        }

        // Pause/stop commits status before stopping the service. A callback
        // already in flight must not append after that transition.
        if (stored == null) return;
        if (state.lastErrorCode != null) {
            try {
                SurveyLocationStore.SessionState clearedState = store.setLastError(sessionId, null, null);
                // The WebView may delete a completed session between append and
                // this best-effort cleanup. Keep the non-null state used for the
                // append so the in-flight callback cannot dereference null.
                if (clearedState != null) state = clearedState;
            } catch (RuntimeException errorClearFailure) {
                Log.w(TAG, "Sample persisted, but GPS error state could not be cleared", errorClearFailure);
            }
        }
        if (quality.accepted && isCurrentRegistration(sessionId, generation)) {
            lastAcceptedPoint = new LocationQualityEvaluator.AcceptedPoint(
                raw.latitude,
                raw.longitude,
                raw.recordedAtMs,
                raw.elapsedRealtimeNanos,
                raw.accuracyMeters == null ? 0.0 : raw.accuracyMeters,
                raw.bootId,
                state.activity
            );
        }
        try {
            broadcastSample(stored.sequence, sessionId);
        } catch (RuntimeException broadcastFailure) {
            Log.w(TAG, "Sample persisted, but WebView event could not be broadcast", broadcastFailure);
        }

        long now = SystemClock.elapsedRealtime();
        if (now - lastNotificationRefreshMs >= NOTIFICATION_REFRESH_MS) {
            try {
                refreshNotification(store.getSession(sessionId));
                lastNotificationRefreshMs = now;
            } catch (RuntimeException notificationFailure) {
                Log.w(TAG, "Sample persisted, but notification refresh failed", notificationFailure);
            }
        }
    }

    private void handleProviderDisabled(String sessionId, long generation, String provider) {
        if (!isCurrentRegistration(sessionId, generation) || hasEnabledProvider()) return;
        store.setLastError(
            sessionId,
            "LOCATION_PROVIDER_DISABLED",
            provider + " is disabled; tracking will resume when it is available"
        );
        broadcastError(
            sessionId,
            "LOCATION_PROVIDER_DISABLED",
            provider + " is disabled"
        );
        refreshNotification(store.getSession(sessionId));
    }

    private void handleProviderEnabled(String sessionId, long generation, String provider) {
        if (!isCurrentRegistration(sessionId, generation)) return;
        SurveyLocationStore.SessionState state = store.setLastError(sessionId, null, null);
        refreshNotification(state);
        broadcastState(state);
    }

    private boolean isCurrentRegistration(String sessionId, long generation) {
        return generation == registrationGeneration
            && sessionId != null
            && sessionId.equals(currentSessionId)
            && registeredListener != null
            && registeredListener.generation == generation;
    }

    @Override
    public void onDestroy() {
        removeLocationUpdates();
        stopForegroundNotification();
        currentSessionId = null;
        lastAcceptedPoint = null;
        if (locationThread != null) locationThread.quitSafely();
        if (store != null) store.close();
        super.onDestroy();
        // Do not mutate an ACTIVE DB session here. If Android killed the process,
        // START_STICKY must be able to reconstruct it from persistent state.
    }

    private SurveyLocationStore.RawSample toRawSample(Location location) {
        Double altitudeAccuracy = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
            altitudeAccuracy = (double) location.getVerticalAccuracyMeters();
        }
        boolean mock = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? location.isMock()
            : location.isFromMockProvider();
        return new SurveyLocationStore.RawSample(
            location.getTime(),
            location.getElapsedRealtimeNanos(),
            currentBootId,
            location.getLatitude(),
            location.getLongitude(),
            location.hasAccuracy() ? (double) location.getAccuracy() : null,
            location.hasAltitude() ? location.getAltitude() : null,
            altitudeAccuracy,
            location.hasSpeed() ? (double) location.getSpeed() : null,
            location.hasBearing() ? (double) location.getBearing() : null,
            location.getProvider(),
            mock
        );
    }

    private long readBootId() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                return Settings.Global.getInt(
                    getContentResolver(),
                    Settings.Global.BOOT_COUNT
                );
            } catch (Settings.SettingNotFoundException | SecurityException ignored) {
                // Fall through to an API-23-compatible boot epoch.
            }
        }
        long bootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtime();
        return 1_000_000_000L + bootEpochMs / 600_000L;
    }

    private boolean promoteToForeground(SurveyLocationStore.SessionState state) {
        Notification notification = buildNotification(state);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            lastNotificationRefreshMs = SystemClock.elapsedRealtime();
            return true;
        } catch (RuntimeException exception) {
            Log.e(TAG, "Unable to enter foreground", exception);
            return false;
        }
    }

    private void refreshNotification(SurveyLocationStore.SessionState state) {
        if (state == null || !SurveyContract.STATUS_ACTIVE.equals(state.status)) return;
        NotificationManager manager = (NotificationManager) getSystemService(
            Context.NOTIFICATION_SERVICE
        );
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(state));
    }

    private Notification buildNotification(SurveyLocationStore.SessionState state) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.setContentIntent(contentIntent);
        }

        String statusText = activityLabel(state.activity)
            + " · "
            + state.rawSampleCount
            + " GPS-punkter";
        if (state.lastErrorCode != null) statusText = "Venter på GPS · " + activityLabel(state.activity);

        builder
            .setSmallIcon(resolveNotificationIcon())
            .setContentTitle("Lyng")
            .setContentText(statusText)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(state.startedAtMs)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(
            Context.NOTIFICATION_SERVICE
        );
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Undersøkelse i bakgrunnen",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Vises mens Lyng registrerer en undersøkelse");
        channel.enableLights(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private int resolveNotificationIcon() {
        int icon = getResources().getIdentifier("ic_lyng", "drawable", getPackageName());
        if (icon == 0) icon = getApplicationInfo().icon;
        if (icon == 0) icon = android.R.drawable.ic_menu_mylocation;
        return icon;
    }

    private void failAndPause(
        SurveyLocationStore.SessionState observedState,
        String code,
        String message
    ) {
        failAndPause(
            observedState.sessionId,
            -1L,
            observedState.stateRevision,
            code,
            message
        );
    }

    private synchronized void failAndPause(
        String sessionId,
        long failedGeneration,
        long expectedStateRevision,
        String code,
        String message
    ) {
        if (
            failedGeneration >= 0L
                && !isCurrentRegistration(sessionId, failedGeneration)
        ) {
            // The failing callback belongs to a listener that has already been
            // replaced. Its failure must not pause the replacement, including a
            // pause/resume cycle that keeps the same session id.
            recoverActiveWithoutTearingDownCurrent();
            return;
        }

        if (expectedStateRevision < 0L) {
            try {
                SurveyLocationStore.SessionState current = store.getSession(sessionId);
                if (current == null || !SurveyContract.STATUS_ACTIVE.equals(current.status)) {
                    recoverActiveWithoutTearingDownCurrent();
                    return;
                }
                expectedStateRevision = current.stateRevision;
            } catch (RuntimeException stateReadError) {
                Log.e(TAG, "Could not inspect survey before terminal tracking error", stateReadError);
            }
        }

        SurveyLocationStore.ConditionalPauseResult pauseResult = null;
        try {
            pauseResult = store.failAndPauseSession(
                sessionId,
                expectedStateRevision,
                code,
                message
            );
            if (!pauseResult.transitioned) {
                // A pause/resume or activity transition superseded the failing
                // callback. Its error must not overwrite or pause that revision.
                if (
                    pauseResult.state != null
                        && SurveyContract.STATUS_ACTIVE.equals(pauseResult.state.status)
                ) {
                    startTracking(pauseResult.state);
                } else {
                    recoverActiveWithoutTearingDownCurrent();
                }
                return;
            }
            broadcastError(sessionId, code, message);
            broadcastState(pauseResult.state);
        } catch (RuntimeException storeError) {
            Log.e(TAG, "Could not persist terminal tracking error", storeError);
            broadcastError(sessionId, code, message);
        }

        // A callback for A can fail after the WebView has completed A and
        // started B. Never let that stale callback remove B's listener or
        // foreground notification. If B is durable but its start command has
        // not run yet, switch directly to it while holding the same lifecycle
        // monitor used by startTracking/STOP handling.
        SurveyLocationStore.SessionState recoverable = null;
        try {
            recoverable = store.getRecoverableSession();
        } catch (RuntimeException recoveryReadError) {
            Log.e(TAG, "Could not inspect a replacement active survey", recoveryReadError);
        }
        if (
            recoverable != null
                && (
                    pauseResult != null
                        || !sessionId.equals(recoverable.sessionId)
                        || (
                            expectedStateRevision >= 0L
                                && recoverable.stateRevision != expectedStateRevision
                        )
                )
        ) {
            // This includes a rapid resume of the same session after the error
            // pause committed. Re-read and retain that newer ACTIVE revision.
            startTracking(recoverable);
            return;
        }
        if (sessionId.equals(currentSessionId)) stopCleanly();
    }

    private void recoverActiveWithoutTearingDownCurrent() {
        SurveyLocationStore.SessionState recoverable;
        try {
            recoverable = store.getRecoverableSession();
        } catch (RuntimeException recoveryReadError) {
            Log.e(TAG, "Could not inspect active survey after stale callback", recoveryReadError);
            return;
        }
        if (
            recoverable != null
                && (
                    !recoverable.sessionId.equals(currentSessionId)
                        || !updatesRegistered
                )
        ) {
            startTracking(recoverable);
        }
    }

    private void stopCleanly() {
        removeLocationUpdates();
        stopForegroundNotification();
        currentSessionId = null;
        lastAcceptedPoint = null;
        stopSelf();
    }

    private void stopCleanly(int startId) {
        // Do not tear down listeners/notification when Android has already
        // queued a newer start request for this service instance.
        if (startId > 0 && !stopSelfResult(startId)) return;
        removeLocationUpdates();
        stopForegroundNotification();
        currentSessionId = null;
        lastAcceptedPoint = null;
        if (startId <= 0) stopSelf();
    }

    private void removeLocationUpdates() {
        SessionLocationListener listener = registeredListener;
        registrationGeneration += 1;
        registeredListener = null;
        if (locationManager != null && updatesRegistered && listener != null) {
            try {
                locationManager.removeUpdates(listener);
            } catch (SecurityException exception) {
                Log.w(TAG, "Permission disappeared while removing updates", exception);
            }
        }
        updatesRegistered = false;
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private boolean hasPreciseLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasEnabledProvider() {
        if (locationManager == null) return false;
        for (String provider : new String[] {
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER
        }) {
            try {
                if (locationManager.isProviderEnabled(provider)) return true;
            } catch (RuntimeException ignored) {
                // Provider is absent or not queryable on this device.
            }
        }
        return false;
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void broadcastSample(long sequence, String sessionId) {
        Intent event = baseEvent(SurveyContract.EVENT_LOCATION_SAMPLE, sessionId);
        event.putExtra(SurveyContract.EXTRA_SEQUENCE, sequence);
        sendBroadcast(event);
    }

    private void broadcastState(SurveyLocationStore.SessionState state) {
        if (state == null) return;
        sendBroadcast(baseEvent(SurveyContract.EVENT_STATE_CHANGED, state.sessionId));
    }

    private void broadcastError(String sessionId, String code, String message) {
        Intent event = baseEvent(SurveyContract.EVENT_TRACKING_ERROR, sessionId);
        event.putExtra(SurveyContract.EXTRA_ERROR_CODE, code);
        event.putExtra(SurveyContract.EXTRA_ERROR_MESSAGE, message);
        sendBroadcast(event);
    }

    private Intent baseEvent(String eventName, String sessionId) {
        Intent event = new Intent(SurveyContract.ACTION_EVENT);
        event.setPackage(getPackageName());
        event.putExtra(SurveyContract.EXTRA_EVENT, eventName);
        event.putExtra(SurveyContract.EXTRA_SESSION_ID, sessionId);
        return event;
    }

    private static String activityLabel(String activity) {
        if (SurveyContract.ACTIVITY_PICKING.equals(activity)) return "Plukker";
        if (SurveyContract.ACTIVITY_TRANSPORT.equals(activity)) return "Transport";
        return "Undersøker";
    }
}
