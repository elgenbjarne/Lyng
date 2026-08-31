package no.lyng.baer.survey;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SurveyContractTest {
    @Test
    public void activityValidationIsCaseInsensitiveButStrict() {
        assertTrue(SurveyContract.isValidActivity("searching"));
        assertTrue(SurveyContract.isValidActivity(" PICKING "));
        assertTrue(SurveyContract.isValidActivity("TRANSPORT"));
        assertFalse(SurveyContract.isValidActivity("AUTO"));
        assertFalse(SurveyContract.isValidActivity(null));
        assertEquals(
            SurveyContract.ACTIVITY_PICKING,
            SurveyContract.normalizeActivity("picking")
        );
    }
}
