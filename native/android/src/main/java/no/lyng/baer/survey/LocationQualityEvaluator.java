package no.lyng.baer.survey;

/**
 * Pure-Java, conservative quality filter. Every raw sample is still persisted;
 * this class only decides whether it may also be used as an accepted track point.
 */
public final class LocationQualityEvaluator {
    private static final double EARTH_RADIUS_METERS = 6_371_008.8;

    private LocationQualityEvaluator() {}

    public static final class Thresholds {
        public final double goodAccuracyMeters;
        public final double acceptableAccuracyMeters;
        public final double poorAccuracyMeters;
        public final double maxOnFootSpeedMetersPerSecond;
        public final double maxTransportSpeedMetersPerSecond;
        public final long maxSampleAgeMs;
        public final double minimumJumpAllowanceMeters;
        public final double maximumAccuracyAllowanceMeters;

        public Thresholds(
            double goodAccuracyMeters,
            double acceptableAccuracyMeters,
            double poorAccuracyMeters,
            double maxOnFootSpeedMetersPerSecond,
            double maxTransportSpeedMetersPerSecond
        ) {
            this(
                goodAccuracyMeters,
                acceptableAccuracyMeters,
                poorAccuracyMeters,
                maxOnFootSpeedMetersPerSecond,
                maxTransportSpeedMetersPerSecond,
                120_000L,
                30.0,
                60.0
            );
        }

        public Thresholds(
            double goodAccuracyMeters,
            double acceptableAccuracyMeters,
            double poorAccuracyMeters,
            double maxOnFootSpeedMetersPerSecond,
            double maxTransportSpeedMetersPerSecond,
            long maxSampleAgeMs,
            double minimumJumpAllowanceMeters,
            double maximumAccuracyAllowanceMeters
        ) {
            if (!isFinite(goodAccuracyMeters)
                || !isFinite(acceptableAccuracyMeters)
                || !isFinite(poorAccuracyMeters)
                || !isFinite(maxOnFootSpeedMetersPerSecond)
                || !isFinite(maxTransportSpeedMetersPerSecond)
                || !(goodAccuracyMeters > 0.0)
                || acceptableAccuracyMeters < goodAccuracyMeters
                || poorAccuracyMeters < acceptableAccuracyMeters
                || !(maxOnFootSpeedMetersPerSecond > 0.0)
                || maxTransportSpeedMetersPerSecond < maxOnFootSpeedMetersPerSecond) {
                throw new IllegalArgumentException("Invalid location-quality thresholds");
            }
            this.goodAccuracyMeters = goodAccuracyMeters;
            this.acceptableAccuracyMeters = acceptableAccuracyMeters;
            this.poorAccuracyMeters = poorAccuracyMeters;
            this.maxOnFootSpeedMetersPerSecond = maxOnFootSpeedMetersPerSecond;
            this.maxTransportSpeedMetersPerSecond = maxTransportSpeedMetersPerSecond;
            this.maxSampleAgeMs = Math.max(1_000L, maxSampleAgeMs);
            this.minimumJumpAllowanceMeters = Math.max(1.0, minimumJumpAllowanceMeters);
            this.maximumAccuracyAllowanceMeters = Math.max(0.0, maximumAccuracyAllowanceMeters);
        }
    }

    public static final class RawPoint {
        public final double latitude;
        public final double longitude;
        public final long recordedAtMs;
        public final long elapsedRealtimeNanos;
        public final boolean hasAccuracy;
        public final double accuracyMeters;
        public final boolean mock;
        public final long bootId;

        public RawPoint(
            double latitude,
            double longitude,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            boolean hasAccuracy,
            double accuracyMeters,
            boolean mock
        ) {
            this(
                latitude,
                longitude,
                recordedAtMs,
                elapsedRealtimeNanos,
                hasAccuracy,
                accuracyMeters,
                mock,
                0L
            );
        }

