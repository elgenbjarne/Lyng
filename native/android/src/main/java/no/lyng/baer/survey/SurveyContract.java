package no.lyng.baer.survey;

import java.util.Locale;

/** Shared constants for the service, store, and Capacitor bridge. */
public final class SurveyContract {
    private SurveyContract() {}

    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_PAUSED = "PAUSED";
    public static final String STATUS_COMPLETED = "COMPLETED";

    public static final String ACTIVITY_SEARCHING = "SEARCHING";
    public static final String ACTIVITY_PICKING = "PICKING";
    public static final String ACTIVITY_TRANSPORT = "TRANSPORT";

    public static final String QUALITY_GOOD = "GOOD";
    public static final String QUALITY_ACCEPTABLE = "ACCEPTABLE";
    public static final String QUALITY_POOR = "POOR";
    public static final String QUALITY_REJECTED = "REJECTED";

    public static final String REJECT_MISSING_ACCURACY = "MISSING_ACCURACY";
    public static final String REJECT_BAD_ACCURACY = "BAD_ACCURACY";
    public static final String REJECT_INVALID_COORDINATE = "INVALID_COORDINATE";
    public static final String REJECT_MOCK_LOCATION = "MOCK_LOCATION";
    public static final String REJECT_STALE = "STALE";
    public static final String REJECT_OUT_OF_ORDER = "OUT_OF_ORDER";
    public static final String REJECT_DUPLICATE = "DUPLICATE";
    public static final String REJECT_IMPLAUSIBLE_JUMP = "IMPLAUSIBLE_JUMP";

    public static final long DEFAULT_INTERVAL_MS = 4_000L;
    public static final float DEFAULT_MIN_DISTANCE_METERS = 4.0f;
    public static final double DEFAULT_GOOD_ACCURACY_METERS = 6.0;
    public static final double DEFAULT_ACCEPTABLE_ACCURACY_METERS = 12.0;
    public static final double DEFAULT_POOR_ACCURACY_METERS = 25.0;
    public static final double DEFAULT_MAX_ON_FOOT_SPEED_MPS = 12.0;
    public static final double DEFAULT_MAX_TRANSPORT_SPEED_MPS = 55.0;

    public static final String ACTION_START = "no.lyng.baer.survey.action.START";
    public static final String ACTION_RESUME = "no.lyng.baer.survey.action.RESUME";
    public static final String ACTION_STOP = "no.lyng.baer.survey.action.STOP";
    public static final String ACTION_REFRESH = "no.lyng.baer.survey.action.REFRESH";
    public static final String ACTION_EVENT = "no.lyng.baer.survey.event.NATIVE";

    public static final String EVENT_LOCATION_SAMPLE = "locationSample";
    public static final String EVENT_STATE_CHANGED = "stateChanged";
    public static final String EVENT_TRACKING_ERROR = "trackingError";

    public static final String EXTRA_EVENT = "event";
    public static final String EXTRA_SESSION_ID = "sessionId";
    public static final String EXTRA_SEQUENCE = "sequence";
    public static final String EXTRA_ERROR_CODE = "errorCode";
    public static final String EXTRA_ERROR_MESSAGE = "errorMessage";

    public static boolean isValidActivity(String value) {
        if (value == null) return false;
        String normalized = value.trim().toUpperCase(Locale.ROOT);
        return ACTIVITY_SEARCHING.equals(normalized)
            || ACTIVITY_PICKING.equals(normalized)
            || ACTIVITY_TRANSPORT.equals(normalized);
    }

    public static String normalizeActivity(String value) {
        if (!isValidActivity(value)) return ACTIVITY_SEARCHING;
        return value.trim().toUpperCase(Locale.ROOT);
    }
}
