/* Append-only lagring for rå survey-posisjoner.
 * Android bruker SurveyLocation-pluginens SQLite-database. Nettleseren bruker
 * IndexedDB, slik at hovedstate ikke må serialiseres på nytt for hvert punkt.
 */
(function exposeSurveyStorage(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyngSurveyStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStorageApi(root) {
  "use strict";

  const DATABASE_NAME = "lyng-survey-v1";
  const STORE_NAME = "locationSamples";

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB-feil"));
    });
  }

  function transactionResult(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB-transaksjonen feilet"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB-transaksjonen ble avbrutt"));
    });
  }

  class IndexedDbSurveyStore {
    constructor(indexedDb) {
      this.indexedDb = indexedDb || (root && root.indexedDB);
      this.databasePromise = null;
      this.kind = "indexeddb";
    }

    open() {
      if (!this.indexedDb) return Promise.reject(new Error("IndexedDB er ikke tilgjengelig"));
      if (this.databasePromise) return this.databasePromise;
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          const store = database.objectStoreNames.contains(STORE_NAME)
            ? request.transaction.objectStore(STORE_NAME)
            : database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          if (!store.indexNames.contains("surveyAndId")) {
            store.createIndex("surveyAndId", ["surveyId", "id"], { unique: false });
          }
          if (!store.indexNames.contains("timestamp")) {
            store.createIndex("timestamp", "timestamp", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Kunne ikke åpne survey-databasen"));
      });
      return this.databasePromise;
    }

    async append(sample) {
      const database = await this.open();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const committed = transactionResult(transaction);
      // Attach a rejection handler immediately. A synchronous request error or
      // an early request rejection must not leave the transaction promise as an
      // unhandled rejection while the caller receives the original error.
      committed.catch(() => {});
      const stored = Object.assign({}, sample);
      if (stored.id == null) delete stored.id;
      const request = transaction.objectStore(STORE_NAME).add(stored);
      const [id] = await Promise.all([requestResult(request), committed]);
      return Object.assign(stored, { id });
    }

    async list(surveyId, afterId, limit) {
      const database = await this.open();
      const transaction = database.transaction(STORE_NAME, "readonly");
      const index = transaction.objectStore(STORE_NAME).index("surveyAndId");
      const lower = [String(surveyId), Math.max(0, Number(afterId) || 0)];
      const upper = [String(surveyId), Number.MAX_SAFE_INTEGER];
      const range = IDBKeyRange.bound(lower, upper, true, false);
      const maximum = Math.max(1, Math.min(5000, Number(limit) || 1000));
      return new Promise((resolve, reject) => {
        const result = [];
        const request = index.openCursor(range, "next");
        request.onerror = () => reject(request.error || new Error("Kunne ikke lese GPS-punkter"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length >= maximum) {
            resolve(result);
            return;
          }
          result.push(cursor.value);
          cursor.continue();
        };
      });
    }

    async deleteSurvey(surveyId) {
      const database = await this.open();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const committed = transactionResult(transaction);
      committed.catch(() => {});
      const index = transaction.objectStore(STORE_NAME).index("surveyAndId");
      const range = IDBKeyRange.bound(
        [String(surveyId), 0],
        [String(surveyId), Number.MAX_SAFE_INTEGER]
      );
      const deleted = new Promise((resolve, reject) => {
        const request = index.openKeyCursor(range);
        request.onerror = () => reject(request.error || new Error("Kunne ikke slette GPS-punkter"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          transaction.objectStore(STORE_NAME).delete(cursor.primaryKey);
          cursor.continue();
        };
      });
      await Promise.all([deleted, committed]);
    }

    deleteSamples(surveyId) {
      return this.deleteSurvey(surveyId);
    }

    async getState() {
      return { available: true, native: false, status: "WEB" };
    }

    async listSessions() { return []; }
  }

  class NativeSurveyStore {
    constructor(capacitor) {
      this.capacitor = capacitor;
      this.plugin = capacitor && capacitor.Plugins && capacitor.Plugins.SurveyLocation;
      this.kind = "native-sqlite";
    }

    call(method, args) {
      const payload = args || {};
      if (this.plugin && typeof this.plugin[method] === "function") {
        return Promise.resolve(this.plugin[method](payload));
      }
      if (this.capacitor && typeof this.capacitor.nativePromise === "function") {
        return Promise.resolve(this.capacitor.nativePromise("SurveyLocation", method, payload));
      }
      return Promise.reject(new Error("SurveyLocation-pluginen er ikke tilgjengelig"));
    }

    async start(options) {
      await this.call("requestPermissions", {});
      return this.call("start", {
        sessionId: String(options.surveyId),
        activity: options.activityMode,
        intervalMs: options.intervalMs,
        minDistanceMeters: options.minimumDistanceMeters,
        goodAccuracyMeters: options.goodAccuracyMeters,
        acceptableAccuracyMeters: options.acceptableAccuracyMeters,
        poorAccuracyMeters: options.poorAccuracyMeters,
        maxOnFootSpeedMetersPerSecond: options.maxOnFootSpeedMetersPerSecond,
        maxTransportSpeedMetersPerSecond: options.maxTransportSpeedMetersPerSecond
      });
    }
    pause(options) { return this.call("pause", { sessionId: String(options.surveyId) }); }
    resume(options) { return this.call("resume", { sessionId: String(options.surveyId) }); }
    stop(options) { return this.call("stop", { sessionId: String(options.surveyId) }); }
    setActivity(options) {
      return this.call("setActivity", {
        sessionId: String(options.surveyId), activity: options.activityMode
      });
    }
    getState(options) {
      return this.call("getState", options && options.surveyId != null
        ? { sessionId: String(options.surveyId) }
        : {});
    }
    async listSessions() {
      const response = await this.call("getSessions", {});
      return response && Array.isArray(response.sessions) ? response.sessions : [];
    }

    async list(surveyId, afterId, limit) {
      const response = await this.call("getSamples", {
        sessionId: String(surveyId),
        afterSequence: Math.max(0, Number(afterId) || 0),
        limit: Math.max(1, Math.min(5000, Number(limit) || 1000))
      });
      return response && Array.isArray(response.samples) ? response.samples.map(sample => ({
        id: sample.sequence,
        surveyId: sample.sessionId,
        timestamp: sample.recordedAt,
        elapsedRealtimeNanos: sample.elapsedRealtimeNanos,
        bootId: sample.bootId,
        latitude: sample.latitude,
        longitude: sample.longitude,
        accuracy: sample.accuracy,
        altitude: sample.altitude,
        speed: sample.speed,
        heading: sample.heading,
        activityMode: sample.activity,
        quality: sample.quality,
        accepted: sample.accepted,
        rejectionReason: sample.rejectionReason,
        source: sample.provider || "ANDROID_LOCATION_MANAGER",
        mock: !!sample.mock
      })) : [];
    }

    append() {
      return Promise.reject(new Error("Native samples skrives av foreground-tjenesten"));
    }

    deleteSamples(surveyId) {
      return this.call("deleteSamples", { sessionId: String(surveyId), confirm: true });
    }
    deleteSurvey(surveyId) {
      return this.call("deleteSession", { sessionId: String(surveyId), confirm: true });
    }
  }

  function nativePluginAvailable(capacitor) {
    return !!(capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform() &&
      capacitor.isPluginAvailable && capacitor.isPluginAvailable("SurveyLocation"));
  }

  function createSurveyStore(options) {
    const source = options || {};
    const capacitor = source.capacitor || (root && root.Capacitor);
    if (!source.forceWeb && nativePluginAvailable(capacitor)) return new NativeSurveyStore(capacitor);
    return new IndexedDbSurveyStore(source.indexedDB || (root && root.indexedDB));
  }

  return Object.freeze({
    DATABASE_NAME,
    STORE_NAME,
    IndexedDbSurveyStore,
    NativeSurveyStore,
    nativePluginAvailable,
    createSurveyStore
  });
});
