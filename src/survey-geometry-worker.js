/* Lyng Survey geometry worker
 *
 * Klassisk Worker slik at samme fil virker direkte fra Capacitor/WebView uten
 * en modul-bundler. All geometri utføres av de rene funksjonene i survey-core.
 */
"use strict";

importScripts("vendor/turf.min.js", "survey-core.js");

const core = self.LyngSurveyCore;
const turfApi = self.turf;

if (!core || !turfApi) {
  throw new Error("Survey geometry worker kunne ikke laste Turf/survey-core");
}

function serializeError(error) {
  return {
    name: String(error && error.name || "Error").slice(0, 100),
    message: String(error && error.message || error || "Ukjent geometrifeil").slice(0, 500)
  };
}

self.onmessage = event => {
  const message = event && event.data || {};
  const requestId = message.requestId;
  try {
    let result;
    if (message.operation === "mergeCoverageBatch") {
      result = core.mergeCoverageBatch(
        turfApi,
        message.existingCoverage || null,
        Array.isArray(message.geometries) ? message.geometries : []
      );
    } else if (message.operation === "mergeCoverageChunksBalanced") {
      result = core.mergeCoverageChunksBalanced(
        turfApi,
        message.existingCoverage || null,
        Array.isArray(message.geometries) ? message.geometries : []
      );
    } else if (message.operation === "deriveCoverageGeometry") {
      result = core.deriveCoverageGeometry(
        turfApi,
        message.target || null,
        message.coverage || null,
        Array.isArray(message.exclusions) ? message.exclusions : [],
        message.currentPosition || null,
        message.options || {}
      );
    } else {
      throw new Error(`Ukjent survey-geometrioperasjon: ${String(message.operation || "")}`);
    }
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: serializeError(error) });
  }
};
