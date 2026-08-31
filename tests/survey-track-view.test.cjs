"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TRACK = require("../src/survey-track-view.js");

function point(index, breakBefore) {
  return [60 + index / 1_000_000, 10 + index / 1_000_000, index, "gaa", 4,
    breakBefore ? 1 : undefined];
}

test("10 000 råpunkter beholdes mens Survey-visningen er hardt begrenset", () => {
  const survey = { id: "long", spor: [] };
  for (let i = 0; i < 10_000; i += 1) {
    survey.spor.push(point(i, i === 3333 || i === 6666));
  }
  const rawBefore = JSON.stringify(survey.spor);
  const view = TRACK.build(survey, 2400);

  assert.equal(survey.spor.length, 10_000);
  assert.equal(JSON.stringify(survey.spor), rawBefore, "renderbufferen skal aldri endre råsporet");
  assert.ok(view.pointCount <= 2400);
  assert.equal(view.segments.length, 3);
  assert.deepEqual(view.segments[0][0], survey.spor[0].slice(0, 2));
  assert.deepEqual(view.segments[0].at(-1), survey.spor[3332].slice(0, 2));
  assert.deepEqual(view.segments[1][0], survey.spor[3333].slice(0, 2));
  assert.deepEqual(view.segments[1].at(-1), survey.spor[6665].slice(0, 2));
  assert.deepEqual(view.segments[2].at(-1), survey.spor[9999].slice(0, 2));
});

test("append er inkrementell, batchtelleren øker og brudd lager aldri falsk linje", () => {
  const survey = { id: "live", spor: [point(0), point(1)] };
  let view = TRACK.build(survey, 100);

  for (let i = 2; i < 8; i += 1) {
    const next = point(i);
    survey.spor.push(next);
    const result = TRACK.append(view, survey, next, 100);
    assert.equal(result.rebuilt, false);
    view = result.view;
  }
  assert.equal(view.dirty, 6, "UI kan rendre én gang per seks append-operasjoner");

  const broken = point(8, true);
  survey.spor.push(broken);
  ({ view } = TRACK.append(view, survey, broken, 100));
  assert.equal(view.segments.at(-1).length, 1);
  assert.equal(TRACK.renderableSegments(view).length, 1,
    "ettpunktshalen etter brudd skal ikke kobles til forrige segment");

  const afterBreak = point(9);
  survey.spor.push(afterBreak);
  ({ view } = TRACK.append(view, survey, afterBreak, 100));
  assert.deepEqual(view.segments.at(-1), [broken.slice(0, 2), afterBreak.slice(0, 2)]);
});

test("out-of-band endring gir én rebuild og mange korte segmenter forblir adskilt", () => {
  const survey = { id: "bulk", spor: [point(0), point(1)] };
  const oldView = TRACK.build(survey, 100);
  survey.spor.push(point(2), point(3), point(4));
  const rebuilt = TRACK.append(oldView, survey, survey.spor.at(-1), 100);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.view.sourceCount, survey.spor.length);

  const shortSegments = [];
  for (let i = 0; i < 400; i += 1) {
    shortSegments.push([[i, 0], [i, 1]]);
  }
  const compacted = TRACK.compactSegments(shortSegments, 100);
  assert.ok(compacted.pointCount <= 100);
  assert.ok(compacted.segments.every(segment => segment.length === 2));
});

test("gjentatte små native-batcher etter 10 000 punkt krever ingen full rebuild", () => {
  const survey = { id: "native-live", spor: [] };
  for (let i = 0; i < 10_000; i += 1) survey.spor.push(point(i));
  let view = TRACK.build(survey, 2400);

  for (let i = 10_000; i < 10_100; i += 1) {
    const next = point(i);
    survey.spor.push(next);
    const result = TRACK.append(view, survey, next, 2400);
    assert.equal(result.rebuilt, false);
    view = result.view;
  }
  assert.equal(view.sourceCount, 10_100);
  assert.ok(view.pointCount <= 2400);
});
