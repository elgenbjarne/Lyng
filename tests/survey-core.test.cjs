"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const turf = require("@turf/turf");

const {
  ACTIVITY,
  QUALITY,
  LocationQualityFilter,
  SurveyCoverageEngine,
  classifyAccuracy,
  normalizeRawSample,
  coverageStats,
  findCoverageHoles,
  deriveCoverageGeometry,
  mergeCoverageBatch,
  mergeCoverageChunksBalanced,
  createSurvey
} = require("../src/survey-core.js");

function approximately(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message || "verdiene skal være omtrent like"}: forventet ${expected} ± ${tolerance}, fikk ${actual}`
  );
}

function rectangle(minLng, minLat, maxLng, maxLat, properties) {
  return turf.polygon([[
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat]
  ]], properties || {});
}

function destinationLatLng(origin, distanceMeters, bearing = 90) {
  const point = turf.destination(
    turf.point([origin.lng, origin.lat]),
    distanceMeters / 1000,
    bearing,
    { units: "kilometers" }
  );
  return {
    lat: point.geometry.coordinates[1],
    lng: point.geometry.coordinates[0]
  };
}

function acceptedPoint(overrides) {
  return Object.assign({
    id: null,
    lat: 60,
    lng: 10,
    timestamp: 1_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING,
    quality: QUALITY.GOOD,
    accepted: true,
    contributes: true,
    breakBefore: false
  }, overrides || {});
}

test("accuracy-grensene klassifiseres konservativt og inklusivt", () => {
  assert.equal(classifyAccuracy(0), QUALITY.GOOD);
  assert.equal(classifyAccuracy(6), QUALITY.GOOD);
  assert.equal(classifyAccuracy(6.001), QUALITY.ACCEPTABLE);
  assert.equal(classifyAccuracy(12), QUALITY.ACCEPTABLE);
  assert.equal(classifyAccuracy(12.001), QUALITY.POOR);
  assert.equal(classifyAccuracy(25), QUALITY.POOR);
  assert.equal(classifyAccuracy(25.001), QUALITY.REJECTED);
  assert.equal(classifyAccuracy(undefined), QUALITY.REJECTED);
  assert.equal(classifyAccuracy(Number.NaN), QUALITY.REJECTED);
});

test("manglende og tomme råverdier kan ikke bli gyldige nullkoordinater", () => {
  for (const value of [null, undefined, "", "   "]) {
    const sample = normalizeRawSample({ lat: value, lng: 10, accuracy: 4 });
    assert.equal(Number.isNaN(sample.lat), true);
  }
  for (const value of [null, undefined, "", "   "]) {
    const sample = normalizeRawSample({ lat: 60, lng: 10, accuracy: value });
    assert.equal(sample.accuracy, Infinity);
    assert.equal(new LocationQualityFilter().process(sample).accepted, false);
  }

  const nullCoordinates = new LocationQualityFilter().process({
    latitude: null,
    longitude: null,
    accuracy: 4
  });
  assert.equal(nullCoordinates.accepted, false);
  assert.equal(nullCoordinates.rejectionReason, "INVALID_COORDINATES");
});

test("et GPS-hopp på 300 meter på fem sekunder forkastes uten å miste rådata", () => {
  const filter = new LocationQualityFilter();
  const previous = filter.process({
    id: "raw-1",
    surveyId: "survey-1",
    lat: 60,
    lng: 10,
    timestamp: 10_000,
    accuracy: 5,
    activityMode: ACTIVITY.SEARCHING
  });
  const jumped = destinationLatLng(previous, 300);
  const result = filter.process({
    id: "raw-2",
    surveyId: "survey-1",
    ...jumped,
    timestamp: 15_000,
    accuracy: 5,
    altitude: 412,
    speed: 60,
    heading: 90,
    activityMode: ACTIVITY.SEARCHING
  }, previous);

  assert.equal(previous.accepted, true);
  assert.equal(result.accepted, false);
  assert.equal(result.contributes, false);
  assert.equal(result.quality, QUALITY.REJECTED);
  assert.equal(result.rejectionReason, "IMPLAUSIBLE_JUMP");
  assert.ok(result.distanceMeters > 299 && result.distanceMeters < 301);
  assert.equal(result.id, "raw-2");
  assert.equal(result.surveyId, "survey-1");
  assert.equal(result.altitude, 412);
  assert.equal(result.heading, 90);
});

test("kortvarig stillestående jitter aksepteres, men bidrar ikke", () => {
  const filter = new LocationQualityFilter();
  const previous = filter.process({
    lat: 60,
    lng: 10,
    timestamp: 1_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING
  });
  const jittered = destinationLatLng(previous, 1);
  const jitter = filter.process({
    ...jittered,
    timestamp: 6_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING
  }, previous);

  assert.equal(jitter.accepted, true);
  assert.equal(jitter.quality, QUALITY.GOOD);
  assert.equal(jitter.contributes, false);
  assert.ok(jitter.distanceMeters > 0.9 && jitter.distanceMeters < 1.1);

  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 1 }
  });
  const change = engine.addPoint(jitter, previous);
  assert.equal(change.changed, false);
  assert.equal(engine.getCoverage(true), null);

  const keepAlive = filter.process({
    ...jittered,
    timestamp: 31_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING
  }, previous);
  assert.equal(keepAlive.accepted, true);
  assert.equal(keepAlive.contributes, true, "samme punkt kan beholdes etter keep-alive-perioden");
});

test("langt GPS-opphold eller ny Android-boot bryter dekningssegmentet", () => {
  const filter = new LocationQualityFilter();
  const previous = filter.process({
    lat: 60, lng: 10, timestamp: 1_000, accuracy: 4,
    activityMode: ACTIVITY.SEARCHING, bootId: "41"
  });
  const nearby = destinationLatLng(previous, 4);
  const afterGap = filter.process({
    ...nearby, timestamp: 45_000, accuracy: 4,
    activityMode: ACTIVITY.SEARCHING, bootId: "41"
  }, previous);
  const afterReboot = filter.process({
    ...nearby, timestamp: 500, accuracy: 4,
    activityMode: ACTIVITY.SEARCHING, bootId: "42"
  }, previous);

  assert.equal(afterGap.accepted, true);
  assert.equal(afterGap.breakBefore, true);
  assert.equal(afterReboot.accepted, true);
  assert.equal(afterReboot.breakBefore, true);
  assert.equal(afterReboot.bootId, "42");
});

test("monoton Android-tid brukes når veggklokken går bakover i samme boot", () => {
  const filter = new LocationQualityFilter();
  const previous = filter.process({
    lat: 60,
    lng: 10,
    timestamp: 20_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING,
    bootId: "same-boot",
    elapsedRealtimeNanos: "9007199254740993000"
  });
  const nearby = destinationLatLng(previous, 10);
  const result = filter.process({
    ...nearby,
    timestamp: 5_000,
    accuracy: 4,
    activityMode: ACTIVITY.SEARCHING,
    bootId: "same-boot",
    elapsedRealtimeNanos: "9007199259740993000"
  }, previous);

  assert.equal(previous.elapsedRealtimeNanos, "9007199254740993000");
  assert.equal(result.elapsedRealtimeNanos, "9007199259740993000");
  assert.equal(result.accepted, true);
  assert.equal(result.rejectionReason, null);
  assert.equal(result.breakBefore, false);
  approximately(result.calculatedSpeedMetersPerSecond, 2, 0.01);
});

test("TRANSPORT bruker transportgrensen uten å bryte spor eller distanse", () => {
  const filter = new LocationQualityFilter();
  const onFoot = filter.process({
    lat: 60, lng: 10, timestamp: 1_000, accuracy: 4,
    activityMode: ACTIVITY.SEARCHING
  });
  const drivenPosition = destinationLatLng(onFoot, 200);
  const driven = filter.process({
    ...drivenPosition, timestamp: 6_000, accuracy: 4,
    activityMode: ACTIVITY.TRANSPORT
  }, onFoot);
  const searchPosition = destinationLatLng(driven, 30);
  const searchAgain = filter.process({
    ...searchPosition, timestamp: 7_000, accuracy: 4,
    activityMode: ACTIVITY.SEARCHING
  }, driven);

  assert.equal(driven.accepted, true);
  assert.equal(driven.breakBefore, false);
  approximately(driven.distanceMeters, 200, 0.1);
  assert.equal(searchAgain.accepted, true);
  assert.equal(searchAgain.breakBefore, false);
  approximately(searchAgain.distanceMeters, 30, 0.1);
});

test("SEARCHING og PICKING lager dekning, mens TRANSPORT aldri gjør det", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 1 }
  });
  const searching = acceptedPoint({ id: "s", timestamp: 1_000 });
  const pickingPosition = destinationLatLng(searching, 10);
  const picking = acceptedPoint({
    id: "p",
    ...pickingPosition,
    timestamp: 5_000,
    activityMode: ACTIVITY.PICKING
  });
  const transportPosition = destinationLatLng(picking, 20);
  const transport = acceptedPoint({
    id: "t",
    ...transportPosition,
    timestamp: 9_000,
    activityMode: ACTIVITY.TRANSPORT
  });

  assert.equal(engine.addPoint(searching, null).changed, true);
  const afterSearching = turf.area(engine.getCoverage(true));
  assert.equal(engine.addPoint(picking, searching).changed, true);
  const afterPicking = turf.area(engine.getCoverage(true));
  assert.ok(afterPicking > afterSearching);

  const transportResult = engine.addPoint(transport, picking);
  const afterTransport = turf.area(engine.getCoverage(true));
  assert.equal(transportResult.changed, false);
  approximately(afterTransport, afterPicking, 0.001, "transport skal ikke endre dekningsarealet");
  assert.equal(engine.processedPointCount, 3);
});

test("dekningen lager ingen korridor over et TRANSPORT-strekk", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 10 }
  });
  const first = acceptedPoint({ id: "first" });
  const transportedPosition = destinationLatLng(first, 200);
  const transported = acceptedPoint({
    id: "transport",
    ...transportedPosition,
    timestamp: 5_000,
    activityMode: ACTIVITY.TRANSPORT,
    distanceMeters: 200
  });
  const resumedPosition = destinationLatLng(transported, 10);
  const resumed = acceptedPoint({
    id: "resumed",
    ...resumedPosition,
    timestamp: 9_000,
    distanceMeters: 10
  });

  engine.addPoint(first, null);
  engine.addPoint(transported, first);
  engine.addPoint(resumed, transported);
  const coverage = engine.getCoverage(true);
  const midpoint = destinationLatLng(first, 100);

  assert.equal(
    turf.booleanPointInPolygon(turf.point([midpoint.lng, midpoint.lat]), coverage),
    false,
    "transportstrekket mellom søkepunktene skal stå udekket"
  );
});

test("POOR-posisjoner går til usikker dekning og ikke gyldig dekning", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 1 }
  });
  const poor = acceptedPoint({ quality: QUALITY.POOR, accuracy: 20 });
  const result = engine.addPoint(poor, null);

  assert.equal(result.changed, true);
  assert.equal(result.uncertain, true);
  assert.equal(engine.getCoverage(true), null);
  assert.ok(turf.area(engine.getUncertainCoverage(true)) > 0);
});

test("union er unik, og overlapp måles mot ferdig historikk ved batchslutt", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 1 }
  });
  const point = acceptedPoint();

  const first = engine.addPoint(point, null);
  const firstArea = turf.area(first.geometry);
  const repeated = engine.addPoint(acceptedPoint({ id: "repeat", timestamp: 5_000 }), null);
  const unionArea = turf.area(engine.getCoverage(true));

  assert.equal(first.overlapPercent, 0);
  assert.equal(first.overlapMeasured, true);
  assert.equal(first.flushed, true);
  assert.equal(repeated.flushed, true);
  assert.equal(repeated.overlapMeasured, true);
  assert.ok(repeated.overlapPercent > 99.9, `forventet ~100 % overlapp, fikk ${repeated.overlapPercent}`);
  approximately(unionArea, firstArea, firstArea * 0.001, "identisk dekning skal ikke dobbelttelles");
});

test("batchgrensen rapporterer flush og ikke-bidragende punkt gjør det ikke", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 2 }
  });

  const first = engine.addPoint(acceptedPoint(), null);
  const second = engine.addPoint(acceptedPoint({ timestamp: 5_000 }), null);
  const nonContributing = engine.addPoint(acceptedPoint({
    timestamp: 9_000,
    contributes: false
  }), null);

  assert.equal(first.flushed, false);
  assert.equal(second.flushed, true);
  assert.equal(nonContributing.changed, false);
  assert.equal(nonContributing.flushed, false);
  assert.equal(engine.pendingCoverage.length, 0);
});

test("historisk dekning sjekkes én gang ved slutten av hver ventende batch", () => {
  let intersectionCount = 0;
  const instrumentedTurf = new Proxy(turf, {
    get(target, property, receiver) {
      if (property !== "intersect") return Reflect.get(target, property, receiver);
      return (...args) => {
        intersectionCount += 1;
        return target.intersect(...args);
      };
    }
  });
  const engine = new SurveyCoverageEngine(instrumentedTurf, {
    coverage: rectangle(9.999, 59.999, 10.001, 60.001),
    searchRadiusMeters: 5,
    config: { batchSize: 3 }
  });

  const firstBatchPoint = engine.addPoint(acceptedPoint({ timestamp: 1_000 }), null);
  assert.equal(intersectionCount, 0, "første punkt utsetter historisk måling til batchslutt");
  assert.equal(firstBatchPoint.overlapMeasured, false);
  const secondBatchPoint = engine.addPoint(acceptedPoint({ timestamp: 5_000 }), null);
  assert.equal(intersectionCount, 0, "andre punkt blir med i batchen uten historisk intersection");
  assert.equal(secondBatchPoint.overlapMeasured, false);
  const flushResult = engine.addPoint(acceptedPoint({ timestamp: 9_000 }), null);
  assert.equal(intersectionCount, 1, "batchslutt sjekker den historiske unionen nøyaktig én gang");
  assert.equal(flushResult.overlapMeasured, true);
  assert.equal(flushResult.flushed, true);

  engine.addPoint(acceptedPoint({ timestamp: 13_000 }), null);
  assert.equal(intersectionCount, 1, "ny batch utsetter neste historiske måling");
});

test("batch-overlapp returnerer ubrutt batchdistanse og flush nullstiller den", () => {
  const historic = rectangle(9.999, 59.999, 10.001, 60.001);
  const engine = new SurveyCoverageEngine(turf, {
    coverage: historic,
    searchRadiusMeters: 5,
    config: { batchSize: 3 }
  });

  engine.addPoint(acceptedPoint({ timestamp: 1_000, distanceMeters: 4 }), null);
  engine.flush("valid");
  engine.addPoint(acceptedPoint({ timestamp: 5_000, distanceMeters: 6 }), null);
  engine.addPoint(acceptedPoint({ timestamp: 9_000, distanceMeters: 7 }), null);
  const result = engine.addPoint(acceptedPoint({
    timestamp: 13_000,
    distanceMeters: 0
  }), null);

  assert.equal(result.overlapMeasured, true);
  assert.equal(result.overlapDistanceMeters, 13,
    "distanse før ekstern flush skal ikke følge neste batch");
  assert.ok(result.overlapPercent > 99.9);
});

test("GPS-kjedebrudd isolerer både pending geometri og overlap-distanse", () => {
  const engine = new SurveyCoverageEngine(turf, {
    coverage: rectangle(9.999, 59.999, 10.001, 60.001),
    searchRadiusMeters: 5,
    config: { batchSize: 3 }
  });
  engine.addPoint(acceptedPoint({ timestamp: 1_000, distanceMeters: 10 }), null);
  engine.addPoint(acceptedPoint({ timestamp: 5_000, distanceMeters: 10 }), null);
  const broken = engine.addPoint(acceptedPoint({
    timestamp: 100_000,
    distanceMeters: 80,
    breakBefore: true
  }), null);
  assert.equal(broken.overlapReset, true);
  assert.equal(broken.overlapMeasured, false);
  assert.equal(broken.flushed, true,
    "live-UI skal få vite at dekningen før bruddet ble checkpoint-klar");

  engine.addPoint(acceptedPoint({ timestamp: 104_000, distanceMeters: 5 }), null);
  const after = engine.addPoint(acceptedPoint({ timestamp: 108_000, distanceMeters: 5 }), null);
  assert.equal(after.overlapMeasured, true);
  assert.equal(after.overlapDistanceMeters, 10,
    "distanse fra før bruddet skal ikke tas med i neste overlap-vindu");
});

test("delvis overlapp gir mindre union enn summen av bufferne", () => {
  const engine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 5,
    config: { batchSize: 1 }
  });
  const firstPoint = acceptedPoint();
  const secondPosition = destinationLatLng(firstPoint, 8);
  const secondPoint = acceptedPoint({ ...secondPosition, timestamp: 5_000 });

  const first = engine.addPoint(firstPoint, null);
  const second = engine.addPoint(secondPoint, null);
  const firstArea = turf.area(first.geometry);
  const secondArea = turf.area(second.geometry);
  const unionArea = turf.area(engine.getCoverage(true));

  assert.ok(second.overlapPercent > 0 && second.overlapPercent < 100);
  assert.ok(unionArea > Math.max(firstArea, secondArea));
  assert.ok(unionArea < firstArea + secondArea);
});

test("target clipping teller bare dekning innenfor målpolygonet", () => {
  const target = rectangle(0, 0, 0.001, 0.001);
  const coverage = rectangle(-0.001, -0.0002, 0.00075, 0.0012);
  const stats = coverageStats(turf, target, coverage, []);
  const targetArea = turf.area(target);

  approximately(stats.totalAreaSquareMeters, targetArea, targetArea * 1e-9);
  approximately(stats.coveredAreaSquareMeters, targetArea * 0.75, targetArea * 0.0001);
  approximately(stats.remainingAreaSquareMeters, targetArea * 0.25, targetArea * 0.0001);
  approximately(stats.coveragePercent, 75, 0.01);
  assert.ok(stats.coveredAreaSquareMeters < turf.area(coverage));
});

test("uncovered-geometri deles i meningsfulle hull med areal og posisjon", () => {
  const target = rectangle(0, 0, 0.001, 0.001);
  const middleCoverage = rectangle(0.0004, -0.0001, 0.0006, 0.0011);
  const stats = coverageStats(turf, target, middleCoverage, []);
  const holes = findCoverageHoles(
    turf,
    stats.uncovered,
    { lat: 0.0005, lng: 0.0005 },
    { minimumRelevantHoleAreaSquareMeters: 1 }
  );

  assert.equal(stats.uncovered.geometry.type, "MultiPolygon");
  assert.equal(holes.length, 2);
  approximately(
    holes.reduce((sum, hole) => sum + hole.areaSquareMeters, 0),
    stats.remainingAreaSquareMeters,
    stats.totalAreaSquareMeters * 0.0001
  );
  for (const hole of holes) {
    assert.ok(hole.areaSquareMeters > 1);
    assert.ok(Number.isFinite(hole.distanceFromUserMeters));
    assert.ok(Number.isFinite(hole.bearingFromUserDegrees));
    assert.ok(Number.isFinite(hole.score));
    assert.equal(
      turf.booleanPointInPolygon(turf.point([hole.centroid.lng, hole.centroid.lat]), hole.geometry),
      true,
      "markørpunktet skal ligge i hullet"
    );
  }
  assert.ok(holes[0].score >= holes[1].score);
});

test("exclusions reduserer praktisk target uten å endre originalpolygonet", () => {
  const target = rectangle(0, 0, 0.001, 0.001);
  const targetBefore = JSON.stringify(target);
  const exclusion = rectangle(0.00075, 0, 0.001, 0.001);
  const coverage = rectangle(-0.0001, -0.0001, 0.0005, 0.0011);
  const stats = coverageStats(turf, target, coverage, [{ geometry: exclusion }]);
  const targetArea = turf.area(target);

  assert.equal(JSON.stringify(target), targetBefore, "original target skal forbli urørt");
  approximately(stats.totalAreaSquareMeters, targetArea * 0.75, targetArea * 0.0001);
  approximately(stats.coveredAreaSquareMeters, targetArea * 0.5, targetArea * 0.0001);
  approximately(stats.remainingAreaSquareMeters, targetArea * 0.25, targetArea * 0.0001);
  approximately(stats.coveragePercent, 100 * 2 / 3, 0.01);
});

test("ren worker-avledning gir identiske stats og rangerte hull", () => {
  const target = rectangle(0, 0, 0.0012, 0.001);
  const coverage = rectangle(0.00045, -0.0001, 0.00065, 0.0011);
  const exclusion = rectangle(0.001, 0, 0.0012, 0.001);
  const exclusions = [{ geometry: exclusion, reason: "WATER" }];
  const currentPosition = { lat: 0.0005, lng: 0.00015 };
  const options = { minimumRelevantHoleAreaSquareMeters: 1 };
  const sourceBefore = JSON.stringify({ target, coverage, exclusions });
  const expectedStats = coverageStats(turf, target, coverage, exclusions);
  const expectedHoles = findCoverageHoles(
    turf, expectedStats.uncovered, currentPosition, options
  );

  const derived = deriveCoverageGeometry(
    turf, target, coverage, exclusions, currentPosition, options
  );

  assert.deepEqual(derived.stats, expectedStats);
  assert.deepEqual(derived.holes, expectedHoles);
  assert.ok(derived.holes.length >= 1);
  assert.ok(derived.holes.every((hole, index, holes) =>
    index === 0 || holes[index - 1].score >= hole.score));
  assert.equal(JSON.stringify({ target, coverage, exclusions }), sourceBefore,
    "avledningen skal ikke mutere autoritative geometrier");

  const withoutTarget = deriveCoverageGeometry(turf, null, coverage, [], null, options);
  assert.equal(withoutTarget.stats.coveragePercent, null);
  assert.deepEqual(withoutTarget.holes, []);
  approximately(
    withoutTarget.stats.coveredAreaSquareMeters,
    turf.area(coverage),
    turf.area(coverage) * 1e-9
  );
});

test("worker-avledning propagerer samme konservative Turf-feil som coverageStats", () => {
  const invalidTarget = turf.point([10, 60]);
  const coverage = rectangle(9.999, 59.999, 10.001, 60.001);
  let directError;
  let derivedError;
  try { coverageStats(turf, invalidTarget, coverage, []); }
  catch (error) { directError = error; }
  try { deriveCoverageGeometry(turf, invalidTarget, coverage, [], null, {}); }
  catch (error) { derivedError = error; }

  assert.ok(directError, "ugyldig target skal avvises av Turf");
  assert.ok(derivedError, "worker-helperen skal ikke skjule target-feilen");
  assert.equal(derivedError.message, directError.message);
});

test("coverage-cache kan hydreres og fortsette uten areal- eller tellertap", () => {
  const firstEngine = new SurveyCoverageEngine(turf, {
    searchRadiusMeters: 8,
    config: { batchSize: 10 }
  });
  const valid = acceptedPoint({ id: "valid" });
  const poorPosition = destinationLatLng(valid, 40);
  const poor = acceptedPoint({
    id: "poor",
    ...poorPosition,
    timestamp: 5_000,
    accuracy: 20,
    quality: QUALITY.POOR
  });
  firstEngine.addPoint(valid, null);
  firstEngine.addPoint(poor, null);
  const cached = firstEngine.snapshot();
  const validArea = turf.area(cached.coverage);
  const uncertainArea = turf.area(cached.uncertainCoverage);

  const hydrated = new SurveyCoverageEngine(turf, {
    coverage: cached.coverage,
    uncertainCoverage: cached.uncertainCoverage,
    processedPointCount: cached.processedPointCount,
    searchRadiusMeters: cached.searchRadiusMeters,
    config: { batchSize: 1 }
  });

  assert.equal(hydrated.processedPointCount, 2);
  assert.equal(hydrated.searchRadiusMeters, 8);
  approximately(turf.area(hydrated.getCoverage(true)), validArea, validArea * 1e-9);
  approximately(turf.area(hydrated.getUncertainCoverage(true)), uncertainArea, uncertainArea * 1e-9);

  const duplicate = hydrated.addPoint(acceptedPoint({ id: "valid-again", timestamp: 9_000 }), null);
  assert.ok(duplicate.overlapPercent > 99.9);
  approximately(turf.area(hydrated.getCoverage(true)), validArea, validArea * 0.001);
  assert.equal(hydrated.processedPointCount, 3);
});

test("bulk-gjenoppretting gir samme gyldige/usikre dekning og target-statistikk", () => {
  const target = rectangle(9.999, 59.999, 10.02, 60.002);
  const options = {
    searchRadiusMeters: 8,
    config: { batchSize: 6, bulkChunkSize: 48 }
  };
  const normal = new SurveyCoverageEngine(turf, options);
  const bulk = new SurveyCoverageEngine(turf, options);
  const points = [];
  for (let index = 0; index < 180; index += 1) {
    points.push(acceptedPoint({
      id: `point-${index}`,
      lng: 10 + index * 0.000025,
      lat: 60 + (index % 12) * 0.000002,
      timestamp: 1_000 + index * 4_000,
      distanceMeters: index === 0 ? 0 : 1.4,
      breakBefore: index === 90,
      quality: index >= 120 && index < 150 ? QUALITY.POOR : QUALITY.GOOD,
      accuracy: index >= 120 && index < 150 ? 20 : 4
    }));
  }

  let previous = null;
  for (const point of points) {
    normal.addPoint(point, previous);
    previous = point;
  }
  normal.flush();

  const started = bulk.beginBulk();
  assert.equal(started.chunkSize, 48);
  previous = null;
  for (const point of points) {
    const result = bulk.addPoint(point, previous);
    assert.equal(result.overlapMeasured, false, "stille replay skal ikke sende gamle overlap-varsler");
    previous = point;
  }
  const completed = bulk.endBulk();

  assert.equal(bulk.isBulkActive(), false);
  assert.equal(completed.processedInBulk, points.length);
  assert.equal(completed.validChanged, true);
  assert.equal(completed.uncertainChanged, true);
  assert.equal(completed.overlapSuppressed, true);

  const normalCoverageArea = turf.area(normal.getCoverage(false));
  const bulkCoverageArea = turf.area(bulk.getCoverage(false));
  const normalUncertainArea = turf.area(normal.getUncertainCoverage(false));
  const bulkUncertainArea = turf.area(bulk.getUncertainCoverage(false));
  approximately(bulkCoverageArea, normalCoverageArea, normalCoverageArea * 0.002);
  approximately(bulkUncertainArea, normalUncertainArea, normalUncertainArea * 0.002);

  const normalStats = normal.calculateStats(target, []);
  const bulkStats = bulk.calculateStats(target, []);
  approximately(
    bulkStats.coveredAreaSquareMeters,
    normalStats.coveredAreaSquareMeters,
    normalStats.totalAreaSquareMeters * 0.0001
  );
  approximately(bulkStats.coveragePercent, normalStats.coveragePercent, 0.01);
});

test("bulk-gjenoppretting holder arbeidssett og historiske union-kall avgrenset", () => {
  let unionCount = 0;
  const instrumentedTurf = new Proxy(turf, {
    get(target, property, receiver) {
      if (property !== "union") return Reflect.get(target, property, receiver);
      return (...args) => {
        unionCount += 1;
        return target.union(...args);
      };
    }
  });
  const pointCount = 480;
  const chunkSize = 48;
  const engine = new SurveyCoverageEngine(instrumentedTurf, {
    coverage: rectangle(9.9999, 59.9999, 10.0001, 60.0001),
    searchRadiusMeters: 5,
    config: { batchSize: 6, bulkChunkSize: chunkSize }
  });
  engine.beginBulk();
  let maxPending = 0;
  let previous = null;
  for (let index = 0; index < pointCount; index += 1) {
    const point = acceptedPoint({
      id: `bulk-${index}`,
      lng: 10 + index * 0.000015,
      timestamp: 1_000 + index * 4_000,
      distanceMeters: index === 0 ? 0 : 0.85
    });
    engine.addPoint(point, previous);
    maxPending = Math.max(maxPending, engine.pendingCoverage.length);
    previous = point;
  }
  engine.endBulk();

  const chunks = Math.ceil(pointCount / chunkSize);
  const legacyUnionLowerBound = Math.floor(pointCount / 6) * 2 - 1;
  assert.ok(maxPending < chunkSize, "rå buffergeometri skal tømmes ved hver bulk-chunk");
  assert.ok(
    unionCount <= chunks * 2 + 1,
    `forventet høyst ${chunks * 2 + 1} union-kall, fikk ${unionCount}`
  );
  assert.ok(unionCount < legacyUnionLowerBound / 4,
    "bulkbanen skal bruke klart færre unioner enn gjentatt seks-punkts historikkmerge");
  assert.ok(turf.area(engine.getCoverage(false)) > 0);
});

test("bulkmodus må avsluttes eksplisitt og kan ikke nestes", () => {
  const engine = new SurveyCoverageEngine(turf);
  const started = engine.beginBulk();
  assert.equal(started.chunkSize, 12);
  assert.throws(() => engine.beginBulk(), /allerede i bulkmodus/);
  engine.addPoint(acceptedPoint(), null);
  const transientSnapshot = engine.snapshot();
  assert.ok(turf.area(transientSnapshot.coverage) > 0,
    "et eksplisitt snapshot skal inkludere staged bulkgeometri");
  assert.equal(engine.isBulkActive(), true, "snapshot skal ikke avslutte bulkmodus");
  engine.endBulk();
  assert.throws(() => engine.endBulk(), /ikke i bulkmodus/);
});

test("beginBulkAsync venter på eldre async-geometri før bulkmodus starter", async () => {
  let releaseMerge;
  const executor = job => new Promise(resolve => {
    releaseMerge = () => resolve(mergeCoverageBatch(
      turf, job.existingCoverage, job.geometries
    ));
  });
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 1 },
    geometryExecutor: executor
  });
  const adding = engine.addPointAsync(acceptedPoint({ id: "before-bulk" }), null);
  while (!releaseMerge) await Promise.resolve();

  let bulkStarted = false;
  const beginning = engine.beginBulkAsync({ chunkSize: 24 }).then(result => {
    bulkStarted = true;
    return result;
  });
  await Promise.resolve();

  assert.equal(bulkStarted, false, "bulkovergangen kan ikke passere en eldre merge");
  assert.equal(engine.isBulkActive(), false);
  releaseMerge();
  await adding;
  const started = await beginning;

  assert.equal(started.active, true);
  assert.equal(started.chunkSize, 24);
  assert.equal(started.processedPointCount, 1);
  assert.equal(engine.isBulkActive(), true);
  assert.ok(turf.area(engine.getCoverage(false)) > 0,
    "den eldre merge-en skal være committet før bulkmodus starter");
  engine.endBulk();
});

test("async-jobb etter beginBulkAsync kan ikke slippe foran bulkovergangen", async () => {
  let releaseMerge;
  const executor = job => new Promise(resolve => {
    releaseMerge = () => resolve(mergeCoverageBatch(
      turf, job.existingCoverage, job.geometries
    ));
  });
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 1 },
    geometryExecutor: executor
  });
  const adding = engine.addPointAsync(acceptedPoint({ id: "queue-blocker" }), null);
  while (!releaseMerge) await Promise.resolve();

  const beginning = engine.beginBulkAsync();
  // Ved kalltidspunktet er bulk ennå ikke aktiv. Jobben blir derfor tatt inn
  // i køen, men må møte bulk-kontrollen etter den atomiske overgangen.
  const viewing = engine.viewSnapshotAsync(false);
  releaseMerge();
  await adding;
  await beginning;

  await assert.rejects(viewing, /bulkmodus/);
  assert.equal(engine.isBulkActive(), true);
  assert.equal(engine.processedPointCount, 1);
  engine.endBulk();
});

test("asynkron live-merge er serialisert og identisk med synkron dekning", async () => {
  let activeJobs = 0;
  let maximumActiveJobs = 0;
  const operations = [];
  const executor = async job => {
    activeJobs += 1;
    maximumActiveJobs = Math.max(maximumActiveJobs, activeJobs);
    operations.push(job.operation);
    await new Promise(resolve => setTimeout(resolve, 1));
    try {
      if (job.operation === "mergeCoverageBatch") {
        return mergeCoverageBatch(turf, job.existingCoverage, job.geometries);
      }
      return mergeCoverageChunksBalanced(turf, job.existingCoverage, job.geometries);
    } finally {
      activeJobs -= 1;
    }
  };
  const options = { searchRadiusMeters: 5, config: { batchSize: 3 } };
  const synchronous = new SurveyCoverageEngine(turf, options);
  const asynchronous = new SurveyCoverageEngine(turf, {
    ...options,
    geometryExecutor: executor
  });
  const points = [];
  for (let index = 0; index < 11; index += 1) {
    const poor = index >= 3 && index <= 5;
    points.push(acceptedPoint({
      id: `async-${index}`,
      lng: 10 + index * 0.00005,
      timestamp: 1_000 + index * 4_000,
      distanceMeters: index ? 2.8 : 0,
      quality: poor ? QUALITY.POOR : QUALITY.GOOD,
      accuracy: poor ? 20 : 4,
      breakBefore: index === 8
    }));
  }

  const expectedResults = [];
  const pendingResults = [];
  let previous = null;
  for (const point of points) {
    expectedResults.push(synchronous.addPoint(point, previous));
    // Bevisst uten await: motorens egen kø må bevare rekkefølgen.
    pendingResults.push(asynchronous.addPointAsync(point, previous));
    previous = point;
  }
  const actualResults = await Promise.all(pendingResults);
  const expectedSnapshot = synchronous.snapshot();
  const actualSnapshot = await asynchronous.snapshotAsync();

  assert.equal(maximumActiveJobs, 1, "bare én geometri-jobb kan være aktiv om gangen");
  assert.ok(operations.length >= 4, "gyldig, usikker og break-flush skal offloades");
  assert.ok(
    actualResults.filter(result => Object.hasOwn(result, "offloaded"))
      .every(result => result.offloaded === true),
    "alle batcher med konfigurert executor skal merkes som offloadet"
  );
  for (let index = 0; index < expectedResults.length; index += 1) {
    for (const key of ["changed", "uncertain", "overlapMeasured", "overlapReset", "flushed"]) {
      assert.equal(actualResults[index][key], expectedResults[index][key], `${key} ved punkt ${index}`);
    }
    approximately(
      actualResults[index].overlapPercent,
      expectedResults[index].overlapPercent,
      1e-9,
      `overlap ved punkt ${index}`
    );
    approximately(
      actualResults[index].overlapDistanceMeters,
      expectedResults[index].overlapDistanceMeters,
      1e-9,
      `overlap-distanse ved punkt ${index}`
    );
  }
  assert.equal(actualResults[8].overlapReset, true);
  assert.equal(actualResults[8].flushed, true, "break skal committe begge pending-klasser før nytt punkt");
  assert.equal(actualSnapshot.processedPointCount, expectedSnapshot.processedPointCount);
  assert.deepEqual(Object.keys(actualSnapshot).sort(), Object.keys(expectedSnapshot).sort());
  assert.deepEqual(actualSnapshot.coverage, expectedSnapshot.coverage);
  assert.deepEqual(actualSnapshot.uncertainCoverage, expectedSnapshot.uncertainCoverage);
});

test("snapshot kan ikke passere en ucommittet worker-jobb", async () => {
  let releaseJob;
  const executor = job => new Promise(resolve => {
    releaseJob = () => resolve(mergeCoverageBatch(
      turf, job.existingCoverage, job.geometries
    ));
  });
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 1 },
    geometryExecutor: executor
  });
  const pending = engine.addPointAsync(acceptedPoint(), null);
  while (!releaseJob) await Promise.resolve();

  assert.equal(engine.isAsyncActive(), true);
  assert.throws(() => engine.snapshot(false), /asynkron coverage-geometri/);
  assert.throws(() => engine.flush(), /asynkron coverage-geometri/);
  assert.throws(() => engine.addPoint(acceptedPoint({ timestamp: 2_000 }), null),
    /asynkron coverage-geometri/);
  releaseJob();
  await pending;
  await engine.whenIdle();

  assert.equal(engine.isAsyncActive(), false);
  assert.ok(turf.area(engine.snapshot(false).coverage) > 0);
});

test("viewSnapshotAsync(false) viser all pending geometri uten å committe eller nullstille overlap", async () => {
  const jobs = [];
  const executor = async job => {
    jobs.push(job);
    await Promise.resolve();
    return mergeCoverageBatch(turf, job.existingCoverage, job.geometries);
  };
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 8 },
    geometryExecutor: executor
  });
  const good = acceptedPoint({ id: "preview-good", distanceMeters: 0 });
  const poor = acceptedPoint({
    id: "preview-poor",
    lng: 10.00005,
    timestamp: 5_000,
    distanceMeters: 2.8,
    quality: QUALITY.POOR,
    accuracy: 20
  });
  engine.addPoint(good, null);
  engine.addPoint(poor, good);

  const coverageReference = engine.coverage;
  const uncertainCoverageReference = engine.uncertainCoverage;
  const pendingCoverageReference = engine.pendingCoverage;
  const pendingUncertainReference = engine.pendingUncertainCoverage;
  const pendingCoverageItems = engine.pendingCoverage.slice();
  const pendingUncertainItems = engine.pendingUncertainCoverage.slice();
  const validDistance = engine.pendingCoverageDistanceMeters;
  const uncertainDistance = engine.pendingUncertainCoverageDistanceMeters;
  const processedPointCount = engine.processedPointCount;
  const expectedCoverage = mergeCoverageBatch(
    turf, coverageReference, pendingCoverageItems
  ).coverage;
  const expectedUncertainCoverage = mergeCoverageBatch(
    turf, uncertainCoverageReference, pendingUncertainItems
  ).coverage;

  const view = await engine.viewSnapshotAsync(false);

  assert.equal(jobs.length, 2, "gyldig og usikker preview skal begge gå via executor");
  assert.notStrictEqual(jobs[0].geometries, pendingCoverageReference,
    "executor skal få en kopi av pending-arrayet");
  assert.notStrictEqual(jobs[1].geometries, pendingUncertainReference,
    "executor skal få en kopi av det usikre pending-arrayet");
  assert.deepEqual(view.coverage, expectedCoverage);
  assert.deepEqual(view.uncertainCoverage, expectedUncertainCoverage);
  assert.equal(view.processedPointCount, processedPointCount);

  assert.strictEqual(engine.coverage, coverageReference);
  assert.strictEqual(engine.uncertainCoverage, uncertainCoverageReference);
  assert.strictEqual(engine.pendingCoverage, pendingCoverageReference);
  assert.strictEqual(engine.pendingUncertainCoverage, pendingUncertainReference);
  assert.deepEqual(engine.pendingCoverage, pendingCoverageItems);
  assert.deepEqual(engine.pendingUncertainCoverage, pendingUncertainItems);
  assert.equal(engine.pendingCoverageDistanceMeters, validDistance);
  assert.equal(engine.pendingUncertainCoverageDistanceMeters, uncertainDistance);
  assert.equal(engine.processedPointCount, processedPointCount);
});

test("viewSnapshotAsync er serialisert bak en ucommittet addPointAsync", async () => {
  let releaseMerge;
  const executor = job => new Promise(resolve => {
    releaseMerge = () => resolve(mergeCoverageBatch(
      turf, job.existingCoverage, job.geometries
    ));
  });
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 1 },
    geometryExecutor: executor
  });
  const adding = engine.addPointAsync(acceptedPoint({ id: "queued-before-view" }), null);
  while (!releaseMerge) await Promise.resolve();
  let viewResolved = false;
  const viewing = engine.viewSnapshotAsync(false).then(snapshot => {
    viewResolved = true;
    return snapshot;
  });
  await Promise.resolve();

  assert.equal(viewResolved, false, "preview kan ikke passere den eldre worker-jobben");
  releaseMerge();
  await adding;
  const view = await viewing;

  assert.equal(view.processedPointCount, 1);
  assert.ok(turf.area(view.coverage) > 0);
  assert.equal(engine.isAsyncActive(), false);
});

test("viewSnapshotAsync(true) committer pending geometri som et vanlig async snapshot", async () => {
  const executor = job => Promise.resolve(mergeCoverageBatch(
    turf, job.existingCoverage, job.geometries
  ));
  const engine = new SurveyCoverageEngine(turf, {
    config: { batchSize: 8 },
    geometryExecutor: executor
  });
  const first = acceptedPoint({ id: "commit-view-1", distanceMeters: 0 });
  const second = acceptedPoint({
    id: "commit-view-2", lng: 10.00005, timestamp: 5_000, distanceMeters: 2.8
  });
  engine.addPoint(first, null);
  engine.addPoint(second, first);
  assert.equal(engine.pendingCoverage.length, 2);

  const snapshot = await engine.viewSnapshotAsync(true);

  assert.equal(engine.pendingCoverage.length, 0);
  assert.equal(engine.pendingCoverageDistanceMeters, 0);
  assert.strictEqual(snapshot.coverage, engine.coverage);
  assert.equal(snapshot.processedPointCount, 2);
});

test("viewSnapshotAsync avviser tydelig under bulk uten å endre bulk-state", async () => {
  const engine = new SurveyCoverageEngine(turf);
  engine.beginBulk();
  engine.addPoint(acceptedPoint({ id: "bulk-preview" }), null);
  const pendingBefore = engine.pendingCoverage.slice();

  await assert.rejects(engine.viewSnapshotAsync(false), /bulkmodus/);
  await assert.rejects(engine.viewSnapshotAsync(true), /bulkmodus/);

  assert.equal(engine.isBulkActive(), true);
  assert.deepEqual(engine.pendingCoverage, pendingBefore);
  engine.endBulk();
});

test("worker-feil bruker eksakt synkron fallback uten å miste pending geometri", async () => {
  const options = { searchRadiusMeters: 5, config: { batchSize: 2 } };
  const expected = new SurveyCoverageEngine(turf, options);
  const actual = new SurveyCoverageEngine(turf, {
    ...options,
    geometryExecutor: async () => { throw new Error("worker utilgjengelig"); }
  });
  const first = acceptedPoint({ id: "fallback-1", distanceMeters: 0 });
  const second = acceptedPoint({
    id: "fallback-2", lng: 10.00005, timestamp: 5_000, distanceMeters: 2.8
  });
  expected.addPoint(first, null);
  const expectedResult = expected.addPoint(second, first);
  await actual.addPointAsync(first, null);
  const actualResult = await actual.addPointAsync(second, first);

  assert.equal(actualResult.offloaded, false);
  assert.equal(actualResult.offloadFallback, true);
  assert.match(actualResult.offloadError, /worker utilgjengelig/);
  assert.equal(actual.pendingCoverage.length, 0);
  assert.ok(actual.lastGeometryFallback);
  approximately(actualResult.overlapPercent, expectedResult.overlapPercent, 1e-9);
  assert.deepEqual(actual.snapshot(false).coverage, expected.snapshot(false).coverage);
});

test("asynkron API uten executor merker lokal kjøring uten å late som worker-feil", async () => {
  const engine = new SurveyCoverageEngine(turf, { config: { batchSize: 1 } });
  const result = await engine.addPointAsync(acceptedPoint(), null);

  assert.equal(result.offloaded, false);
  assert.equal(result.offloadFallback, false);
  assert.equal(result.offloadError, null);
  assert.ok(turf.area(engine.getCoverage(false)) > 0);
});

test("geometri-workerens meldingskontrakt bruker de eksporterte eksakte helperne", () => {
  const responses = [];
  const imported = [];
  const workerSelf = {
    postMessage(message) { responses.push(message); }
  };
  const context = {
    self: workerSelf,
    importScripts(...resources) {
      imported.push(...resources);
      workerSelf.turf = turf;
      workerSelf.LyngSurveyCore = require("../src/survey-core.js");
    }
  };
  vm.runInNewContext(
    readFileSync(require.resolve("../src/survey-geometry-worker.js"), "utf8"),
    context,
    { filename: "survey-geometry-worker.js" }
  );
  const geometry = turf.buffer(turf.point([10, 60]), 0.005, {
    units: "kilometers", steps: 8
  });
  workerSelf.onmessage({ data: {
    requestId: "merge-1",
    operation: "mergeCoverageBatch",
    existingCoverage: null,
    geometries: [geometry]
  } });

  assert.deepEqual(imported, ["vendor/turf.min.js", "survey-core.js"]);
  assert.equal(responses[0].requestId, "merge-1");
  assert.equal(responses[0].ok, true);
  approximately(turf.area(responses[0].result.coverage), turf.area(geometry), 1e-9);

  const target = rectangle(9.9998, 59.9998, 10.0002, 60.0002);
  const derivePayload = {
    requestId: "derive-1",
    operation: "deriveCoverageGeometry",
    target,
    coverage: geometry,
    exclusions: [],
    currentPosition: { lat: 60, lng: 10 },
    options: { minimumRelevantHoleAreaSquareMeters: 1 }
  };
  workerSelf.onmessage({ data: derivePayload });
  const expectedDerived = deriveCoverageGeometry(
    turf,
    derivePayload.target,
    derivePayload.coverage,
    derivePayload.exclusions,
    derivePayload.currentPosition,
    derivePayload.options
  );
  assert.equal(responses[1].requestId, "derive-1");
  assert.equal(responses[1].ok, true);
  assert.deepEqual(responses[1].result, expectedDerived);

  workerSelf.onmessage({ data: {
    requestId: "derive-bad",
    operation: "deriveCoverageGeometry",
    target: turf.point([10, 60]),
    coverage: geometry
  } });
  assert.equal(responses[2].requestId, "derive-bad");
  assert.equal(responses[2].ok, false);
  assert.match(responses[2].error.message, /Polygon/i);

  workerSelf.onmessage({ data: { requestId: "bad-1", operation: "ukjent" } });
  assert.equal(responses[3].requestId, "bad-1");
  assert.equal(responses[3].ok, false);
  assert.match(responses[3].error.message, /Ukjent survey-geometrioperasjon/);
});

test("endBulkAsync offloader balansert sluttunion og committer atomisk", async () => {
  const options = {
    searchRadiusMeters: 5,
    config: { batchSize: 3, bulkChunkSize: 8 }
  };
  const expected = new SurveyCoverageEngine(turf, options);
  const actual = new SurveyCoverageEngine(turf, options);
  expected.beginBulk();
  actual.beginBulk();
  let previous = null;
  for (let index = 0; index < 40; index += 1) {
    const poor = index >= 18 && index < 29;
    const point = acceptedPoint({
      id: `bulk-async-${index}`,
      lng: 10 + index * 0.00003,
      timestamp: 1_000 + index * 4_000,
      distanceMeters: index ? 1.7 : 0,
      quality: poor ? QUALITY.POOR : QUALITY.GOOD,
      accuracy: poor ? 20 : 4,
      breakBefore: index === 31
    });
    expected.addPoint(point, previous);
    actual.addPoint(point, previous);
    previous = point;
  }
  const expectedResult = expected.endBulk();
  let executorCalls = 0;
  const ending = actual.endBulkAsync(async () => {
    executorCalls += 1;
    throw new Error("simulert worker-krasj");
  });
  assert.throws(() => actual.snapshot(false), /asynkron coverage-geometri/,
    "bulk-snapshot må vente til begge klasser er klare");
  const actualResult = await ending;

  assert.equal(executorCalls, 2, "gyldig og usikker sluttunion offloades separat");
  assert.equal(actualResult.offloaded, false);
  assert.equal(actualResult.offloadFallback, true);
  assert.equal(actualResult.processedInBulk, expectedResult.processedInBulk);
  assert.equal(actual.isBulkActive(), false);
  assert.deepEqual(actualResult.snapshot.coverage, expectedResult.snapshot.coverage);
  assert.deepEqual(actualResult.snapshot.uncertainCoverage, expectedResult.snapshot.uncertainCoverage);
});

test("createSurvey bruker valgt profil og normaliserer aktivitet", () => {
  const survey = createSurvey({
    id: "survey-test",
    startedAt: 1234,
    coverageProfile: "VERY_THOROUGH",
    currentActivity: "plukk"
  });

  assert.equal(survey.id, "survey-test");
  assert.equal(survey.startedAt, 1234);
  assert.equal(survey.status, "ACTIVE");
  assert.equal(survey.searchRadiusMeters, 3);
  assert.equal(survey.currentActivity, ACTIVITY.PICKING);
  assert.deepEqual(survey.points, []);
  assert.equal(survey.coverageCache, null);
});
