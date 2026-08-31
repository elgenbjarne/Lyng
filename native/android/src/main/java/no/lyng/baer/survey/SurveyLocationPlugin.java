package no.lyng.baer.survey;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/** Capacitor API for controlling the native, persistent survey tracker. */
@CapacitorPlugin(
    name = "SurveyLocation",
    permissions = {
        @Permission(
            strings = {
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            },
            alias = "location"
        ),
        @Permission(
            strings = { Manifest.permission.POST_NOTIFICATIONS },
            alias = "notifications"
        )
    }
)
public final class SurveyLocationPlugin extends Plugin {
    private static final String TAG = "LyngSurveyLocation";
    private SurveyLocationStore store;
    private boolean receiverRegistered;

    private final BroadcastReceiver serviceEventReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !SurveyContract.ACTION_EVENT.equals(intent.getAction())) return;
            String eventName = intent.getStringExtra(SurveyContract.EXTRA_EVENT);
            String sessionId = intent.getStringExtra(SurveyContract.EXTRA_SESSION_ID);
            if (SurveyContract.EVENT_LOCATION_SAMPLE.equals(eventName)) {
                long sequence = intent.getLongExtra(SurveyContract.EXTRA_SEQUENCE, 0L);
                SurveyLocationStore.Sample sample = store.getSample(sequence);
                if (sample != null) notifyListeners(eventName, sampleToJson(sample));
                return;
            }
            if (SurveyContract.EVENT_STATE_CHANGED.equals(eventName)) {
                SurveyLocationStore.SessionState state = store.getSession(sessionId);
                if (state != null) notifyListeners(eventName, stateToJson(state));
                return;
            }
            if (SurveyContract.EVENT_TRACKING_ERROR.equals(eventName)) {
                JSObject error = new JSObject();
                error.put("sessionId", sessionId);
                error.put(
                    "code",
                    intent.getStringExtra(SurveyContract.EXTRA_ERROR_CODE)
                );
                error.put(
                    "message",
                    intent.getStringExtra(SurveyContract.EXTRA_ERROR_MESSAGE)
                );
                notifyListeners(eventName, error);
            }
        }
    };

    @Override
    public void load() {
        super.load();
        store = new SurveyLocationStore(getContext());
        IntentFilter filter = new IntentFilter(SurveyContract.ACTION_EVENT);
        ContextCompat.registerReceiver(
            getContext(),
            serviceEventReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        receiverRegistered = true;
    }

    @Override
    protected void handleOnDestroy() {
        if (receiverRegistered) {
            try {
                getContext().unregisterReceiver(serviceEventReceiver);
            } catch (IllegalArgumentException ignored) {
                // The platform may already have released the Activity receiver.
            }
            receiverRegistered = false;
        }
        if (store != null) store.close();
        // Never stop SurveyLocationService here. The service is intentionally
        // independent of the Activity/WebView lifecycle.
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasPreciseLocationPermission()) {
            call.reject(
                "Precise location permission is required",
                "PRECISE_LOCATION_REQUIRED"
            );
            return;
        }
        if (!hasNotificationPermission()) {
            call.reject(
                "Notification permission is required for foreground tracking",
                "NOTIFICATION_PERMISSION_REQUIRED"
            );
            return;
        }

        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        String activity = call.getString(
            "activity",
            SurveyContract.ACTIVITY_SEARCHING
        );
        if (!SurveyContract.isValidActivity(activity)) {
            call.reject("Invalid activity", "INVALID_ACTIVITY");
            return;
        }

        SurveyLocationStore.SessionState state;
        try {
            SurveyLocationStore.SessionConfig config = new SurveyLocationStore.SessionConfig(
                sessionId,
                activity,
                longOption(call, "intervalMs", SurveyContract.DEFAULT_INTERVAL_MS),
                call.getDouble(
                    "minDistanceMeters",
                    (double) SurveyContract.DEFAULT_MIN_DISTANCE_METERS
                ),
                call.getDouble(
                    "goodAccuracyMeters",
                    SurveyContract.DEFAULT_GOOD_ACCURACY_METERS
                ),
                call.getDouble(
                    "acceptableAccuracyMeters",
                    SurveyContract.DEFAULT_ACCEPTABLE_ACCURACY_METERS
                ),
                call.getDouble(
                    "poorAccuracyMeters",
                    SurveyContract.DEFAULT_POOR_ACCURACY_METERS
                ),
                call.getDouble(
                    "maxOnFootSpeedMetersPerSecond",
                    SurveyContract.DEFAULT_MAX_ON_FOOT_SPEED_MPS
                ),
                call.getDouble(
                    "maxTransportSpeedMetersPerSecond",
                    SurveyContract.DEFAULT_MAX_TRANSPORT_SPEED_MPS
                )
            );
            state = store.startSession(config);
            if (SurveyContract.STATUS_PAUSED.equals(state.status)) {
                call.reject(
                    "Session is paused; use resume instead of start",
                    "SESSION_PAUSED"
                );
                return;
            }
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_ARGUMENT", exception);
            return;
        } catch (RuntimeException exception) {
            call.reject(
                "Could not create native survey session",
                "START_FAILED",
                exception
            );
            return;
        }
        try {
            dispatchForegroundCommand(SurveyContract.ACTION_START, sessionId);
            call.resolve(stateToJson(state));
        } catch (RuntimeException exception) {
            safelyPauseAfterStartFailure(sessionId, exception);
            call.reject(
                "Could not start native survey tracking",
                "START_FAILED",
                exception
            );
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        try {
            SurveyLocationStore.SessionState state = store.pauseSession(sessionId);
            try {
                dispatchStopCommand(sessionId);
            } catch (RuntimeException commandError) {
                // PAUSED is already durable and callbacks cannot append after it.
                // Resolve the authoritative state instead of creating JS split-brain.
                Log.w(TAG, "Survey paused but service STOP could not be queued", commandError);
            }
            notifyListeners(SurveyContract.EVENT_STATE_CHANGED, stateToJson(state));
            call.resolve(stateToJson(state));
        } catch (RuntimeException exception) {
            call.reject("Could not pause survey", "PAUSE_FAILED", exception);
        }
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (!hasPreciseLocationPermission()) {
            call.reject(
                "Precise location permission is required",
                "PRECISE_LOCATION_REQUIRED"
            );
            return;
        }
        if (!hasNotificationPermission()) {
            call.reject(
                "Notification permission is required for foreground tracking",
                "NOTIFICATION_PERMISSION_REQUIRED"
            );
            return;
        }
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        SurveyLocationStore.SessionState state;
        try {
            SurveyLocationStore.SessionState current = store.getSession(sessionId);
            // Foreground recovery intentionally calls resume for an already
            // ACTIVE row. Avoid manufacturing a second state transition while
            // still dispatching ACTION_RESUME below to repair a missing FGS.
            state = current != null && SurveyContract.STATUS_ACTIVE.equals(current.status)
                ? current
                : store.resumeSession(sessionId);
        } catch (RuntimeException exception) {
            call.reject("Could not prepare survey resume", "RESUME_FAILED", exception);
            return;
        }
        try {
            dispatchForegroundCommand(SurveyContract.ACTION_RESUME, sessionId);
            call.resolve(stateToJson(state));
        } catch (RuntimeException exception) {
            safelyPauseAfterStartFailure(sessionId, exception);
            call.reject("Could not resume survey", "RESUME_FAILED", exception);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        try {
            SurveyLocationStore.SessionState state = store.completeSession(sessionId);
            try {
                // Always send the session-scoped command. An idempotent stop may
                // be repairing a previously lost service command even though the
                // durable row was already COMPLETED.
                dispatchStopCommand(sessionId);
            } catch (RuntimeException commandError) {
                // COMPLETED is terminal and already committed. Returning a
                // rejection here would incorrectly leave the WebView active.
                Log.w(TAG, "Survey completed but service STOP could not be queued", commandError);
            }
            notifyListeners(SurveyContract.EVENT_STATE_CHANGED, stateToJson(state));
            call.resolve(stateToJson(state));
        } catch (RuntimeException exception) {
            call.reject("Could not stop survey", "STOP_FAILED", exception);
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        try {
            String sessionId = call.getString("sessionId");
            SurveyLocationStore.SessionState state = sessionId == null
                ? store.getOpenSession()
                : store.getSession(sessionId);
            JSObject result = new JSObject();
            result.put("state", state == null ? JSONObject.NULL : stateToJson(state));
            result.put("preciseLocationPermission", hasPreciseLocationPermission());
            result.put("notificationPermission", hasNotificationPermission());
            result.put(
                "shouldBeTracking",
                state != null && SurveyContract.STATUS_ACTIVE.equals(state.status)
            );
            call.resolve(result);
        } catch (RuntimeException exception) {
            call.reject("Could not read survey state", "GET_STATE_FAILED", exception);
        }
    }

    @PluginMethod
    public void getSessions(PluginCall call) {
        try {
            JSArray sessions = new JSArray();
            for (SurveyLocationStore.SessionState state : store.getSessions()) {
                sessions.put(stateToJson(state));
            }
            JSObject result = new JSObject();
            result.put("sessions", sessions);
            call.resolve(result);
        } catch (RuntimeException exception) {
            call.reject("Could not read survey sessions", "GET_SESSIONS_FAILED", exception);
        }
    }

    @PluginMethod
    public void getSamples(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        try {
            long afterSequence = longOption(call, "afterSequence", 0L);
            int limit = call.getInt("limit", 1_000);
            boolean acceptedOnly = call.getBoolean("acceptedOnly", false);
            SurveyLocationStore.SamplePage page = store.getSamples(
                sessionId,
                afterSequence,
                limit,
                acceptedOnly
            );
            JSArray samples = new JSArray();
            for (SurveyLocationStore.Sample sample : page.samples) {
                samples.put(sampleToJson(sample));
            }
            JSObject result = new JSObject();
            result.put("samples", samples);
            result.put("nextSequence", page.nextSequence);
            result.put("hasMore", page.hasMore);
            call.resolve(result);
        } catch (RuntimeException exception) {
            call.reject("Could not read location samples", "GET_SAMPLES_FAILED", exception);
        }
    }

    @PluginMethod
    public void setActivity(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        String activity = call.getString("activity");
        if (!SurveyContract.isValidActivity(activity)) {
            call.reject("Invalid activity", "INVALID_ACTIVITY");
            return;
        }
        try {
            SurveyLocationStore.SessionState state = store.setActivity(sessionId, activity);
            // The already-started service reads activity from SQLite for every
            // sample, so no Activity-bound command is required for correctness.
            notifyListeners(SurveyContract.EVENT_STATE_CHANGED, stateToJson(state));
            call.resolve(stateToJson(state));
        } catch (RuntimeException exception) {
            call.reject("Could not change activity", "SET_ACTIVITY_FAILED", exception);
        }
    }

    @PluginMethod
    public void deleteSamples(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        if (!call.getBoolean("confirm", false)) {
            call.reject("deleteSamples requires confirm=true", "CONFIRMATION_REQUIRED");
            return;
        }
        try {
            int deleted = store.deleteSamples(sessionId);
            try {
                // The row is already terminal and the raw deletion is durable.
                // Queue a scoped STOP as a repair for an earlier command that
                // may have been lost while the foreground service stayed alive.
                dispatchStopCommand(sessionId);
            } catch (RuntimeException commandError) {
                Log.w(TAG, "Survey samples deleted but service STOP could not be queued", commandError);
            }
            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            result.put("deleted", deleted);
            call.resolve(result);
        } catch (RuntimeException exception) {
            call.reject("Could not delete samples", "DELETE_SAMPLES_FAILED", exception);
        }
    }

    @PluginMethod
    public void deleteSession(PluginCall call) {
        String sessionId = requiredSessionId(call);
        if (sessionId == null) return;
        if (!call.getBoolean("confirm", false)) {
            call.reject("deleteSession requires confirm=true", "CONFIRMATION_REQUIRED");
            return;
        }
        try {
            int deleted = store.deleteSession(sessionId);
            try {
                // The service validates the session id before stopping, so a
                // delayed command cannot stop a newer survey. Dispatch after
                // deletion to repair any stale service instance best-effort.
                dispatchStopCommand(sessionId);
            } catch (RuntimeException commandError) {
                Log.w(TAG, "Survey session deleted but service STOP could not be queued", commandError);
            }
            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            result.put("deleted", deleted);
            call.resolve(result);
        } catch (RuntimeException exception) {
            call.reject("Could not delete survey session", "DELETE_SESSION_FAILED", exception);
        }
    }

    private String requiredSessionId(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.trim().isEmpty() || sessionId.length() > 160) {
            call.reject("A non-empty sessionId is required", "INVALID_SESSION_ID");
            return null;
        }
        return sessionId;
    }

    private static long longOption(PluginCall call, String name, long defaultValue) {
        Object value = call.getData().opt(name);
        if (value == null || value == JSONObject.NULL) return defaultValue;
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException(name + " must be an integer");
        }
        double numeric = ((Number) value).doubleValue();
        if (
            !LocationQualityEvaluator.isFinite(numeric)
                || numeric != Math.rint(numeric)
                || numeric < Long.MIN_VALUE
                || numeric > Long.MAX_VALUE
        ) {
            throw new IllegalArgumentException(name + " must be an integer");
        }
        return ((Number) value).longValue();
    }

    private void dispatchForegroundCommand(String action, String sessionId) {
        Intent intent = serviceIntent(action, sessionId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    private Intent serviceIntent(String action, String sessionId) {
        Intent intent = new Intent(getContext(), SurveyLocationService.class);
        intent.setAction(action);
        intent.putExtra(SurveyContract.EXTRA_SESSION_ID, sessionId);
        return intent;
    }

    private void dispatchStopCommand(String sessionId) {
        // A global Context.stopService call can race with a new survey and kill
        // its service. The service therefore validates this session id itself.
        getContext().startService(serviceIntent(SurveyContract.ACTION_STOP, sessionId));
    }

    private void safelyPauseAfterStartFailure(String sessionId, RuntimeException exception) {
        try {
            store.setLastError(sessionId, "FOREGROUND_SERVICE_START_FAILED", exception.getMessage());
            store.pauseSession(sessionId);
        } catch (RuntimeException ignored) {
            // Preserve the original startup failure for the bridge response.
        }
        try {
            dispatchStopCommand(sessionId);
        } catch (RuntimeException ignored) {
            // If Android rejected the original service start there may be no
            // service to stop. The database state is already safely PAUSED.
        }
    }

    private boolean hasPreciseLocationPermission() {
        return getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static JSObject stateToJson(SurveyLocationStore.SessionState state) {
        JSObject result = new JSObject();
        result.put("sessionId", state.sessionId);
        result.put("status", state.status);
        result.put("activity", state.activity);
        result.put("stateRevision", state.stateRevision);
        result.put("startedAt", state.startedAtMs);
        result.put("updatedAt", state.updatedAtMs);
        putNullable(result, "endedAt", state.endedAtMs);
        putNullable(result, "pausedAt", state.pausedAtMs);
        result.put("pauseMs", state.pauseMs);
        result.put("intervalMs", state.intervalMs);
        result.put("minDistanceMeters", state.minDistanceMeters);
        result.put("goodAccuracyMeters", state.goodAccuracyMeters);
        result.put("acceptableAccuracyMeters", state.acceptableAccuracyMeters);
        result.put("poorAccuracyMeters", state.poorAccuracyMeters);
        result.put(
            "maxOnFootSpeedMetersPerSecond",
            state.maxOnFootSpeedMetersPerSecond
        );
        result.put(
            "maxTransportSpeedMetersPerSecond",
            state.maxTransportSpeedMetersPerSecond
        );
        putNullable(result, "lastErrorCode", state.lastErrorCode);
        putNullable(result, "lastErrorMessage", state.lastErrorMessage);
        result.put("latestSequence", state.latestSequence);
        result.put("rawSampleCount", state.rawSampleCount);
        result.put("acceptedSampleCount", state.acceptedSampleCount);
        return result;
    }

    private static JSObject sampleToJson(SurveyLocationStore.Sample sample) {
        JSObject result = new JSObject();
        result.put("sequence", sample.sequence);
        result.put("sessionId", sample.sessionId);
        result.put("recordedAt", sample.recordedAtMs);
        // JavaScript cannot represent a nanosecond monotonic counter precisely;
        // expose it as a decimal string while keeping INTEGER in SQLite.
        result.put("elapsedRealtimeNanos", Long.toString(sample.elapsedRealtimeNanos));
        result.put("bootId", Long.toString(sample.bootId));
        result.put("latitude", sample.latitude);
        result.put("longitude", sample.longitude);
        putNullable(result, "accuracy", sample.accuracyMeters);
        putNullable(result, "altitude", sample.altitudeMeters);
        putNullable(result, "altitudeAccuracy", sample.altitudeAccuracyMeters);
        putNullable(result, "speed", sample.speedMetersPerSecond);
        putNullable(result, "heading", sample.headingDegrees);
        putNullable(result, "provider", sample.provider);
        result.put("mock", sample.mock);
        result.put("activity", sample.activity);
        result.put("quality", sample.quality);
        result.put("accepted", sample.accepted);
        putNullable(result, "rejectionReason", sample.rejectionReason);
        return result;
    }

    private static void putNullable(JSObject object, String key, Object value) {
        object.put(key, value == null ? JSONObject.NULL : value);
    }
}
