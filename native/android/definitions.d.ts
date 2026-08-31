export type SurveyActivity = "SEARCHING" | "PICKING" | "TRANSPORT";
export type SurveyStatus = "ACTIVE" | "PAUSED" | "COMPLETED";
export type LocationQuality = "GOOD" | "ACCEPTABLE" | "POOR" | "REJECTED";

export interface SurveyLocationState {
  sessionId: string;
  status: SurveyStatus;
  activity: SurveyActivity;
  stateRevision: number;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  pausedAt: number | null;
  pauseMs: number;
  intervalMs: number;
  minDistanceMeters: number;
  goodAccuracyMeters: number;
  acceptableAccuracyMeters: number;
  poorAccuracyMeters: number;
  maxOnFootSpeedMetersPerSecond: number;
  maxTransportSpeedMetersPerSecond: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  latestSequence: number;
  rawSampleCount: number;
  acceptedSampleCount: number;
}

export interface SurveyLocationSample {
  sequence: number;
  sessionId: string;
  recordedAt: number;
  elapsedRealtimeNanos: string;
  bootId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  speed: number | null;
  heading: number | null;
  provider: string | null;
  mock: boolean;
  activity: SurveyActivity;
  quality: LocationQuality;
  accepted: boolean;
  rejectionReason: string | null;
}

export interface StartOptions {
  sessionId: string;
  activity?: SurveyActivity;
  intervalMs?: number;
  minDistanceMeters?: number;
  goodAccuracyMeters?: number;
  acceptableAccuracyMeters?: number;
  poorAccuracyMeters?: number;
  maxOnFootSpeedMetersPerSecond?: number;
  maxTransportSpeedMetersPerSecond?: number;
}

export interface SurveyLocationPlugin {
  requestPermissions(): Promise<Record<string, string>>;
  checkPermissions(): Promise<Record<string, string>>;
  start(options: StartOptions): Promise<SurveyLocationState>;
  pause(options: { sessionId: string }): Promise<SurveyLocationState>;
  resume(options: { sessionId: string }): Promise<SurveyLocationState>;
  stop(options: { sessionId: string }): Promise<SurveyLocationState>;
  setActivity(options: {
    sessionId: string;
    activity: SurveyActivity;
  }): Promise<SurveyLocationState>;
  getState(options?: { sessionId?: string }): Promise<{
    state: SurveyLocationState | null;
    preciseLocationPermission: boolean;
    notificationPermission: boolean;
    shouldBeTracking: boolean;
  }>;
  getSessions(): Promise<{ sessions: SurveyLocationState[] }>;
  getSamples(options: {
    sessionId: string;
    afterSequence?: number;
    limit?: number;
    acceptedOnly?: boolean;
  }): Promise<{
    samples: SurveyLocationSample[];
    nextSequence: number;
    hasMore: boolean;
  }>;
  deleteSamples(options: {
    sessionId: string;
    confirm: true;
  }): Promise<{ sessionId: string; deleted: number }>;
  deleteSession(options: {
    sessionId: string;
    confirm: true;
  }): Promise<{ sessionId: string; deleted: number }>;
  addListener(
    eventName: "locationSample",
    listener: (sample: SurveyLocationSample) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "stateChanged",
    listener: (state: SurveyLocationState) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "trackingError",
    listener: (error: { sessionId: string; code: string; message: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}
