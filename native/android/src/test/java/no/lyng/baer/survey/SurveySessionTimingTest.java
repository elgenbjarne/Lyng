package no.lyng.baer.survey;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class SurveySessionTimingTest {
    @Test
    public void resumeAddsCurrentPauseToPreviouslyAccumulatedTime() {
        assertEquals(
            7_500L,
            SurveySessionTiming.accumulatePauseMs(2_500L, 10_000L, 15_000L)
        );
    }

    @Test
    public void activeSessionKeepsPreviouslyAccumulatedTime() {
        assertEquals(
            2_500L,
            SurveySessionTiming.accumulatePauseMs(2_500L, null, 15_000L)
        );
    }

    @Test
    public void backwardWallClockNeverSubtractsPauseTime() {
        assertEquals(
            2_500L,
            SurveySessionTiming.accumulatePauseMs(2_500L, 20_000L, 15_000L)
        );
    }

    @Test
    public void pauseDurationSaturatesInsteadOfOverflowing() {
        assertEquals(
            Long.MAX_VALUE,
            SurveySessionTiming.accumulatePauseMs(Long.MAX_VALUE - 5L, 10L, 20L)
        );
    }

    @Test
    public void activeRevisionMustMatchTheCallbackObservation() {
        assertEquals(
            true,
            SurveySessionTiming.isCurrentActiveRevision(
                SurveyContract.STATUS_ACTIVE,
                7L,
                7L
            )
        );
        assertEquals(
            false,
            SurveySessionTiming.isCurrentActiveRevision(
                SurveyContract.STATUS_ACTIVE,
                9L,
                7L
            )
        );
        assertEquals(
            false,
            SurveySessionTiming.isCurrentActiveRevision(
                SurveyContract.STATUS_PAUSED,
                7L,
                7L
            )
        );
    }

    @Test
    public void pauseResumeAdvancesPastAnObservedRevision() {
        long observed = 4L;
        long paused = SurveySessionTiming.nextStateRevision(observed);
        long resumed = SurveySessionTiming.nextStateRevision(paused);

        assertEquals(5L, paused);
        assertEquals(6L, resumed);
        assertEquals(
            false,
            SurveySessionTiming.isCurrentActiveRevision(
                SurveyContract.STATUS_ACTIVE,
                resumed,
                observed
            )
        );
    }
}