        public RawPoint(
            double latitude,
            double longitude,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            boolean hasAccuracy,
            double accuracyMeters,
            boolean mock,
            long bootId
        ) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.recordedAtMs = recordedAtMs;
            this.elapsedRealtimeNanos = elapsedRealtimeNanos;
            this.hasAccuracy = hasAccuracy;
            this.accuracyMeters = accuracyMeters;
            this.mock = mock;
            this.bootId = bootId;
        }
    }

    public static final class AcceptedPoint {
        public final double latitude;
        public final double longitude;
        public final long recordedAtMs;
        public final long elapsedRealtimeNanos;
        public final double accuracyMeters;
        public final long bootId;
        public final String activity;

        public AcceptedPoint(
            double latitude,
            double longitude,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            double accuracyMeters
        ) {
            this(
                latitude,
                longitude,
                recordedAtMs,
                elapsedRealtimeNanos,
                accuracyMeters,
                0L,
                SurveyContract.ACTIVITY_SEARCHING
            );
        }

        public AcceptedPoint(
            double latitude,
            double longitude,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            double accuracyMeters,
            long bootId
        ) {
            this(
                latitude,
                longitude,
                recordedAtMs,
                elapsedRealtimeNanos,
                accuracyMeters,
                bootId,
                SurveyContract.ACTIVITY_SEARCHING
            );
        }

        public AcceptedPoint(
            double latitude,
            double longitude,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            double accuracyMeters,
            long bootId,
            String activity
        ) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.recordedAtMs = recordedAtMs;
            this.elapsedRealtimeNanos = elapsedRealtimeNanos;
            this.accuracyMeters = accuracyMeters;
            this.bootId = bootId;
            this.activity = SurveyContract.normalizeActivity(activity);
        }
    }

    public static final class Result {
        public final String quality;
        public final boolean accepted;
        public final String rejectionReason;

        private Result(String quality, boolean accepted, String rejectionReason) {
            this.quality = quality;
            this.accepted = accepted;
            this.rejectionReason = rejectionReason;
        }

        static Result accepted(String quality) {
            return new Result(quality, true, null);
        }

        static Result rejected(String reason) {
            return new Result(SurveyContract.QUALITY_REJECTED, false, reason);
        }
    }

    public static Result evaluate(
        RawPoint point,
        AcceptedPoint previousAccepted,
        String activity,
        long nowMs,
        long nowElapsedRealtimeNanos,
        Thresholds thresholds
    ) {
        if (!isCoordinateValid(point.latitude, point.longitude)) {
            return Result.rejected(SurveyContract.REJECT_INVALID_COORDINATE);
        }
        if (point.mock) {
            return Result.rejected(SurveyContract.REJECT_MOCK_LOCATION);
        }
        if (!point.hasAccuracy || !isFinite(point.accuracyMeters)) {
            return Result.rejected(SurveyContract.REJECT_MISSING_ACCURACY);
        }
        if (point.accuracyMeters < 0.0 || point.accuracyMeters > thresholds.poorAccuracyMeters) {
            return Result.rejected(SurveyContract.REJECT_BAD_ACCURACY);
        }
        if (isStale(point, nowMs, nowElapsedRealtimeNanos, thresholds.maxSampleAgeMs)) {
            return Result.rejected(SurveyContract.REJECT_STALE);
        }

        // A reboot starts a new monotonic timeline. Wall-clock corrections made
        // during boot must not pin every new sample behind an old predecessor.
        if (
            previousAccepted != null
                && point.bootId == previousAccepted.bootId
                && SurveyContract.normalizeActivity(activity).equals(previousAccepted.activity)
        ) {
            double elapsedSeconds = elapsedSeconds(
                point,
                previousAccepted,
                nowElapsedRealtimeNanos
            );
            if (!(elapsedSeconds > 0.0)) {
                return Result.rejected(SurveyContract.REJECT_OUT_OF_ORDER);
            }

            double distanceMeters = distanceMeters(
                previousAccepted.latitude,
                previousAccepted.longitude,
                point.latitude,
                point.longitude
            );
            if (elapsedSeconds <= 2.0 && distanceMeters < 1.0) {
                return Result.rejected(SurveyContract.REJECT_DUPLICATE);
            }

            double maxSpeed = SurveyContract.ACTIVITY_TRANSPORT.equals(
                SurveyContract.normalizeActivity(activity)
            )
                ? thresholds.maxTransportSpeedMetersPerSecond
                : thresholds.maxOnFootSpeedMetersPerSecond;
            double accuracyAllowance = Math.min(
                thresholds.maximumAccuracyAllowanceMeters,
                point.accuracyMeters + previousAccepted.accuracyMeters
            );
            double jumpAllowance = Math.max(
                thresholds.minimumJumpAllowanceMeters,
                maxSpeed * elapsedSeconds + accuracyAllowance
            );
            if (distanceMeters > jumpAllowance) {
                return Result.rejected(SurveyContract.REJECT_IMPLAUSIBLE_JUMP);
            }
        }

        if (point.accuracyMeters <= thresholds.goodAccuracyMeters) {
            return Result.accepted(SurveyContract.QUALITY_GOOD);
        }
        if (point.accuracyMeters <= thresholds.acceptableAccuracyMeters) {
            return Result.accepted(SurveyContract.QUALITY_ACCEPTABLE);
        }
        return Result.accepted(SurveyContract.QUALITY_POOR);
    }

    static boolean isCoordinateValid(double latitude, double longitude) {
        return isFinite(latitude)
            && isFinite(longitude)
            && latitude >= -90.0
            && latitude <= 90.0
            && longitude >= -180.0
            && longitude <= 180.0;
    }

    static boolean isFinite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    static double distanceMeters(double lat1, double lon1, double lat2, double lon2) {
        double lat1Rad = Math.toRadians(lat1);
        double lat2Rad = Math.toRadians(lat2);
        double deltaLat = Math.toRadians(lat2 - lat1);
        double deltaLon = Math.toRadians(lon2 - lon1);
        double sinLat = Math.sin(deltaLat / 2.0);
        double sinLon = Math.sin(deltaLon / 2.0);
        double a = sinLat * sinLat
            + Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinLon * sinLon;
        double clamped = Math.max(0.0, Math.min(1.0, a));
        return EARTH_RADIUS_METERS
            * 2.0
            * Math.atan2(Math.sqrt(clamped), Math.sqrt(1.0 - clamped));
    }

    private static boolean isStale(
        RawPoint point,
        long nowMs,
        long nowElapsedRealtimeNanos,
        long maxSampleAgeMs
    ) {
        if (point.elapsedRealtimeNanos > 0L && nowElapsedRealtimeNanos > 0L) {
            long ageNanos = nowElapsedRealtimeNanos - point.elapsedRealtimeNanos;
            return ageNanos < -10_000_000_000L || ageNanos > maxSampleAgeMs * 1_000_000L;
        }
        if (point.recordedAtMs <= 0L) return true;
        long ageMs = nowMs - point.recordedAtMs;
        return ageMs < -10_000L || ageMs > maxSampleAgeMs;
    }

    private static double elapsedSeconds(
        RawPoint point,
        AcceptedPoint previous,
        long nowElapsedRealtimeNanos
    ) {
        if (
            point.bootId == previous.bootId
                && point.elapsedRealtimeNanos > 0L
                && previous.elapsedRealtimeNanos > 0L
        ) {
            return (point.elapsedRealtimeNanos - previous.elapsedRealtimeNanos)
                / 1_000_000_000.0;
        }
        // Android's monotonic counter resets at reboot. Explicit boot identity
        // prevents a later uptime that happens to exceed the old value from
        // looking like a valid same-boot interval.
        return (point.recordedAtMs - previous.recordedAtMs) / 1_000.0;
    }
}
