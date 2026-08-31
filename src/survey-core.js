/* Lyng Survey Core
 *
 * Ren, UI-uavhengig surveylogikk. Modulen kan brukes direkte i nettleseren
 * (window.LyngSurveyCore) og fra Node-testene (require()). Turf injiseres i
 * CoverageEngine slik at kjernen ikke er bundet til en bestemt byggkjede.
 */
(function exposeSurveyCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyngSurveyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSurveyCore() {
  "use strict";

  const EARTH_RADIUS_METERS = 6371008.8;

  const ACTIVITY = Object.freeze({
    SEARCHING: "SEARCHING",
    PICKING: "PICKING",
    TRANSPORT: "TRANSPORT"
  });

  const QUALITY = Object.freeze({
    GOOD: "GOOD",
    ACCEPTABLE: "ACCEPTABLE",
    POOR: "POOR",
    REJECTED: "REJECTED"
  });

  const COVERAGE_PROFILES = Object.freeze({
    VERY_THOROUGH: Object.freeze({ id: "VERY_THOROUGH", label: "Svært grundig", radiusMeters: 3 }),
    THOROUGH: Object.freeze({ id: "THOROUGH", label: "Grundig", radiusMeters: 5 }),
    NORMAL: Object.freeze({ id: "NORMAL", label: "Normal scouting", radiusMeters: 8 }),
    ROUGH: Object.freeze({ id: "ROUGH", label: "Grovsøk", radiusMeters: 12 })
  });

  const DEFAULT_CONFIG = Object.freeze({
    quality: Object.freeze({
      goodMaxAccuracyMeters: 6,
      acceptableMaxAccuracyMeters: 12,
      poorMaxAccuracyMeters: 25,
      maxWalkingSpeedMetersPerSecond: 5,
      maxTransportSpeedMetersPerSecond: 55,
      jumpAccuracyAllowanceFactor: 0.45,
      minimumJumpAllowanceMeters: 20,
      minimumMovementMeters: 2,
      stationaryKeepAliveMs: 30000,
      maximumSegmentGapMs: 30000
    }),
    coverage: Object.freeze({
      batchSize: 6,
      // Små, balanserte replay-deler er raskere i Turf enn store flate
      // FeatureCollections, samtidig som de aldri flettes inn i full historikk
      // én etter én.
      bulkChunkSize: 12,
      bufferSteps: 8,
      minimumRelevantHoleAreaSquareMeters: 20,
      completionPercent: 95,
      nextHoleDistanceWeightMeters: 35,
      liveHoleRefreshMs: 7500,
      workerTimeoutMs: 15000,
      checkpointTailPoints: 240
    }),
    tracking: Object.freeze({
      intervalMs: 4000,
      minimumDistanceMeters: 4
    }),
    alerts: Object.freeze({
      poorGpsAfterMs: 30000,
      overlapSegmentMeters: 30,
      highOverlapPercent: 80,
      cooldownMs: 120000
    })
  });

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function finiteSampleNumber(value, fallback) {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && value.trim() === "")) {
      return fallback;
    }
    return finiteNumber(value, fallback);
  }

  function normalizeElapsedRealtimeNanos(value) {
    if (value == null) return null;
    let decimal;
    if (typeof value === "bigint") {
      decimal = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) return null;
      decimal = BigInt(value);
    } else {
      const text = String(value).trim();
      if (!/^\d+$/.test(text)) return null;
      try {
        decimal = BigInt(text);
      } catch (_error) {
        return null;
      }
    }
    return decimal < 0n ? null : decimal.toString();
  }

  function elapsedRealtimeDeltaMs(current, previous) {
    const currentNanos = normalizeElapsedRealtimeNanos(current);
    const previousNanos = normalizeElapsedRealtimeNanos(previous);
    if (currentNanos == null || previousNanos == null) return null;
    const deltaMs = Number(BigInt(currentNanos) - BigInt(previousNanos)) / 1e6;
    return Number.isFinite(deltaMs) ? deltaMs : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toRadians(degrees) {
    return degrees * Math.PI / 180;
  }

  function haversineMeters(a, b) {
    if (!a || !b) return 0;
    const lat1 = toRadians(finiteNumber(a.lat != null ? a.lat : a.latitude, 0));
    const lat2 = toRadians(finiteNumber(b.lat != null ? b.lat : b.latitude, 0));
    const deltaLat = lat2 - lat1;
    const lng1 = toRadians(finiteNumber(a.lng != null ? a.lng : a.longitude, 0));
    const lng2 = toRadians(finiteNumber(b.lng != null ? b.lng : b.longitude, 0));
    const deltaLng = lng2 - lng1;
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDegrees(a, b) {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLng = toRadians(b.lng - a.lng);
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function normalizeActivity(value) {
    const activity = String(value || "").toUpperCase();
    if (activity === ACTIVITY.SEARCHING || activity === "GAA" || activity === "GÅ" || activity === "SEARCH") {
      return ACTIVITY.SEARCHING;
    }
    if (activity === ACTIVITY.PICKING || activity === "PLUKK" || activity === "PICK") {
      return ACTIVITY.PICKING;
    }
    return ACTIVITY.TRANSPORT;
  }

  function classifyAccuracy(accuracy, config) {
    const thresholds = config || DEFAULT_CONFIG.quality;
    const value = finiteNumber(accuracy, Infinity);
    if (value <= thresholds.goodMaxAccuracyMeters) return QUALITY.GOOD;
    if (value <= thresholds.acceptableMaxAccuracyMeters) return QUALITY.ACCEPTABLE;
    if (value <= thresholds.poorMaxAccuracyMeters) return QUALITY.POOR;
    return QUALITY.REJECTED;
  }

  function normalizeRawSample(raw) {
    const source = raw || {};
    const latitude = source.lat != null ? source.lat : source.latitude;
    const longitude = source.lng != null ? source.lng : source.longitude;
    return {
      id: source.id == null ? null : source.id,
      surveyId: source.surveyId == null ? null : String(source.surveyId),
      lat: finiteSampleNumber(latitude, NaN),
      lng: finiteSampleNumber(longitude, NaN),
      timestamp: finiteNumber(source.timestamp != null ? source.timestamp : source.time, Date.now()),
      accuracy: Math.max(0, finiteSampleNumber(source.accuracy, Infinity)),
      altitude: source.altitude == null ? null : finiteNumber(source.altitude, null),
      speed: source.speed == null ? null : finiteNumber(source.speed, null),
      heading: source.heading == null && source.bearing == null
        ? null
        : finiteNumber(source.heading != null ? source.heading : source.bearing, null),
      activityMode: normalizeActivity(source.activityMode || source.activity),
      source: String(source.source || "WEB_GEOLOCATION"),
      mock: !!source.mock,
      bootId: source.bootId == null ? null : String(source.bootId),
      elapsedRealtimeNanos: normalizeElapsedRealtimeNanos(source.elapsedRealtimeNanos)
    };
  }

  class LocationQualityFilter {
    constructor(config) {
      this.config = Object.assign({}, DEFAULT_CONFIG.quality, config || {});
    }

    process(raw, previousAccepted) {
      const sample = normalizeRawSample(raw);
      let quality = classifyAccuracy(sample.accuracy, this.config);
      let accepted = quality !== QUALITY.REJECTED;
      let rejectionReason = accepted ? null : "ACCURACY";
      let distanceMeters = 0;
      let calculatedSpeedMetersPerSecond = 0;
      let contributes = accepted;
      let breakBefore = false;

      if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng) ||
          Math.abs(sample.lat) > 90 || Math.abs(sample.lng) > 180) {
        accepted = false;
        quality = QUALITY.REJECTED;
        rejectionReason = "INVALID_COORDINATES";
      }

      if (sample.mock) {
        accepted = false;
        quality = QUALITY.REJECTED;
        rejectionReason = "MOCK_LOCATION";
      }

      if (accepted && previousAccepted) {
        const previousTimestamp = finiteNumber(previousAccepted.timestamp, 0);
        const wallClockDeltaMs = sample.timestamp - previousTimestamp;
        const sameBoot = sample.bootId != null && previousAccepted.bootId != null &&
          String(sample.bootId) === String(previousAccepted.bootId);
        const bootChanged = sample.bootId != null && previousAccepted.bootId != null &&
          String(sample.bootId) !== String(previousAccepted.bootId);
        const monotonicDeltaMs = sameBoot
          ? elapsedRealtimeDeltaMs(
            sample.elapsedRealtimeNanos,
            previousAccepted.elapsedRealtimeNanos
          )
          : null;
        const deltaMs = monotonicDeltaMs == null ? wallClockDeltaMs : monotonicDeltaMs;
        if (bootChanged || deltaMs > this.config.maximumSegmentGapMs) breakBefore = true;
        if (bootChanged) {
          // Monotonic tid og veggklokke kan begge hoppe ved omstart. Det første
          // punktet i ny boot etablerer derfor en ny kjede uten å måles mot den gamle.
          distanceMeters = 0;
          calculatedSpeedMetersPerSecond = 0;
        } else if (deltaMs < -1000) {
          accepted = false;
          quality = QUALITY.REJECTED;
          rejectionReason = "OUT_OF_ORDER";
        } else {
          const deltaSeconds = Math.max(0.25, deltaMs / 1000);
          distanceMeters = haversineMeters(previousAccepted, sample);
          calculatedSpeedMetersPerSecond = distanceMeters / deltaSeconds;
          const previousAccuracy = finiteNumber(previousAccepted.accuracy, sample.accuracy);
          const previousActivity = normalizeActivity(previousAccepted.activityMode);
          const maxSpeed = sample.activityMode === ACTIVITY.TRANSPORT ||
              previousActivity === ACTIVITY.TRANSPORT
            ? this.config.maxTransportSpeedMetersPerSecond
            : this.config.maxWalkingSpeedMetersPerSecond;
          const allowance = Math.max(
            this.config.minimumJumpAllowanceMeters,
            deltaSeconds * maxSpeed +
              (sample.accuracy + previousAccuracy) * this.config.jumpAccuracyAllowanceFactor
          );
          if (distanceMeters > allowance && calculatedSpeedMetersPerSecond > maxSpeed) {
            accepted = false;
            quality = QUALITY.REJECTED;
            rejectionReason = "IMPLAUSIBLE_JUMP";
          } else if (distanceMeters < this.config.minimumMovementMeters &&
                     deltaMs < this.config.stationaryKeepAliveMs) {
            contributes = false;
          }
        }
      }

      return Object.assign(sample, {
        quality,
        accepted,
        rejectionReason,
        contributes: accepted && contributes,
        breakBefore,
        distanceMeters,
        calculatedSpeedMetersPerSecond
      });
    }
  }

  function requireTurf(turf) {
    if (!turf || typeof turf.buffer !== "function" || typeof turf.union !== "function") {
      throw new Error("SurveyCoverageEngine krever Turf.js 7 eller nyere");
    }
    return turf;
  }

  function asFeatureCollection(turf, features) {
    return turf.featureCollection((features || []).filter(Boolean));
  }

  function unionFeatures(turf, features) {
    const valid = (features || []).filter(Boolean);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];
    return turf.union(asFeatureCollection(turf, valid));
  }

  function unionFeaturesBalanced(turf, features) {
    let level = (features || []).filter(Boolean);
    if (!level.length) return null;
    while (level.length > 1) {
      const next = [];
      for (let index = 0; index < level.length; index += 2) {
        next.push(index + 1 < level.length
          ? unionFeatures(turf, [level[index], level[index + 1]])
          : level[index]);
      }
      level = next;
    }
    return level[0];
  }

  function intersectFeatures(turf, first, second) {
    if (!first || !second) return null;
    return turf.intersect(asFeatureCollection(turf, [first, second]));
  }

  function differenceFeatures(turf, first, second) {
    if (!first) return null;
    if (!second) return first;
    return turf.difference(asFeatureCollection(turf, [first, second]));
  }

  function polygonFromLatLngs(turfApi, points, properties) {
    const turf = requireTurf(turfApi);
    const coordinates = (points || [])
      .map(point => [finiteNumber(point.lng != null ? point.lng : point[1], NaN),
        finiteNumber(point.lat != null ? point.lat : point[0], NaN)])
      .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (coordinates.length < 3) return null;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push(first.slice());
    return turf.polygon([coordinates], properties || {});
  }

  function effectiveTargetGeometry(turfApi, target, exclusions) {
    const turf = requireTurf(turfApi);
    let effective = target || null;
    for (const exclusion of exclusions || []) {
      const geometry = exclusion && (exclusion.geometry || exclusion);
      if (!effective || !geometry) continue;
      effective = differenceFeatures(turf, effective, geometry);
    }
    return effective;
  }

  function coverageStats(turfApi, target, coverage, exclusions) {
    const turf = requireTurf(turfApi);
    const effectiveTarget = effectiveTargetGeometry(turf, target, exclusions);
    if (!effectiveTarget) {
      const coveredAreaSquareMeters = coverage ? turf.area(coverage) : 0;
      return {
        effectiveTarget: null,
        coveredWithinTarget: null,
        uncovered: null,
        totalAreaSquareMeters: 0,
        coveredAreaSquareMeters,
        remainingAreaSquareMeters: 0,
        coveragePercent: null
      };
    }
    const totalAreaSquareMeters = Math.max(0, turf.area(effectiveTarget));
    const coveredWithinTarget = coverage ? intersectFeatures(turf, effectiveTarget, coverage) : null;
    const coveredAreaSquareMeters = coveredWithinTarget ? Math.max(0, turf.area(coveredWithinTarget)) : 0;
    const uncovered = coverage ? differenceFeatures(turf, effectiveTarget, coverage) : effectiveTarget;
    const remainingAreaSquareMeters = Math.max(0, totalAreaSquareMeters - coveredAreaSquareMeters);
    const coveragePercent = totalAreaSquareMeters > 0
      ? clamp(coveredAreaSquareMeters / totalAreaSquareMeters * 100, 0, 100)
      : 0;
    return {
      effectiveTarget,
      coveredWithinTarget,
      uncovered,
      totalAreaSquareMeters,
      coveredAreaSquareMeters,
      remainingAreaSquareMeters,
      coveragePercent
    };
  }

  function stableHoleId(centroid, areaSquareMeters) {
    return [
      centroid.lat.toFixed(5),
      centroid.lng.toFixed(5),
      Math.round(areaSquareMeters / 10) * 10
    ].join(":");
  }

  function findCoverageHoles(turfApi, uncoveredGeometry, currentPosition, options) {
    const turf = requireTurf(turfApi);
    const config = Object.assign({}, DEFAULT_CONFIG.coverage, options || {});
    if (!uncoveredGeometry) return [];
    const flattened = turf.flatten(uncoveredGeometry);
    const ignored = new Set(config.ignoredHoleIds || []);
    const holes = [];
    for (const feature of flattened.features || []) {
      const areaSquareMeters = Math.max(0, turf.area(feature));
      if (areaSquareMeters < config.minimumRelevantHoleAreaSquareMeters) continue;
      let centerFeature = turf.centerOfMass(feature);
      if (!turf.booleanPointInPolygon(centerFeature, feature)) centerFeature = turf.pointOnFeature(feature);
      const coordinates = centerFeature.geometry.coordinates;
      const centroid = { lat: coordinates[1], lng: coordinates[0] };
      const id = stableHoleId(centroid, areaSquareMeters);
      if (ignored.has(id)) continue;
      const distanceFromUserMeters = currentPosition
        ? haversineMeters(currentPosition, centroid)
        : Infinity;
      const bearingFromUserDegrees = currentPosition
        ? bearingDegrees(currentPosition, centroid)
        : null;
      const distanceWeight = Math.max(1, config.nextHoleDistanceWeightMeters);
      const score = areaSquareMeters / (1 + distanceFromUserMeters / distanceWeight);
      holes.push({
        id,
        geometry: feature,
        centroid,
        areaSquareMeters,
        distanceFromUserMeters,
        bearingFromUserDegrees,
        score
      });
    }
    holes.sort((a, b) => b.score - a.score || a.distanceFromUserMeters - b.distanceFromUserMeters);
    return holes;
  }

  // Ren, serialiserbar avledning for hovedtråd eller Worker. Geometrifeil
  // fanges bevisst ikke her: samme Turf-feil skal nå UI-et uansett hvor
  // beregningen kjøres, slik at eksisterende konservative fallback til
  // statistikk uten målpolygon kan beholdes ett sted.
  function deriveCoverageGeometry(turfApi, target, coverage, exclusions,
      currentPosition, options) {
    const stats = coverageStats(turfApi, target, coverage, exclusions);
    const holes = findCoverageHoles(
      turfApi,
      stats.uncovered,
      currentPosition || null,
      options || {}
    );
    return { stats, holes };
  }

  function calculateSegmentOverlap(turfApi, segmentGeometry, existingCoverage) {
    const turf = requireTurf(turfApi);
    if (!segmentGeometry || !existingCoverage) return 0;
    const total = turf.area(segmentGeometry);
    if (total <= 0) return 0;
    const overlap = intersectFeatures(turf, segmentGeometry, existingCoverage);
    return overlap ? clamp(turf.area(overlap) / total * 100, 0, 100) : 0;
  }

  // Dette er den eneste implementasjonen av en ordinær coverage-merge.
  // Både hovedtråden og Web Worker-en bruker samme funksjon slik at
  // offloading ikke kan endre unionrekkefølge, overlap eller snapshot-format.
  function mergeCoverageBatch(turfApi, existingCoverage, pendingGeometries) {
    const turf = requireTurf(turfApi);
    const batch = unionFeatures(turf, pendingGeometries);
    if (!batch) {
      return { batch: null, coverage: existingCoverage || null, overlapPercent: 0 };
    }
    const overlapPercent = calculateSegmentOverlap(turf, batch, existingCoverage);
    const coverage = unionFeatures(turf, [existingCoverage, batch]);
    return {
      batch,
      coverage,
      overlapPercent
    };
  }

  // Bulk-replay har en bevisst balansert union. Den holdes separat fra den
  // ordinære batch-merge-en for å bevare nøyaktig samme geometri og ytelse.
  function mergeCoverageChunksBalanced(turfApi, existingCoverage, chunks) {
    const turf = requireTurf(turfApi);
    const batch = unionFeaturesBalanced(turf, chunks);
    return {
      batch,
      coverage: batch ? unionFeatures(turf, [existingCoverage, batch]) : (existingCoverage || null),
      overlapPercent: 0
    };
  }

  function validMergeResult(result, requiresBatch) {
    if (!result || typeof result !== "object") return false;
    if (requiresBatch && (!result.batch || !result.coverage)) return false;
    return Number.isFinite(Number(result.overlapPercent));
  }

  function errorMessage(error) {
    return String(error && error.message || error || "Ukjent geometrifeil").slice(0, 500);
  }

  class SurveyCoverageEngine {
    constructor(turfApi, options) {
      this.turf = requireTurf(turfApi);
      const source = options || {};
      this.config = Object.assign({}, DEFAULT_CONFIG.coverage, source.config || {});
      this.searchRadiusMeters = Math.max(0.5, finiteNumber(source.searchRadiusMeters, 5));
      this.coverage = source.coverage || null;
      this.uncertainCoverage = source.uncertainCoverage || null;
      this.pendingCoverage = [];
      this.pendingUncertainCoverage = [];
      this.pendingCoverageDistanceMeters = 0;
      this.pendingUncertainCoverageDistanceMeters = 0;
      this.processedPointCount = Math.max(0, finiteNumber(source.processedPointCount, 0));
      this.bulkState = null;
      this.geometryExecutor = typeof source.geometryExecutor === "function"
        ? source.geometryExecutor : null;
      this.lastGeometryFallback = null;
      this._asyncTail = Promise.resolve();
      this._asyncQueued = 0;
    }

    isBulkActive() {
      return this.bulkState != null;
    }

    isAsyncActive() {
      return this._asyncQueued > 0;
    }

    setGeometryExecutor(executor) {
      if (executor != null && typeof executor !== "function") {
        throw new TypeError("geometryExecutor må være en funksjon eller null");
      }
      this.geometryExecutor = executor || null;
      return this;
    }

    whenIdle() {
      return this._asyncTail;
    }

    _resolveGeometryExecutor(executor) {
      return typeof executor === "function" ? executor : this.geometryExecutor;
    }

    _enqueueAsync(task) {
      this._asyncQueued += 1;
      const run = this._asyncTail.then(task);
      const settled = run.then(
        value => {
          this._asyncQueued -= 1;
          return value;
        },
        error => {
          this._asyncQueued -= 1;
          throw error;
        }
      );
      // En feil i én jobb skal nøytraliseres for selve køhalen slik at en
      // senere flush kan forsøke den urørte pending-batchen på nytt.
      this._asyncTail = settled.catch(() => undefined);
      return settled;
    }

    _assertNoAsyncMutation(operation) {
      if (this.isAsyncActive()) {
        throw new Error(`${operation} kan ikke kjøres mens asynkron coverage-geometri pågår`);
      }
    }

    async _executeGeometryJob(operation, existingCoverage, geometries, executor, fallback) {
      const selectedExecutor = this._resolveGeometryExecutor(executor);
      if (!selectedExecutor) {
        return {
          value: fallback(),
          offloaded: false,
          offloadFallback: false,
          offloadError: null
        };
      }
      try {
        const value = await selectedExecutor({
          operation,
          existingCoverage: existingCoverage || null,
          geometries: (geometries || []).slice()
        });
        if (!validMergeResult(value, (geometries || []).length > 0)) {
          throw new Error("Geometri-worker returnerte et ugyldig merge-resultat");
        }
        this.lastGeometryFallback = null;
        return { value, offloaded: true, offloadFallback: false, offloadError: null };
      } catch (executorError) {
        try {
          const value = fallback();
          const message = errorMessage(executorError);
          this.lastGeometryFallback = { operation, message, at: Date.now() };
          return {
            value,
            offloaded: false,
            offloadFallback: true,
            offloadError: message
          };
        } catch (fallbackError) {
          // Pending-geometrien er ennå ikke fjernet. Legg worker-feilen på den
          // autoritative Turf-feilen uten å gjøre delvis commit.
          try { fallbackError.geometryExecutorError = errorMessage(executorError); }
          catch (_) { /* Error-objektet kan i teorien være fryst. */ }
          throw fallbackError;
        }
      }
    }

    // Bulkmodus er laget for stille replay fra SQLite/IndexedDB. Den beholder
    // normal filtrering og geometri, men utsetter historiske unioner til slutt
    // og rapporterer derfor bevisst ingen gamle overlap-varsler.
    _beginBulk(options) {
      if (this.bulkState) throw new Error("SurveyCoverageEngine er allerede i bulkmodus");
      const source = options || {};
      const configuredChunkSize = finiteNumber(
        source.chunkSize,
        finiteNumber(this.config.bulkChunkSize, DEFAULT_CONFIG.coverage.bulkChunkSize)
      );
      this.bulkState = {
        // Turf får aldri en ubegrenset FeatureCollection selv om importerte
        // innstillinger inneholder en urimelig batchstørrelse.
        chunkSize: clamp(Math.floor(configuredChunkSize), 8, 256),
        validChunks: [],
        uncertainChunks: [],
        pointCountAtStart: this.processedPointCount
      };
      return {
        active: true,
        chunkSize: this.bulkState.chunkSize,
        processedPointCount: this.processedPointCount
      };
    }

    beginBulk(options) {
      this._assertNoAsyncMutation("beginBulk");
      return this._beginBulk(options);
    }

    beginBulkAsync(options) {
      return this._enqueueAsync(() => this._beginBulk(options));
    }

    _stageBulkPending(which) {
      if (!this.bulkState) return false;
      const uncertain = which === "uncertain";
      const pendingKey = uncertain ? "pendingUncertainCoverage" : "pendingCoverage";
      const chunksKey = uncertain ? "uncertainChunks" : "validChunks";
      if (!this[pendingKey].length) return false;
      const chunk = unionFeatures(this.turf, this[pendingKey]);
      if (chunk) this.bulkState[chunksKey].push(chunk);
      this[pendingKey] = [];
      return !!chunk;
    }

    _completeBulk(state, validMerge, uncertainMerge, asyncMeta) {
      const validBatch = validMerge.batch;
      const uncertainBatch = uncertainMerge.batch;
      if (validBatch) this.coverage = validMerge.coverage;
      if (uncertainBatch) this.uncertainCoverage = uncertainMerge.coverage;
      this.pendingCoverageDistanceMeters = 0;
      this.pendingUncertainCoverageDistanceMeters = 0;
      this.bulkState = null;

      const result = {
        changed: !!(validBatch || uncertainBatch),
        validChanged: !!validBatch,
        uncertainChanged: !!uncertainBatch,
        flushed: !!(validBatch || uncertainBatch),
        overlapMeasured: false,
        overlapDistanceMeters: 0,
        overlapSuppressed: true,
        processedPointCount: this.processedPointCount,
        processedInBulk: this.processedPointCount - state.pointCountAtStart,
        snapshot: this._createSnapshot(this.coverage, this.uncertainCoverage)
      };
      if (asyncMeta) {
        result.offloaded = !!asyncMeta.offloaded;
        result.offloadFallback = !!asyncMeta.offloadFallback;
        result.offloadError = asyncMeta.offloadError || null;
      }
      return result;
    }

    _endBulkSync() {
      if (!this.bulkState) throw new Error("SurveyCoverageEngine er ikke i bulkmodus");
      this._stageBulkPending("valid");
      this._stageBulkPending("uncertain");
      const state = this.bulkState;
      const validMerge = mergeCoverageChunksBalanced(
        this.turf, this.coverage, state.validChunks
      );
      const uncertainMerge = mergeCoverageChunksBalanced(
        this.turf, this.uncertainCoverage, state.uncertainChunks
      );
      return this._completeBulk(state, validMerge, uncertainMerge, null);
    }

    endBulk() {
      this._assertNoAsyncMutation("endBulk");
      return this._endBulkSync();
    }

    endBulkAsync(executor) {
      const selectedExecutor = this._resolveGeometryExecutor(executor);
      return this._enqueueAsync(async () => {
        if (!this.bulkState) throw new Error("SurveyCoverageEngine er ikke i bulkmodus");
        this._stageBulkPending("valid");
        this._stageBulkPending("uncertain");
        const state = this.bulkState;
        const execute = async (existingCoverage, chunks) => {
          if (!chunks.length) {
            return {
              value: mergeCoverageChunksBalanced(this.turf, existingCoverage, chunks),
              offloaded: false,
              offloadFallback: false,
              offloadError: null
            };
          }
          return this._executeGeometryJob(
            "mergeCoverageChunksBalanced",
            existingCoverage,
            chunks,
            selectedExecutor,
            () => mergeCoverageChunksBalanced(this.turf, existingCoverage, chunks)
          );
        };
        // Resultatene committes samlet. Hvis både worker og lokal fallback
        // feiler, forblir bulkState/chunks urørt og kan forsøkes igjen.
        const valid = await execute(this.coverage, state.validChunks);
        const uncertain = await execute(this.uncertainCoverage, state.uncertainChunks);
        const errors = [valid.offloadError, uncertain.offloadError].filter(Boolean);
        const validHadWork = state.validChunks.length > 0;
        const uncertainHadWork = state.uncertainChunks.length > 0;
        return this._completeBulk(state, valid.value, uncertain.value, {
          offloaded: (validHadWork || uncertainHadWork) &&
            (!validHadWork || valid.offloaded) &&
            (!uncertainHadWork || uncertain.offloaded),
          offloadFallback: valid.offloadFallback || uncertain.offloadFallback,
          offloadError: errors.length ? errors.join(" | ") : null
        });
      });
    }

    _createBufferedGeometry(point, previousPoint) {
      const coordinates = [[point.lng, point.lat]];
      if (previousPoint && previousPoint.accepted && previousPoint.contributes !== false &&
          normalizeActivity(previousPoint.activityMode) !== ACTIVITY.TRANSPORT && !point.breakBefore) {
        coordinates.unshift([previousPoint.lng, previousPoint.lat]);
      }
      const source = coordinates.length === 1
        ? this.turf.point(coordinates[0])
        : this.turf.lineString(coordinates);
      return this.turf.buffer(source, this.searchRadiusMeters / 1000, {
        units: "kilometers",
        steps: this.config.bufferSteps
      });
    }

    _stagePoint(point, previousPoint, overlapReset, resetFlushed) {
      if (!point || !point.accepted || point.contributes === false ||
          normalizeActivity(point.activityMode) === ACTIVITY.TRANSPORT) {
        return { result: {
          changed: false, uncertain: false, overlapPercent: 0,
          overlapMeasured: false, overlapDistanceMeters: 0, overlapReset, flushed: resetFlushed
        } };
      }
      const geometry = this._createBufferedGeometry(point, previousPoint);
      if (!geometry) {
        return { result: {
          changed: false, uncertain: false, overlapPercent: 0,
          overlapMeasured: false, overlapDistanceMeters: 0, overlapReset, flushed: resetFlushed
        } };
      }
      const uncertain = point.quality === QUALITY.POOR ||
        (previousPoint && previousPoint.quality === QUALITY.POOR);
      const pending = uncertain ? this.pendingUncertainCoverage : this.pendingCoverage;
      const distanceKey = uncertain
        ? "pendingUncertainCoverageDistanceMeters"
        : "pendingCoverageDistanceMeters";
      pending.push(geometry);
      if (!point.breakBefore) {
        this[distanceKey] += Math.max(0, finiteNumber(point.distanceMeters, 0));
      }
      if (this.bulkState) {
        const staged = pending.length >= this.bulkState.chunkSize
          ? this._stageBulkPending(uncertain ? "uncertain" : "valid")
          : false;
        return { result: {
          changed: true,
          uncertain,
          overlapPercent: 0,
          overlapMeasured: false,
          overlapDistanceMeters: 0,
          overlapReset,
          overlapSuppressed: true,
          geometry,
          flushed: false,
          staged
        } };
      }
      const batchFlushed = pending.length >= this.config.batchSize;
      return {
        mergeWhich: batchFlushed ? (uncertain ? "uncertain" : "valid") : null,
        overlapDistanceMeters: batchFlushed ? this[distanceKey] : 0,
        result: {
          changed: true, uncertain, overlapPercent: 0,
          overlapMeasured: batchFlushed, overlapDistanceMeters: 0, overlapReset, geometry,
          flushed: resetFlushed || batchFlushed
        }
      };
    }

    _mergeKeys(which) {
      const uncertain = which === "uncertain";
      return {
        coverageKey: uncertain ? "uncertainCoverage" : "coverage",
        pendingKey: uncertain ? "pendingUncertainCoverage" : "pendingCoverage",
        distanceKey: uncertain
          ? "pendingUncertainCoverageDistanceMeters"
          : "pendingCoverageDistanceMeters"
      };
    }

    _commitPendingMerge(keys, merge) {
      this[keys.coverageKey] = merge.coverage;
      this[keys.pendingKey] = [];
      this[keys.distanceKey] = 0;
    }

    _mergePendingSync(which) {
      const keys = this._mergeKeys(which);
      const pending = this[keys.pendingKey];
      if (!pending.length) {
        this[keys.distanceKey] = 0;
        return null;
      }
      const merge = mergeCoverageBatch(this.turf, this[keys.coverageKey], pending);
      this._commitPendingMerge(keys, merge);
      return merge;
    }

    async _mergePendingAsync(which, executor) {
      const keys = this._mergeKeys(which);
      const pendingReference = this[keys.pendingKey];
      if (!pendingReference.length) {
        this[keys.distanceKey] = 0;
        return null;
      }
      const existingCoverage = this[keys.coverageKey];
      const geometries = pendingReference.slice();
      const executed = await this._executeGeometryJob(
        "mergeCoverageBatch",
        existingCoverage,
        geometries,
        executor,
        () => mergeCoverageBatch(this.turf, existingCoverage, geometries)
      );
      // Sync-API-ene er låst mens jobben kjører og async-API-en er
      // serialisert. Denne kontrollen hindrer likevel datatap hvis noen har
      // mutert de offentlige pending-arrayene direkte.
      if (this[keys.pendingKey] !== pendingReference ||
          pendingReference.length !== geometries.length ||
          this[keys.coverageKey] !== existingCoverage) {
        throw new Error("Coverage-state ble endret før asynkron merge kunne committes");
      }
      this._commitPendingMerge(keys, executed.value);
      return executed;
    }

    _finishStagedPoint(staged, merged) {
      if (!staged.mergeWhich) return staged.result;
      const merge = merged && (merged.value || merged);
      staged.result.overlapPercent = merge.overlapPercent;
      staged.result.overlapDistanceMeters = staged.overlapDistanceMeters;
      if (merged && Object.prototype.hasOwnProperty.call(merged, "offloadFallback")) {
        staged.result.offloaded = !!merged.offloaded;
        staged.result.offloadFallback = !!merged.offloadFallback;
        staged.result.offloadError = merged.offloadError || null;
      }
      return staged.result;
    }

    _addPointSync(point, previousPoint) {
      this.processedPointCount += 1;
      const overlapReset = !!(point && point.breakBefore);
      const resetFlushed = overlapReset && !this.bulkState &&
        !!(this.pendingCoverage.length || this.pendingUncertainCoverage.length);
      if (overlapReset) {
        if (this.bulkState) {
          // Bulk brukes ved stille gjenoppretting. Geometrien beholdes, men en
          // overlap-distanse skal aldri krysse et faktisk GPS-/pausebrudd.
          this.pendingCoverageDistanceMeters = 0;
          this.pendingUncertainCoverageDistanceMeters = 0;
        } else {
          this._flushSync();
        }
      }
      const staged = this._stagePoint(point, previousPoint, overlapReset, resetFlushed);
      const merged = staged.mergeWhich ? this._mergePendingSync(staged.mergeWhich) : null;
      return this._finishStagedPoint(staged, merged);
    }

    addPoint(point, previousPoint) {
      this._assertNoAsyncMutation("addPoint");
      return this._addPointSync(point, previousPoint);
    }

    addPointAsync(point, previousPoint, executor) {
      const selectedExecutor = this._resolveGeometryExecutor(executor);
      return this._enqueueAsync(async () => {
        this.processedPointCount += 1;
        const overlapReset = !!(point && point.breakBefore);
        const resetFlushed = overlapReset && !this.bulkState &&
          !!(this.pendingCoverage.length || this.pendingUncertainCoverage.length);
        if (overlapReset) {
          if (this.bulkState) {
            this.pendingCoverageDistanceMeters = 0;
            this.pendingUncertainCoverageDistanceMeters = 0;
          } else {
            await this._flushAsyncInternal(undefined, selectedExecutor);
          }
        }
        const staged = this._stagePoint(point, previousPoint, overlapReset, resetFlushed);
        const merged = staged.mergeWhich
          ? await this._mergePendingAsync(staged.mergeWhich, selectedExecutor)
          : null;
        return this._finishStagedPoint(staged, merged);
      });
    }

    _flushSync(which) {
      if (this.bulkState) {
        if (!which || which === "valid") {
          this._stageBulkPending("valid");
          this.pendingCoverageDistanceMeters = 0;
        }
        if (!which || which === "uncertain") {
          this._stageBulkPending("uncertain");
          this.pendingUncertainCoverageDistanceMeters = 0;
        }
        return this._createSnapshot(this.getCoverage(true), this.getUncertainCoverage(true));
      }
      if (!which || which === "valid") {
        this._mergePendingSync("valid");
      }
      if (!which || which === "uncertain") {
        this._mergePendingSync("uncertain");
      }
      return this._createSnapshot(this.coverage, this.uncertainCoverage);
    }

    flush(which) {
      this._assertNoAsyncMutation("flush");
      return this._flushSync(which);
    }

    async _flushAsyncInternal(which, executor) {
      if (this.bulkState) {
        // Små chunk-unioner beholdes synkrone. Den dyre balanserte
        // sluttunionen kan flyttes ut med endBulkAsync().
        return this._flushSync(which);
      }
      if (!which || which === "valid") await this._mergePendingAsync("valid", executor);
      if (!which || which === "uncertain") await this._mergePendingAsync("uncertain", executor);
      return this._createSnapshot(this.coverage, this.uncertainCoverage);
    }

    flushAsync(which, executor) {
      let selectedWhich = which;
      let selectedExecutor = executor;
      if (typeof selectedWhich === "function") {
        selectedExecutor = selectedWhich;
        selectedWhich = undefined;
      }
      selectedExecutor = this._resolveGeometryExecutor(selectedExecutor);
      return this._enqueueAsync(
        () => this._flushAsyncInternal(selectedWhich, selectedExecutor)
      );
    }

    _createSnapshot(coverage, uncertainCoverage) {
      return {
        coverage,
        uncertainCoverage,
        processedPointCount: this.processedPointCount,
        searchRadiusMeters: this.searchRadiusMeters,
        updatedAt: Date.now()
      };
    }

    getCoverage(includePending) {
      if (includePending !== false && this.bulkState) {
        return unionFeaturesBalanced(this.turf,
          [this.coverage].concat(this.bulkState.validChunks, this.pendingCoverage));
      }
      if (includePending === false || !this.pendingCoverage.length) return this.coverage;
      return unionFeatures(this.turf, [this.coverage].concat(this.pendingCoverage));
    }

    getUncertainCoverage(includePending) {
      if (includePending !== false && this.bulkState) {
        return unionFeaturesBalanced(this.turf,
          [this.uncertainCoverage].concat(
            this.bulkState.uncertainChunks,
            this.pendingUncertainCoverage
          ));
      }
      if (includePending === false || !this.pendingUncertainCoverage.length) return this.uncertainCoverage;
      return unionFeatures(this.turf, [this.uncertainCoverage].concat(this.pendingUncertainCoverage));
    }

    calculateStats(target, exclusions) {
      return coverageStats(this.turf, target, this.getCoverage(true), exclusions);
    }

    findHoles(target, exclusions, currentPosition, options) {
      const stats = this.calculateStats(target, exclusions);
      return findCoverageHoles(this.turf, stats.uncovered, currentPosition,
        Object.assign({}, this.config, options || {}));
    }

    _snapshotSync(flushFirst) {
      if (this.bulkState && flushFirst !== false) {
        this._stageBulkPending("valid");
        this._stageBulkPending("uncertain");
        return this._createSnapshot(this.getCoverage(true), this.getUncertainCoverage(true));
      }
      if (flushFirst !== false) this._flushSync();
      return this._createSnapshot(this.coverage, this.uncertainCoverage);
    }

    snapshot(flushFirst) {
      // Et snapshot brukes som recovery-checkpoint. Det må aldri kunne
      // passere en worker-jobb som ennå ikke er committet.
      this._assertNoAsyncMutation("snapshot");
      return this._snapshotSync(flushFirst);
    }

    snapshotAsync(flushFirst, executor) {
      const selectedExecutor = this._resolveGeometryExecutor(executor);
      return this._enqueueAsync(async () => {
        if (this.bulkState) return this._snapshotSync(flushFirst);
        if (flushFirst !== false) {
          await this._flushAsyncInternal(undefined, selectedExecutor);
        }
        return this._createSnapshot(this.coverage, this.uncertainCoverage);
      });
    }

    async _previewCoverageAsync(which, executor) {
      const keys = this._mergeKeys(which);
      const existingCoverage = this[keys.coverageKey];
      // Preview skal være et øyeblikksbilde, ikke en ny autoritativ batch.
      // Kopier derfor køen før worker-kallet og la både array, distanse og
      // coverage-referanse stå urørt når resultatet kommer tilbake.
      const geometries = this[keys.pendingKey].slice();
      if (!geometries.length) return existingCoverage || null;
      const executed = await this._executeGeometryJob(
        "mergeCoverageBatch",
        existingCoverage,
        geometries,
        executor,
        () => mergeCoverageBatch(this.turf, existingCoverage, geometries)
      );
      return executed.value.coverage;
    }

    // Signatur: viewSnapshotAsync(flushFirst = true, executor?).
    // true gir samme committede semantikk som snapshotAsync(true), mens false
    // lager en eksakt, ikke-committende visning som inkluderer pending geometri.
    viewSnapshotAsync(flushFirst, executor) {
      const shouldFlush = flushFirst !== false;
      const selectedExecutor = this._resolveGeometryExecutor(executor);
      if (this.bulkState) {
        return Promise.reject(new Error(
          "viewSnapshotAsync kan ikke kjøres mens SurveyCoverageEngine er i bulkmodus"
        ));
      }
      return this._enqueueAsync(async () => {
        // beginBulk kan normalt ikke passere _asyncQueued, men behold kontrollen
        // her også slik at kontrakten forblir tydelig ved framtidige endringer.
        if (this.bulkState) {
          throw new Error(
            "viewSnapshotAsync kan ikke kjøres mens SurveyCoverageEngine er i bulkmodus"
          );
        }
        if (shouldFlush) {
          await this._flushAsyncInternal(undefined, selectedExecutor);
          return this._createSnapshot(this.coverage, this.uncertainCoverage);
        }
        const coverage = await this._previewCoverageAsync("valid", selectedExecutor);
        const uncertainCoverage = await this._previewCoverageAsync("uncertain", selectedExecutor);
        return this._createSnapshot(coverage, uncertainCoverage);
      });
    }
  }

  function createSurvey(options) {
    const source = options || {};
    const startedAt = finiteNumber(source.startedAt, Date.now());
    const profile = COVERAGE_PROFILES[source.coverageProfile] || COVERAGE_PROFILES.THOROUGH;
    return {
      id: String(source.id || ("survey-" + startedAt.toString(36))),
      kind: "survey",
      areaId: source.areaId == null ? null : String(source.areaId),
      startedAt,
      endedAt: null,
      status: "ACTIVE",
      searchRadiusMeters: Math.max(0.5, finiteNumber(source.searchRadiusMeters, profile.radiusMeters)),
      coverageProfile: profile.id,
      currentActivity: normalizeActivity(source.currentActivity || ACTIVITY.SEARCHING),
      points: [],
      nativeCursor: 0,
      coverageCache: null,
      statistics: {
        distanceMeters: 0,
        totalAreaSquareMeters: 0,
        coveredAreaSquareMeters: 0,
        remainingAreaSquareMeters: 0,
        coveragePercent: null
      },
      ignoredHoleIds: [],
      pauseMs: 0,
      pauseStartedAt: null
    };
  }

  return Object.freeze({
    ACTIVITY,
    QUALITY,
    COVERAGE_PROFILES,
    DEFAULT_CONFIG,
    LocationQualityFilter,
    SurveyCoverageEngine,
    normalizeActivity,
    normalizeRawSample,
    classifyAccuracy,
    haversineMeters,
    bearingDegrees,
    polygonFromLatLngs,
    effectiveTargetGeometry,
    coverageStats,
    findCoverageHoles,
    deriveCoverageGeometry,
    calculateSegmentOverlap,
    mergeCoverageBatch,
    mergeCoverageChunksBalanced,
    createSurvey
  });
});
