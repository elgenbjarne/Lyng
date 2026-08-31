"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NativeSurveyStore } = require("../src/survey-storage.js");

function fakeNativePlugin(overrides) {
  const calls = [];
  const plugin = {};
  for (const method of [
    "requestPermissions", "start", "pause", "resume", "stop",
    "setActivity", "getState", "getSessions", "getSamples", "deleteSamples", "deleteSession"
  ]) {
    plugin[method] = async payload => {
      calls.push({ method, payload });
      if (overrides && overrides[method]) return overrides[method](payload);
      return {};
    };
  }
  return {
    calls,
    store: new NativeSurveyStore({ Plugins: { SurveyLocation: plugin } })
  };
}

test("native start videresender alle kvalitets- og transportgrenser", async () => {
  const { calls, store } = fakeNativePlugin();
  await store.start({
    surveyId: "survey-1",
    activityMode: "TRANSPORT",
    intervalMs: 4_000,
    minimumDistanceMeters: 4,
    goodAccuracyMeters: 6,
    acceptableAccuracyMeters: 12,
    poorAccuracyMeters: 25,
    maxOnFootSpeedMetersPerSecond: 5,
    maxTransportSpeedMetersPerSecond: 55
  });

  assert.equal(calls[0].method, "requestPermissions");
  assert.deepEqual(calls[1], {
    method: "start",
    payload: {
      sessionId: "survey-1",
      activity: "TRANSPORT",
      intervalMs: 4_000,
      minDistanceMeters: 4,
      goodAccuracyMeters: 6,
      acceptableAccuracyMeters: 12,
      poorAccuracyMeters: 25,
      maxOnFootSpeedMetersPerSecond: 5,
      maxTransportSpeedMetersPerSecond: 55
    }
  });
});

test("native state kan leses øktsspesifikt og samples beholder boot-id", async () => {
  const { calls, store } = fakeNativePlugin({
    getState: payload => ({ state: { sessionId: payload.sessionId, status: "COMPLETED" } }),
    getSamples: () => ({ samples: [{
      sequence: 9,
      sessionId: "survey-2",
      recordedAt: 123,
      elapsedRealtimeNanos: "9007199254740993000",
      bootId: "42",
      latitude: 60,
      longitude: 10,
      accuracy: 4,
      activity: "SEARCHING",
      quality: "GOOD",
      accepted: true,
      provider: "gps"
    }] })
  });

  const response = await store.getState({ surveyId: "survey-2" });
  const samples = await store.list("survey-2", 3, 750);

  assert.equal(response.state.status, "COMPLETED");
  assert.deepEqual(calls[0], { method: "getState", payload: { sessionId: "survey-2" } });
  assert.deepEqual(calls[1], {
    method: "getSamples",
    payload: { sessionId: "survey-2", afterSequence: 3, limit: 750 }
  });
  assert.equal(samples[0].id, 9);
  assert.equal(samples[0].elapsedRealtimeNanos, "9007199254740993000");
  assert.equal(samples[0].bootId, "42");
  assert.equal(samples[0].source, "gps");
});

test("native øktliste gjør full sletting komplett også for foreldreløse økter", async () => {
  const { calls, store } = fakeNativePlugin({
    getSessions: () => ({ sessions: [
      { sessionId: "survey-known", status: "COMPLETED" },
      { sessionId: "survey-orphan", status: "COMPLETED" }
    ] })
  });
  const sessions = await store.listSessions();
  assert.deepEqual(sessions.map(state => state.sessionId), ["survey-known", "survey-orphan"]);
  assert.deepEqual(calls[0], { method: "getSessions", payload: {} });
});

test("native rå- og øktsletting bruker separate bekreftede bridge-kall", async () => {
  const { calls, store } = fakeNativePlugin();
  await store.deleteSamples("survey-3");
  await store.deleteSurvey("survey-3");
  assert.deepEqual(calls[0], {
    method: "deleteSamples",
    payload: { sessionId: "survey-3", confirm: true }
  });
  assert.deepEqual(calls[1], {
    method: "deleteSession",
    payload: { sessionId: "survey-3", confirm: true }
  });
});
