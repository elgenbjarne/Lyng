package no.lyng.baer.survey;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LocationQualityEvaluatorTest {
    private static final long NOW_MS = 1_800_000_000_000L;
    private static final long NOW_ELAPSED_NS = 900_000_000_000L;
    private static final LocationQualityEvaluator.Thresholds THRESHOLDS =
        new LocationQualityEvaluator.Thresholds(6.0, 12.0, 25.0, 12.0, 55.0);

    @Test
    public void accuracyBandsAreStableAndPoorRemainsAccepted() {
        assertQuality(6.0, SurveyContract.QUALITY_GOOD, true);
        assertQuality(12.0, SurveyContract.QUALITY_ACCEPTABLE, true);
        assertQuality(25.0, SurveyContract.QUALITY_POOR, true);
    }

    @Test
    public void accuracyBeyondPoorIsRejectedButRawCanStillBeStored() {
        LocationQualityEvaluator.Result result = evaluate(raw(35.0, false), null, "SEARCHING");

        assertFalse(result.accepted);
        assertEquals(SurveyContract.QUALITY_REJECTED, result.quality);
        assertEquals(SurveyContract.REJECT_BAD_ACCURACY, result.rejectionReason);
    }

    @Test
    public void mockLocationIsRejected() {
        LocationQualityEvaluator.Result result = evaluate(raw(5.0, true), null, "SEARCHING");

        assertFalse(result.accepted);
        assertEquals(SurveyContract.REJECT_MOCK_LOCATION, result.rejectionReason);
    }

    @Test
    public void threeHundredMeterJumpInFiveSecondsIsRejectedOnFoot() {
        LocationQualityEvaluator.AcceptedPoint previous = new LocationQualityEvaluator.AcceptedPoint(
            60.0,
            10.0,
            NOW_MS - 5_000L,
            NOW_ELAPSED_NS - 5_000_000_000L,
            5.0
        );
        LocationQualityEvaluator.RawPoint jumped = new LocationQualityEvaluator.RawPoint(
            60.0027,
            10.0,
            NOW_MS,
            NOW_ELAPSED_NS,
            true,
            5.0,
            false
        );

        LocationQualityEvaluator.Result result = evaluate(jumped, previous, "SEARCHING");

        assertFalse(result.accepted);
        assertEquals(SurveyContract.REJECT_IMPLAUSIBLE_JUMP, result.rejectionReason);
    }

    @Test
    public void transportAllowsSpeedThatWouldBeRejectedOnFoot() {
        LocationQualityEvaluator.AcceptedPoint previousOnFoot = new LocationQualityEvaluator.AcceptedPoint(
            60.0,
            10.0,
            NOW_MS - 5_000L,
            NOW_ELAPSED_NS - 5_000_000_000L,
            5.0,
            0L,
            SurveyContract.ACTIVITY_SEARCHING
        );
        LocationQualityEvaluator.AcceptedPoint previousInTransport = new LocationQualityEvaluator.AcceptedPoint(
            60.0,
            10.0,
            NOW_MS - 5_000L,
            NOW_ELAPSED_NS - 5_000_000_000L,
            5.0,
            0L,
            SurveyContract.ACTIVITY_TRANSPORT
        );
        // About 200 metres in five seconds: plausible transport, not plausible walking.
        LocationQualityEvaluator.RawPoint moved = new LocationQualityEvaluator.RawPoint(
            60.0018,
            10.0,
            NOW_MS,
            NOW_ELAPSED_NS,
            true,
            5.0,
            false
        );

        LocationQualityEvaluator.Result onFoot = evaluate(
            moved,
            previousOnFoot,
            "SEARCHING"
        );
        assertFalse(onFoot.accepted);
        assertEquals(SurveyContract.REJECT_IMPLAUSIBLE_JUMP, onFoot.rejectionReason);
        assertTrue(evaluate(moved, previousInTransport, "TRANSPORT").accepted);
    }

    @Test
    public void duplicateAndStaleSamplesAreRejectedSeparately() {
        LocationQualityEvaluator.AcceptedPoint previous = new LocationQualityEvaluator.AcceptedPoint(
            60.0,
            10.0,
            NOW_MS - 1_000L,
            NOW_ELAPSED_NS - 1_000_000_000L,
            5.0
        );
        LocationQualityEvaluator.RawPoint duplicate = new LocationQualityEvaluator.RawPoint(
            60.0,
            10.0,
            NOW_MS,
            NOW_ELAPSED_NS,
            true,
            5.0,
            false
        );
        assertEquals(
            SurveyContract.REJECT_DUPLICATE,
            evaluate(duplicate, previous, "SEARCHING").rejectionReason
        );

        LocationQualityEvaluator.RawPoint stale = new LocationQualityEvaluator.RawPoint(
            60.0,
            10.0,
            NOW_MS - 121_000L,
            NOW_ELAPSED_NS - 121_000_000_000L,
            true,
            5.0,
            false
        );
        assertEquals(
            SurveyContract.REJECT_STALE,
            evaluate(stale, null, "SEARCHING").rejectionReason
        );
    }

    @Test
    public void rebootFallsBackToWallClockForPersistedPredecessor() {
        LocationQualityEvaluator.AcceptedPoint beforeReboot =
            new LocationQualityEvaluator.AcceptedPoint(
                60.0,
                10.0,
                NOW_MS - 10_000L,
                4_000_000_000_000L,
                5.0,
                41L
            );
        LocationQualityEvaluator.RawPoint afterReboot = new LocationQualityEvaluator.RawPoint(
            60.0001,
            10.0,
            NOW_MS,
            NOW_ELAPSED_NS,
            true,
            5.0,
            false,
            42L
        );

        assertTrue(evaluate(afterReboot, beforeReboot, "SEARCHING").accepted);
    }

    @Test
    public void bootIdentityWinsEvenWhenNewUptimeExceedsOldUptime() {
        LocationQualityEvaluator.AcceptedPoint beforeReboot =
            new LocationQualityEvaluator.AcceptedPoint(
                60.0, 10.0, NOW_MS - 10_000L, 20_000_000_000L, 5.0, 41L
            );
        LocationQualityEvaluator.RawPoint afterReboot = new LocationQualityEvaluator.RawPoint(
            60.0001, 10.0, NOW_MS, 900_000_000_000L, true, 5.0, false, 42L
        );

        assertTrue(evaluate(afterReboot, beforeReboot, "SEARCHING").accepted);
    }

    @Test
    public void backwardWallClockAfterRebootStartsANewChain() {
        LocationQualityEvaluator.AcceptedPoint beforeReboot =
            new LocationQualityEvaluator.AcceptedPoint(
                60.0, 10.0, NOW_MS + 60_000L, 4_000_000_000_000L, 5.0, 41L
            );
        LocationQualityEvaluator.RawPoint afterReboot = new LocationQualityEvaluator.RawPoint(
            60.0001, 10.0, NOW_MS, NOW_ELAPSED_NS, true, 5.0, false, 42L
        );

        assertTrue(evaluate(afterReboot, beforeReboot, "SEARCHING").accepted);
    }

    @Test
    public void decreasingMonotonicClockInsideSameBootIsOutOfOrder() {
        LocationQualityEvaluator.AcceptedPoint previous =
            new LocationQualityEvaluator.AcceptedPoint(
                60.0, 10.0, NOW_MS - 10_000L, NOW_ELAPSED_NS + 1L, 5.0, 42L
            );
        LocationQualityEvaluator.RawPoint current = new LocationQualityEvaluator.RawPoint(
            60.0001, 10.0, NOW_MS, NOW_ELAPSED_NS, true, 5.0, false, 42L
        );

        assertEquals(
            SurveyContract.REJECT_OUT_OF_ORDER,
            evaluate(current, previous, "SEARCHING").rejectionReason
        );
    }

    @Test(expected = IllegalArgumentException.class)
    public void thresholdsMustBeMonotonic() {
        new LocationQualityEvaluator.Thresholds(12.0, 6.0, 25.0, 12.0, 55.0);
    }

    private static void assertQuality(double accuracy, String quality, boolean accepted) {
        LocationQualityEvaluator.Result result = evaluate(raw(accuracy, false), null, "SEARCHING");
        assertEquals(quality, result.quality);
        assertEquals(accepted, result.accepted);
    }

    private static LocationQualityEvaluator.RawPoint raw(double accuracy, boolean mock) {
        return new LocationQualityEvaluator.RawPoint(
            60.0,
            10.0,
            NOW_MS,
            NOW_ELAPSED_NS,
            true,
            accuracy,
            mock
        );
    }

    private static LocationQualityEvaluator.Result evaluate(
        LocationQualityEvaluator.RawPoint point,
        LocationQualityEvaluator.AcceptedPoint previous,
        String activity
    ) {
        return LocationQualityEvaluator.evaluate(
            point,
            previous,
            activity,
            NOW_MS,
            NOW_ELAPSED_NS,
            THRESHOLDS
        );
    }
}
