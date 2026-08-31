package no.lyng.baer.survey;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** App-private, append-only storage for native survey samples. */
public final class SurveyLocationStore extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "lyng-survey-location.db";
    private static final int DATABASE_VERSION = 4;

    private static final String SESSION_SELECT = "SELECT s.* FROM survey_sessions s ";

    public SurveyLocationStore(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE survey_sessions ("
                + "session_id TEXT PRIMARY KEY NOT NULL,"
                + "status TEXT NOT NULL,"
                + "activity TEXT NOT NULL,"
                + "state_revision INTEGER NOT NULL DEFAULT 0,"
                + "started_at INTEGER NOT NULL,"
                + "updated_at INTEGER NOT NULL,"
                + "ended_at INTEGER,"
                + "paused_at INTEGER,"
                + "pause_ms INTEGER NOT NULL DEFAULT 0,"
                + "interval_ms INTEGER NOT NULL,"
                + "min_distance_m REAL NOT NULL,"
                + "good_accuracy_m REAL NOT NULL,"
                + "acceptable_accuracy_m REAL NOT NULL,"
                + "poor_accuracy_m REAL NOT NULL,"
                + "max_on_foot_speed_mps REAL NOT NULL,"
                + "max_transport_speed_mps REAL NOT NULL,"
                + "latest_sequence INTEGER NOT NULL DEFAULT 0,"
                + "raw_sample_count INTEGER NOT NULL DEFAULT 0,"
                + "accepted_sample_count INTEGER NOT NULL DEFAULT 0,"
                + "last_error_code TEXT,"
                + "last_error_message TEXT"
                + ")"
        );
        db.execSQL(
            "CREATE TABLE location_samples ("
                + "sequence INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "session_id TEXT NOT NULL REFERENCES survey_sessions(session_id) ON DELETE CASCADE,"
                + "recorded_at INTEGER NOT NULL,"
                + "elapsed_realtime_nanos INTEGER NOT NULL,"
                + "boot_id INTEGER NOT NULL,"
                + "latitude REAL NOT NULL,"
                + "longitude REAL NOT NULL,"
                + "accuracy REAL,"
                + "altitude REAL,"
                + "altitude_accuracy REAL,"
                + "speed REAL,"
                + "heading REAL,"
                + "provider TEXT,"
                + "is_mock INTEGER NOT NULL,"
                + "activity TEXT NOT NULL,"
                + "quality TEXT NOT NULL,"
                + "accepted INTEGER NOT NULL,"
                + "reject_reason TEXT,"
                + "created_at INTEGER NOT NULL"
                + ")"
        );
        db.execSQL(
            "CREATE INDEX location_samples_session_sequence "
                + "ON location_samples(session_id, sequence)"
        );
        db.execSQL(
            "CREATE INDEX location_samples_session_accepted_sequence "
                + "ON location_samples(session_id, accepted, sequence)"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            // Existing pre-release rows lack a reliable monotonic-clock epoch.
            // -1 deliberately differs from every newly captured boot id, making
            // the quality evaluator fall back to their wall-clock timestamps.
            db.execSQL(
                "ALTER TABLE location_samples ADD COLUMN boot_id INTEGER NOT NULL DEFAULT -1"
            );
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE survey_sessions ADD COLUMN paused_at INTEGER");
            db.execSQL(
                "ALTER TABLE survey_sessions ADD COLUMN pause_ms INTEGER NOT NULL DEFAULT 0"
            );
            // Version 2 did not retain pause transitions. updated_at is the
            // closest durable approximation for an already-paused session;
            // all transitions after this migration are measured exactly.
            db.execSQL(
                "UPDATE survey_sessions SET paused_at=updated_at WHERE status=?",
                new Object[] { SurveyContract.STATUS_PAUSED }
            );
        }
        if (oldVersion < 4) {
            db.execSQL(
                "ALTER TABLE survey_sessions "
                    + "ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0"
            );
        }
    }

    public synchronized SessionState startSession(SessionConfig config) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState open = getOpenSession(db);
            if (open != null) {
                if (open.sessionId.equals(config.sessionId)) {
                    db.setTransactionSuccessful();
                    return open;
                }
                throw new IllegalStateException(
                    "Session " + open.sessionId + " is already active or paused"
                );
            }

            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("session_id", config.sessionId);
            values.put("status", SurveyContract.STATUS_ACTIVE);
            values.put("activity", config.activity);
            values.put("state_revision", 0L);
            values.put("started_at", now);
            values.put("updated_at", now);
            values.putNull("ended_at");
            values.putNull("paused_at");
            values.put("pause_ms", 0);
            values.put("interval_ms", config.intervalMs);
            values.put("min_distance_m", config.minDistanceMeters);
            values.put("good_accuracy_m", config.goodAccuracyMeters);
            values.put("acceptable_accuracy_m", config.acceptableAccuracyMeters);
            values.put("poor_accuracy_m", config.poorAccuracyMeters);
            values.put("max_on_foot_speed_mps", config.maxOnFootSpeedMetersPerSecond);
            values.put("max_transport_speed_mps", config.maxTransportSpeedMetersPerSecond);
            values.put("latest_sequence", 0);
            values.put("raw_sample_count", 0);
            values.put("accepted_sample_count", 0);
            values.putNull("last_error_code");
            values.putNull("last_error_message");
            db.insertOrThrow("survey_sessions", null, values);
            SessionState state = getSession(db, config.sessionId);
            db.setTransactionSuccessful();
            return state;
        } finally {
            db.endTransaction();
        }
    }

    public synchronized SessionState pauseSession(String sessionId) {
        return transitionStatus(
            sessionId,
            SurveyContract.STATUS_PAUSED,
            false,
            SurveyContract.STATUS_ACTIVE
        );
    }

    public synchronized SessionState resumeSession(String sessionId) {
        return transitionStatus(
            sessionId,
            SurveyContract.STATUS_ACTIVE,
            true,
            SurveyContract.STATUS_PAUSED
        );
    }

    public synchronized SessionState completeSession(String sessionId) {
        return transitionStatus(
            sessionId,
            SurveyContract.STATUS_COMPLETED,
            false,
            SurveyContract.STATUS_ACTIVE,
            SurveyContract.STATUS_PAUSED
        );
    }

    public synchronized SessionState setActivity(String sessionId, String activity) {
        String normalizedActivity = SurveyContract.normalizeActivity(activity);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState before = getSession(db, sessionId);
            if (before == null) throw new IllegalArgumentException("Unknown session: " + sessionId);
            if (
                !SurveyContract.STATUS_ACTIVE.equals(before.status)
                    && !SurveyContract.STATUS_PAUSED.equals(before.status)
            ) {
                throw new IllegalStateException(
                    "Session in state " + before.status + " cannot change activity"
                );
            }
            if (normalizedActivity.equals(before.activity)) {
                db.setTransactionSuccessful();
                return before;
            }

            ContentValues values = new ContentValues();
            values.put("activity", normalizedActivity);
            values.put(
                "state_revision",
                SurveySessionTiming.nextStateRevision(before.stateRevision)
            );
            values.put("updated_at", System.currentTimeMillis());
            int changed = db.update(
                "survey_sessions",
                values,
                "session_id=? AND status=? AND state_revision=?",
                new String[] {
                    sessionId,
                    before.status,
                    Long.toString(before.stateRevision)
                }
            );
            SessionState current = getSession(db, sessionId);
            if (changed != 1) {
                throw new IllegalStateException(
                    "Session changed while updating activity"
                );
            }
            db.setTransactionSuccessful();
            return current;
        } finally {
            db.endTransaction();
        }
    }

    public synchronized SessionState getSession(String sessionId) {
        return getSession(getReadableDatabase(), sessionId);
    }

    public synchronized SessionState getOpenSession() {
        return getOpenSession(getReadableDatabase());
    }

    /** Returns every durable session so a user-requested full reset can include orphans. */
    public synchronized List<SessionState> getSessions() {
        List<SessionState> sessions = new ArrayList<>();
        try (
            Cursor cursor = getReadableDatabase().rawQuery(
                SESSION_SELECT + "ORDER BY s.started_at ASC, s.session_id ASC",
                null
            )
        ) {
            while (cursor.moveToNext()) sessions.add(readSession(cursor));
        }
        return Collections.unmodifiableList(sessions);
    }

    /** Only ACTIVE is recoverable into a sticky foreground service. */
    public synchronized SessionState getRecoverableSession() {
        try (
            Cursor cursor = getReadableDatabase().rawQuery(
                SESSION_SELECT
                    + "WHERE s.status=? ORDER BY s.updated_at DESC LIMIT 1",
                new String[] { SurveyContract.STATUS_ACTIVE }
            )
        ) {
            return cursor.moveToFirst() ? readSession(cursor) : null;
        }
    }

    public synchronized SessionState setLastError(
        String sessionId,
        String errorCode,
        String errorMessage
    ) {
        ContentValues values = new ContentValues();
        putNullable(values, "last_error_code", errorCode);
        putNullable(values, "last_error_message", errorMessage);
        values.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update(
            "survey_sessions",
            values,
            "session_id=? AND status<>?",
            new String[] { sessionId, SurveyContract.STATUS_COMPLETED }
        );
        return getSession(sessionId);
    }

    public synchronized LocationQualityEvaluator.AcceptedPoint getLastAcceptedPoint(
        String sessionId
    ) {
        try (
            Cursor cursor = getReadableDatabase().query(
                "location_samples",
                new String[] {
                    "latitude",
                    "longitude",
                    "recorded_at",
                    "elapsed_realtime_nanos",
                    "boot_id",
                    "accuracy",
                    "activity"
                },
                "session_id=? AND accepted=1",
                new String[] { sessionId },
                null,
                null,
                "sequence DESC",
                "1"
            )
        ) {
            if (!cursor.moveToFirst()) return null;
            return new LocationQualityEvaluator.AcceptedPoint(
                cursor.getDouble(cursor.getColumnIndexOrThrow("latitude")),
                cursor.getDouble(cursor.getColumnIndexOrThrow("longitude")),
                cursor.getLong(cursor.getColumnIndexOrThrow("recorded_at")),
                cursor.getLong(cursor.getColumnIndexOrThrow("elapsed_realtime_nanos")),
                cursor.isNull(cursor.getColumnIndexOrThrow("accuracy"))
                    ? 0.0
                    : cursor.getDouble(cursor.getColumnIndexOrThrow("accuracy")),
                cursor.getLong(cursor.getColumnIndexOrThrow("boot_id")),
                cursor.getString(cursor.getColumnIndexOrThrow("activity"))
            );
        }
    }

    public synchronized Sample appendSample(
        String sessionId,
        RawSample sample,
        String activity,
        LocationQualityEvaluator.Result quality
    ) {
        ContentValues values = new ContentValues();
        values.put("session_id", sessionId);
        values.put("recorded_at", sample.recordedAtMs);
        values.put("elapsed_realtime_nanos", sample.elapsedRealtimeNanos);
        values.put("boot_id", sample.bootId);
        values.put("latitude", sample.latitude);
        values.put("longitude", sample.longitude);
        putNullable(values, "accuracy", sample.accuracyMeters);
        putNullable(values, "altitude", sample.altitudeMeters);
        putNullable(values, "altitude_accuracy", sample.altitudeAccuracyMeters);
        putNullable(values, "speed", sample.speedMetersPerSecond);
        putNullable(values, "heading", sample.headingDegrees);
        putNullable(values, "provider", sample.provider);
        values.put("is_mock", sample.mock ? 1 : 0);
        values.put("activity", SurveyContract.normalizeActivity(activity));
        values.put("quality", quality.quality);
        values.put("accepted", quality.accepted ? 1 : 0);
        putNullable(values, "reject_reason", quality.rejectionReason);
        values.put("created_at", System.currentTimeMillis());

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState current = getSession(db, sessionId);
            if (current == null || !SurveyContract.STATUS_ACTIVE.equals(current.status)) {
                db.setTransactionSuccessful();
                return null;
            }
            String normalizedActivity = SurveyContract.normalizeActivity(activity);
            if (!normalizedActivity.equals(current.activity)) {
                throw new ActivityChangedException(current);
            }
            long sequence = db.insertOrThrow("location_samples", null, values);
            db.execSQL(
                "UPDATE survey_sessions SET "
                    + "latest_sequence=?, "
                    + "raw_sample_count=raw_sample_count+1, "
                    + "accepted_sample_count=accepted_sample_count+?, "
                    + "updated_at=? WHERE session_id=?",
                new Object[] {
                    sequence,
                    quality.accepted ? 1 : 0,
                    System.currentTimeMillis(),
                    sessionId
                }
            );
            Sample stored = getSample(db, sequence);
            db.setTransactionSuccessful();
            return stored;
        } finally {
            db.endTransaction();
        }
    }

    /** Atomically records a terminal tracking error and pauses only the observed ACTIVE revision. */
    public synchronized ConditionalPauseResult failAndPauseSession(
        String sessionId,
        long expectedStateRevision,
        String errorCode,
        String errorMessage
    ) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState before = getSession(db, sessionId);
            if (before == null) {
                throw new IllegalArgumentException("Unknown session: " + sessionId);
            }
            if (
                !SurveySessionTiming.isCurrentActiveRevision(
                    before.status,
                    before.stateRevision,
                    expectedStateRevision
                )
            ) {
                db.setTransactionSuccessful();
                return new ConditionalPauseResult(before, false);
            }

            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("status", SurveyContract.STATUS_PAUSED);
            values.put("updated_at", now);
            values.put("paused_at", now);
            values.put("pause_ms", before.pauseMs);
            values.putNull("ended_at");
            values.put(
                "state_revision",
                SurveySessionTiming.nextStateRevision(before.stateRevision)
            );
            putNullable(values, "last_error_code", errorCode);
            putNullable(values, "last_error_message", errorMessage);
            int changed = db.update(
                "survey_sessions",
                values,
                "session_id=? AND status=? AND state_revision=?",
                new String[] {
                    sessionId,
                    SurveyContract.STATUS_ACTIVE,
                    Long.toString(expectedStateRevision)
                }
            );
            SessionState current = getSession(db, sessionId);
            if (
                changed != 1
                    || current == null
                    || !SurveyContract.STATUS_PAUSED.equals(current.status)
            ) {
                throw new IllegalStateException(
                    "Session changed while recording terminal tracking error"
                );
            }
            db.setTransactionSuccessful();
            return new ConditionalPauseResult(current, true);
        } finally {
            db.endTransaction();
        }
    }

    /** Signals a linearizable mode change between quality evaluation and insert. */
    static final class ActivityChangedException extends RuntimeException {
        final SessionState currentState;

        ActivityChangedException(SessionState currentState) {
            super("Survey activity changed before sample insert");
            this.currentState = currentState;
        }
    }

    public synchronized Sample getSample(long sequence) {
        return getSample(getReadableDatabase(), sequence);
    }

    private static Sample getSample(SQLiteDatabase db, long sequence) {
        try (
            Cursor cursor = db.query(
                "location_samples",
                null,
                "sequence=?",
                new String[] { Long.toString(sequence) },
                null,
                null,
                null,
                "1"
            )
        ) {
            return cursor.moveToFirst() ? readSample(cursor) : null;
        }
    }

    public synchronized SamplePage getSamples(
        String sessionId,
        long afterSequence,
        int requestedLimit,
        boolean acceptedOnly
    ) {
        int limit = Math.max(1, Math.min(5_000, requestedLimit));
        String selection = "session_id=? AND sequence>?";
        List<String> args = new ArrayList<>();
        args.add(sessionId);
        args.add(Long.toString(Math.max(0L, afterSequence)));
        if (acceptedOnly) selection += " AND accepted=1";

        ArrayList<Sample> samples = new ArrayList<>();
        boolean hasMore = false;
        try (
            Cursor cursor = getReadableDatabase().query(
                "location_samples",
                null,
                selection,
                args.toArray(new String[0]),
                null,
                null,
                "sequence ASC",
                Integer.toString(limit + 1)
            )
        ) {
            while (cursor.moveToNext()) {
                if (samples.size() == limit) {
                    hasMore = true;
                    break;
                }
                samples.add(readSample(cursor));
            }
        }
        long nextSequence = samples.isEmpty()
            ? Math.max(0L, afterSequence)
            : samples.get(samples.size() - 1).sequence;
        return new SamplePage(samples, nextSequence, hasMore);
    }

    /** Samples may only be deleted after a session has been completed. */
    public synchronized int deleteSamples(String sessionId) {
        SessionState state = requireSession(sessionId);
        if (!SurveyContract.STATUS_COMPLETED.equals(state.status)) {
            throw new IllegalStateException("Samples for an open session cannot be deleted");
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            int deleted = db.delete(
                "location_samples",
                "session_id=?",
                new String[] { sessionId }
            );
            ContentValues reset = new ContentValues();
            reset.put("latest_sequence", 0);
            reset.put("raw_sample_count", 0);
            reset.put("accepted_sample_count", 0);
            reset.put("updated_at", System.currentTimeMillis());
            db.update(
                "survey_sessions",
                reset,
                "session_id=?",
                new String[] { sessionId }
            );
            db.setTransactionSuccessful();
            return deleted;
        } finally {
            db.endTransaction();
        }
    }

    /** Deletes one terminal session and lets the foreign key cascade remove its raw samples. */
    public synchronized int deleteSession(String sessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState state = getSession(db, sessionId);
            if (state == null) throw new IllegalArgumentException("Unknown session: " + sessionId);
            if (!SurveyContract.STATUS_COMPLETED.equals(state.status)) {
                throw new IllegalStateException("An open session cannot be deleted");
            }
            int deleted = db.delete(
                "survey_sessions",
                "session_id=? AND status=?",
                new String[] { sessionId, SurveyContract.STATUS_COMPLETED }
            );
            if (deleted != 1) {
                throw new IllegalStateException("Session changed while deleting it");
            }
            db.setTransactionSuccessful();
            return deleted;
        } finally {
            db.endTransaction();
        }
    }

    private SessionState transitionStatus(
        String sessionId,
        String status,
        boolean clearError,
        String... allowedStatuses
    ) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            SessionState before = getSession(db, sessionId);
            if (before == null) throw new IllegalArgumentException("Unknown session: " + sessionId);
            if (status.equals(before.status)) {
                db.setTransactionSuccessful();
                return before;
            }
            if (!containsStatus(allowedStatuses, before.status)) {
                throw new IllegalStateException(
                    "Session cannot transition from " + before.status + " to " + status
                );
            }

            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("status", status);
            values.put("updated_at", now);
            values.put(
                "state_revision",
                SurveySessionTiming.nextStateRevision(before.stateRevision)
            );
            if (SurveyContract.STATUS_PAUSED.equals(status)) {
                values.put("paused_at", now);
                values.put("pause_ms", before.pauseMs);
                values.putNull("ended_at");
            } else {
                long pauseMs = SurveySessionTiming.accumulatePauseMs(
                    before.pauseMs,
                    before.pausedAtMs,
                    now
                );
                values.putNull("paused_at");
                values.put("pause_ms", pauseMs);
                if (SurveyContract.STATUS_COMPLETED.equals(status)) values.put("ended_at", now);
                else values.putNull("ended_at");
            }
            if (clearError) {
                values.putNull("last_error_code");
                values.putNull("last_error_message");
            }
            int changed = db.update(
                "survey_sessions",
                values,
                "session_id=? AND status=? AND state_revision=?",
                new String[] {
                    sessionId,
                    before.status,
                    Long.toString(before.stateRevision)
                }
            );
            SessionState current = getSession(db, sessionId);
            if (changed != 1 || current == null || !status.equals(current.status)) {
                throw new IllegalStateException(
                    "Session status changed while transitioning to " + status
                );
            }
            db.setTransactionSuccessful();
            return current;
        } finally {
            db.endTransaction();
        }
    }

    private static boolean containsStatus(String[] statuses, String candidate) {
        for (String status : statuses) {
            if (status.equals(candidate)) return true;
        }
        return false;
    }

    private SessionState requireSession(String sessionId) {
        SessionState state = getSession(sessionId);
        if (state == null) throw new IllegalArgumentException("Unknown session: " + sessionId);
        return state;
    }

    private static SessionState getSession(SQLiteDatabase db, String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) return null;
        try (
            Cursor cursor = db.rawQuery(
                SESSION_SELECT + "WHERE s.session_id=? LIMIT 1",
                new String[] { sessionId }
            )
        ) {
            return cursor.moveToFirst() ? readSession(cursor) : null;
        }
    }

    private static SessionState getOpenSession(SQLiteDatabase db) {
        try (
            Cursor cursor = db.rawQuery(
                SESSION_SELECT
                    + "WHERE s.status IN (?,?) ORDER BY s.updated_at DESC LIMIT 1",
                new String[] {
                    SurveyContract.STATUS_ACTIVE,
                    SurveyContract.STATUS_PAUSED
                }
            )
        ) {
            return cursor.moveToFirst() ? readSession(cursor) : null;
        }
    }

    private static boolean isSessionActive(SQLiteDatabase db, String sessionId) {
        try (
            Cursor cursor = db.query(
                "survey_sessions",
                new String[] { "status" },
                "session_id=?",
                new String[] { sessionId },
                null,
                null,
                null,
                "1"
            )
        ) {
            return cursor.moveToFirst()
                && SurveyContract.STATUS_ACTIVE.equals(cursor.getString(0));
        }
    }

    private static SessionState readSession(Cursor cursor) {
        return new SessionState(
            cursor.getString(cursor.getColumnIndexOrThrow("session_id")),
            cursor.getString(cursor.getColumnIndexOrThrow("status")),
            cursor.getString(cursor.getColumnIndexOrThrow("activity")),
            cursor.getLong(cursor.getColumnIndexOrThrow("state_revision")),
            cursor.getLong(cursor.getColumnIndexOrThrow("started_at")),
            cursor.getLong(cursor.getColumnIndexOrThrow("updated_at")),
            nullableLong(cursor, "ended_at"),
            nullableLong(cursor, "paused_at"),
            cursor.getLong(cursor.getColumnIndexOrThrow("pause_ms")),
            cursor.getLong(cursor.getColumnIndexOrThrow("interval_ms")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("min_distance_m")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("good_accuracy_m")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("acceptable_accuracy_m")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("poor_accuracy_m")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("max_on_foot_speed_mps")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("max_transport_speed_mps")),
            nullableString(cursor, "last_error_code"),
            nullableString(cursor, "last_error_message"),
            cursor.getLong(cursor.getColumnIndexOrThrow("latest_sequence")),
            cursor.getLong(cursor.getColumnIndexOrThrow("raw_sample_count")),
            cursor.getLong(cursor.getColumnIndexOrThrow("accepted_sample_count"))
        );
    }

    private static Sample readSample(Cursor cursor) {
        return new Sample(
            cursor.getLong(cursor.getColumnIndexOrThrow("sequence")),
            cursor.getString(cursor.getColumnIndexOrThrow("session_id")),
            cursor.getLong(cursor.getColumnIndexOrThrow("recorded_at")),
            cursor.getLong(cursor.getColumnIndexOrThrow("elapsed_realtime_nanos")),
            cursor.getLong(cursor.getColumnIndexOrThrow("boot_id")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("latitude")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("longitude")),
            nullableDouble(cursor, "accuracy"),
            nullableDouble(cursor, "altitude"),
            nullableDouble(cursor, "altitude_accuracy"),
            nullableDouble(cursor, "speed"),
            nullableDouble(cursor, "heading"),
            nullableString(cursor, "provider"),
            cursor.getInt(cursor.getColumnIndexOrThrow("is_mock")) == 1,
            cursor.getString(cursor.getColumnIndexOrThrow("activity")),
            cursor.getString(cursor.getColumnIndexOrThrow("quality")),
            cursor.getInt(cursor.getColumnIndexOrThrow("accepted")) == 1,
            nullableString(cursor, "reject_reason")
        );
    }

    private static Long nullableLong(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getLong(index);
    }

    private static Double nullableDouble(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getDouble(index);
    }

    private static String nullableString(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getString(index);
    }

    private static void putNullable(ContentValues values, String key, Double value) {
        if (value == null) values.putNull(key);
        else values.put(key, value);
    }

    private static void putNullable(ContentValues values, String key, String value) {
        if (value == null) values.putNull(key);
        else values.put(key, value);
    }

    public static final class SessionConfig {
        public final String sessionId;
        public final String activity;
        public final long intervalMs;
        public final double minDistanceMeters;
        public final double goodAccuracyMeters;
        public final double acceptableAccuracyMeters;
        public final double poorAccuracyMeters;
        public final double maxOnFootSpeedMetersPerSecond;
        public final double maxTransportSpeedMetersPerSecond;

        public SessionConfig(
            String sessionId,
            String activity,
            long intervalMs,
            double minDistanceMeters,
            double goodAccuracyMeters,
            double acceptableAccuracyMeters,
            double poorAccuracyMeters,
            double maxOnFootSpeedMetersPerSecond,
            double maxTransportSpeedMetersPerSecond
        ) {
            if (sessionId == null || sessionId.trim().isEmpty() || sessionId.length() > 160) {
                throw new IllegalArgumentException("A non-empty sessionId is required");
            }
            this.sessionId = sessionId;
            this.activity = SurveyContract.normalizeActivity(activity);
            this.intervalMs = Math.max(1_000L, Math.min(60_000L, intervalMs));
            if (!LocationQualityEvaluator.isFinite(minDistanceMeters)) {
                throw new IllegalArgumentException("minDistanceMeters must be finite");
            }
            this.minDistanceMeters = Math.max(0.0, Math.min(1_000.0, minDistanceMeters));

            LocationQualityEvaluator.Thresholds checked =
                new LocationQualityEvaluator.Thresholds(
                    goodAccuracyMeters,
                    acceptableAccuracyMeters,
                    poorAccuracyMeters,
                    maxOnFootSpeedMetersPerSecond,
                    maxTransportSpeedMetersPerSecond
                );
            this.goodAccuracyMeters = checked.goodAccuracyMeters;
            this.acceptableAccuracyMeters = checked.acceptableAccuracyMeters;
            this.poorAccuracyMeters = checked.poorAccuracyMeters;
            this.maxOnFootSpeedMetersPerSecond =
                checked.maxOnFootSpeedMetersPerSecond;
            this.maxTransportSpeedMetersPerSecond =
                checked.maxTransportSpeedMetersPerSecond;
        }
    }

    public static final class SessionState {
        public final String sessionId;
        public final String status;
        public final String activity;
        public final long stateRevision;
        public final long startedAtMs;
        public final long updatedAtMs;
        public final Long endedAtMs;
        public final Long pausedAtMs;
        public final long pauseMs;
        public final long intervalMs;
        public final double minDistanceMeters;
        public final double goodAccuracyMeters;
        public final double acceptableAccuracyMeters;
        public final double poorAccuracyMeters;
        public final double maxOnFootSpeedMetersPerSecond;
        public final double maxTransportSpeedMetersPerSecond;
        public final String lastErrorCode;
        public final String lastErrorMessage;
        public final long latestSequence;
        public final long rawSampleCount;
        public final long acceptedSampleCount;

        SessionState(
            String sessionId,
            String status,
            String activity,
            long stateRevision,
            long startedAtMs,
            long updatedAtMs,
            Long endedAtMs,
            Long pausedAtMs,
            long pauseMs,
            long intervalMs,
            double minDistanceMeters,
            double goodAccuracyMeters,
            double acceptableAccuracyMeters,
            double poorAccuracyMeters,
            double maxOnFootSpeedMetersPerSecond,
            double maxTransportSpeedMetersPerSecond,
            String lastErrorCode,
            String lastErrorMessage,
            long latestSequence,
            long rawSampleCount,
            long acceptedSampleCount
        ) {
            this.sessionId = sessionId;
            this.status = status;
            this.activity = activity;
            this.stateRevision = stateRevision;
            this.startedAtMs = startedAtMs;
            this.updatedAtMs = updatedAtMs;
            this.endedAtMs = endedAtMs;
            this.pausedAtMs = pausedAtMs;
            this.pauseMs = pauseMs;
            this.intervalMs = intervalMs;
            this.minDistanceMeters = minDistanceMeters;
            this.goodAccuracyMeters = goodAccuracyMeters;
            this.acceptableAccuracyMeters = acceptableAccuracyMeters;
            this.poorAccuracyMeters = poorAccuracyMeters;
            this.maxOnFootSpeedMetersPerSecond = maxOnFootSpeedMetersPerSecond;
            this.maxTransportSpeedMetersPerSecond = maxTransportSpeedMetersPerSecond;
            this.lastErrorCode = lastErrorCode;
            this.lastErrorMessage = lastErrorMessage;
            this.latestSequence = latestSequence;
            this.rawSampleCount = rawSampleCount;
            this.acceptedSampleCount = acceptedSampleCount;
        }

        public LocationQualityEvaluator.Thresholds thresholds() {
            return new LocationQualityEvaluator.Thresholds(
                goodAccuracyMeters,
                acceptableAccuracyMeters,
                poorAccuracyMeters,
                maxOnFootSpeedMetersPerSecond,
                maxTransportSpeedMetersPerSecond
            );
        }
    }

    public static final class ConditionalPauseResult {
        public final SessionState state;
        public final boolean transitioned;

        ConditionalPauseResult(SessionState state, boolean transitioned) {
            this.state = state;
            this.transitioned = transitioned;
        }
    }

    public static final class RawSample {
        public final long recordedAtMs;
        public final long elapsedRealtimeNanos;
        public final long bootId;
        public final double latitude;
        public final double longitude;
        public final Double accuracyMeters;
        public final Double altitudeMeters;
        public final Double altitudeAccuracyMeters;
        public final Double speedMetersPerSecond;
        public final Double headingDegrees;
        public final String provider;
        public final boolean mock;

        public RawSample(
            long recordedAtMs,
            long elapsedRealtimeNanos,
            long bootId,
            double latitude,
            double longitude,
            Double accuracyMeters,
            Double altitudeMeters,
            Double altitudeAccuracyMeters,
            Double speedMetersPerSecond,
            Double headingDegrees,
            String provider,
            boolean mock
        ) {
            this.recordedAtMs = recordedAtMs;
            this.elapsedRealtimeNanos = elapsedRealtimeNanos;
            this.bootId = bootId;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracyMeters = accuracyMeters;
            this.altitudeMeters = altitudeMeters;
            this.altitudeAccuracyMeters = altitudeAccuracyMeters;
            this.speedMetersPerSecond = speedMetersPerSecond;
            this.headingDegrees = headingDegrees;
            this.provider = provider;
            this.mock = mock;
        }
    }

    public static final class Sample {
        public final long sequence;
        public final String sessionId;
        public final long recordedAtMs;
        public final long elapsedRealtimeNanos;
        public final long bootId;
        public final double latitude;
        public final double longitude;
        public final Double accuracyMeters;
        public final Double altitudeMeters;
        public final Double altitudeAccuracyMeters;
        public final Double speedMetersPerSecond;
        public final Double headingDegrees;
        public final String provider;
        public final boolean mock;
        public final String activity;
        public final String quality;
        public final boolean accepted;
        public final String rejectionReason;

        Sample(
            long sequence,
            String sessionId,
            long recordedAtMs,
            long elapsedRealtimeNanos,
            long bootId,
            double latitude,
            double longitude,
            Double accuracyMeters,
            Double altitudeMeters,
            Double altitudeAccuracyMeters,
            Double speedMetersPerSecond,
            Double headingDegrees,
            String provider,
            boolean mock,
            String activity,
            String quality,
            boolean accepted,
            String rejectionReason
        ) {
            this.sequence = sequence;
            this.sessionId = sessionId;
            this.recordedAtMs = recordedAtMs;
            this.elapsedRealtimeNanos = elapsedRealtimeNanos;
            this.bootId = bootId;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracyMeters = accuracyMeters;
            this.altitudeMeters = altitudeMeters;
            this.altitudeAccuracyMeters = altitudeAccuracyMeters;
            this.speedMetersPerSecond = speedMetersPerSecond;
            this.headingDegrees = headingDegrees;
            this.provider = provider;
            this.mock = mock;
            this.activity = activity;
            this.quality = quality;
            this.accepted = accepted;
            this.rejectionReason = rejectionReason;
        }
    }

    public static final class SamplePage {
        public final List<Sample> samples;
        public final long nextSequence;
        public final boolean hasMore;

        SamplePage(List<Sample> samples, long nextSequence, boolean hasMore) {
            this.samples = Collections.unmodifiableList(new ArrayList<>(samples));
            this.nextSequence = nextSequence;
            this.hasMore = hasMore;
        }
    }
}
