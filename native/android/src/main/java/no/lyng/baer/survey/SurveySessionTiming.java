package no.lyng.baer.survey;

/** Pure-Java helpers for durable survey pause accounting. */
final class SurveySessionTiming {
    private SurveySessionTiming() {}

    static long nextStateRevision(long storedRevision) {
        if (storedRevision < 0L) {
            throw new IllegalArgumentException("State revision cannot be negative");
        }
        return Math.addExact(storedRevision, 1L);
    }

    static boolean isCurrentActiveRevision(
        String status,
        long currentRevision,
        long expectedRevision
    ) {
        return SurveyContract.STATUS_ACTIVE.equals(status)
            && expectedRevision >= 0L
            && currentRevision == expectedRevision;
    }

    static long accumulatePauseMs(long storedPauseMs, Long pausedAtMs, long transitionAtMs) {
        long stored = Math.max(0L, storedPauseMs);
        if (pausedAtMs == null || transitionAtMs <= pausedAtMs) return stored;

        long elapsed;
        try {
            elapsed = Math.subtractExact(transitionAtMs, pausedAtMs);
        } catch (ArithmeticException overflow) {
            return Long.MAX_VALUE;
        }
        if (Long.MAX_VALUE - stored < elapsed) return Long.MAX_VALUE;
        return stored + elapsed;
    }
}
