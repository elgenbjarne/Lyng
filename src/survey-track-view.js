/* Bounded, transient map representation of a complete Survey track. */
(function exposeSurveyTrackView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyngSurveyTrackView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSurveyTrackViewApi() {
  "use strict";

  const DEFAULT_MAX_POINTS = 2400;

  function emptyView() {
    return {
      surveyId: null,
      source: null,
      sourceCount: 0,
      segments: [],
      pointCount: 0,
      dirty: 0
    };
  }

  function compactSegments(input, maximum) {
    const limit = Math.max(2, Number(maximum) || DEFAULT_MAX_POINTS);
    let segments = (input || [])
      .filter(segment => Array.isArray(segment) && segment.length)
      .map(segment => segment.slice());
    let count = segments.reduce((sum, segment) => sum + segment.length, 0);

    while (count > limit) {
      let changed = false;
      segments = segments.map(segment => {
        if (segment.length <= 2) return segment;
        changed = true;
        const reduced = [segment[0]];
        for (let i = 2; i < segment.length - 1; i += 2) reduced.push(segment[i]);
        reduced.push(segment[segment.length - 1]);
        return reduced;
      });
      count = segments.reduce((sum, segment) => sum + segment.length, 0);
      if (!changed) break;
    }

    // Do not join across a break. With pathologically many two-point segments,
    // discard complete oldest render segments while retaining the raw source.
    while (count > limit && segments.length > 1) count -= segments.shift().length;
    if (count > limit && segments.length === 1) {
      const segment = segments[0];
      const stride = Math.ceil((segment.length - 1) / Math.max(1, limit - 1));
      const reduced = [segment[0]];
      for (let i = stride; i < segment.length - 1; i += stride) reduced.push(segment[i]);
      if (segment.length > 1) reduced.push(segment[segment.length - 1]);
      if (reduced.length > limit) {
        segments[0] = reduced.slice(0, limit - 1).concat([reduced[reduced.length - 1]]);
      } else {
        segments[0] = reduced;
      }
      count = segments[0].length;
    }
    return { segments, pointCount: count };
  }

  function build(survey, maximum) {
    const segments = [];
    let segment = [];
    for (const point of (survey && survey.spor) || []) {
      if (!Array.isArray(point) || point.length < 2) continue;
      if (point[5] && segment.length) {
        segments.push(segment);
        segment = [];
      }
      segment.push([point[0], point[1]]);
    }
    if (segment.length) segments.push(segment);
    const compacted = compactSegments(segments, maximum);
    return {
      surveyId: survey ? survey.id : null,
      source: survey && survey.spor,
      sourceCount: survey && Array.isArray(survey.spor) ? survey.spor.length : 0,
      segments: compacted.segments,
      pointCount: compacted.pointCount,
      dirty: 0
    };
  }

  function aligned(view, survey, beforeLastAppend) {
    const expected = Math.max(0, ((survey && survey.spor) || []).length - (beforeLastAppend ? 1 : 0));
    return !!view && !!survey && view.surveyId === survey.id && view.source === survey.spor &&
      view.sourceCount === expected;
  }

  function append(view, survey, point, maximum) {
    if (!survey || !Array.isArray(point) || point.length < 2) {
      return { view: view || emptyView(), rebuilt: false };
    }
    if (!aligned(view, survey, true)) return { view: build(survey, maximum), rebuilt: true };

    const coordinate = [point[0], point[1]];
    if (point[5] || !view.segments.length) view.segments.push([coordinate]);
    else view.segments[view.segments.length - 1].push(coordinate);
    view.sourceCount = survey.spor.length;
    view.pointCount += 1;
    view.dirty += 1;
    if (view.pointCount > Math.max(2, Number(maximum) || DEFAULT_MAX_POINTS)) {
      const compacted = compactSegments(view.segments, maximum);
      view.segments = compacted.segments;
      view.pointCount = compacted.pointCount;
    }
    return { view, rebuilt: false };
  }

  function renderableSegments(view) {
    return ((view && view.segments) || []).filter(segment => segment.length >= 2);
  }

  return Object.freeze({
    DEFAULT_MAX_POINTS,
    emptyView,
    compactSegments,
    build,
    aligned,
    append,
    renderableSegments
  });
});
