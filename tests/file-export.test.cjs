"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { saveFile, safeFileName, buildGpx } = require("../src/file-export.js");

test("Android-eksport skriver UTF-8 til cache og åpner delingsmenyen", async () => {
  const calls = [];
  const capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: name => name === "Filesystem" || name === "Share",
    Plugins: {
      Filesystem: {
        writeFile: async options => {
          calls.push({ plugin: "Filesystem", method: "writeFile", options });
          return { uri: "file:///cache/lyng-eksport/tur.gpx" };
        }
      },
      Share: {
        share: async options => {
          calls.push({ plugin: "Share", method: "share", options });
          return {};
        }
      }
    }
  };

  const result = await saveFile({
    capacitor,
    name: "tur.gpx",
    content: "æøå",
    type: "application/gpx+xml",
    title: "Lyng GPX",
    dialogTitle: "Lagre eller del GPX"
  });

  assert.equal(result.method, "native-share");
  assert.deepEqual(calls[0], {
    plugin: "Filesystem",
    method: "writeFile",
    options: {
      path: "lyng-eksport/tur.gpx",
      data: "æøå",
      directory: "CACHE",
      encoding: "utf8",
      recursive: true
    }
  });
  assert.deepEqual(calls[1], {
    plugin: "Share",
    method: "share",
    options: {
      title: "Lyng GPX",
      dialogTitle: "Lagre eller del GPX",
      files: ["file:///cache/lyng-eksport/tur.gpx"]
    }
  });
});

test("Android-eksport kan bruke Capacitors nativePromise-bro", async () => {
  const calls = [];
  const capacitor = {
    isNativePlatform: () => true,
    nativePromise: async (plugin, method, options) => {
      calls.push({ plugin, method, options });
      if (plugin === "Filesystem" && method === "writeFile") return {};
      if (plugin === "Filesystem" && method === "getUri") return { uri: "file:///cache/backup.json" };
      return {};
    }
  };

  const result = await saveFile({ capacitor, name: "backup.json", content: "{}" });
  assert.equal(result.uri, "file:///cache/backup.json");
  assert.deepEqual(calls.map(call => `${call.plugin}.${call.method}`), [
    "Filesystem.writeFile", "Filesystem.getUri", "Share.share"
  ]);
});

test("Android-eksport feiler tydelig når et native tillegg mangler", async () => {
  const capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: name => name === "Filesystem",
    Plugins: {}
  };
  await assert.rejects(
    () => saveFile({ capacitor, name: "backup.json", content: "{}" }),
    /Share-tillegget mangler/
  );
});

test("nettleser-eksport beholder download-fallback og rydder objekt-URL", async () => {
  const events = [];
  const anchor = {
    style: {},
    click: () => events.push("click"),
    remove: () => events.push("remove")
  };
  const documentRef = {
    createElement: tag => {
      assert.equal(tag, "a");
      return anchor;
    },
    body: { appendChild: node => events.push(node === anchor ? "append" : "wrong") }
  };
  const urlApi = {
    createObjectURL: blob => {
      assert.equal(blob.type, "application/json");
      return "blob:test";
    },
    revokeObjectURL: value => events.push(`revoke:${value}`)
  };

  const result = await saveFile({
    name: "backup.json",
    content: "{}",
    type: "application/json",
    document: documentRef,
    urlApi,
    BlobCtor: Blob,
    setTimeoutFn: callback => callback()
  });

  assert.equal(result.method, "browser-download");
  assert.equal(anchor.download, "backup.json");
  assert.equal(anchor.href, "blob:test");
  assert.deepEqual(events, ["append", "click", "revoke:blob:test", "remove"]);
});

test("filnavn kan ikke lage mapper eller bruke ugyldige tegn", () => {
  assert.equal(safeFileName("../lyng:backup?.json"), "-lyng-backup-.json");
});

test("GPX bevarer pauser som separate segmenter og tåler gamle tidsstempler", () => {
  const xml = buildGpx({
    creator: "Lyng 3.4",
    waypoints: [{
      lat: 59.9, lon: 10.7, time: "ugyldig", name: "Bær & sopp", description: "<funn>"
    }],
    tracks: [{
      name: "Lyng 31.08.2026",
      points: [
        { lat: 59.9, lon: 10.7, time: 1_788_000_000_000 },
        { lat: 59.91, lon: 10.71, time: 1_788_000_010_000 },
        { lat: 59.92, lon: 10.72, time: null, breakBefore: true }
      ]
    }]
  });

  assert.equal((xml.match(/<trkseg>/g) || []).length, 2);
  assert.equal((xml.match(/<trkpt /g) || []).length, 3);
  assert.doesNotMatch(xml, /Invalid Date|ugyldig/);
  assert.match(xml, /Bær &amp; sopp/);
  assert.match(xml, /&lt;funn&gt;/);
});

test("GPX forkaster ugyldige koordinater uten å koble spor over dem", () => {
  const xml = buildGpx({ tracks: [{
    name: "Test",
    points: [
      { lat: 59, lon: 10 },
      { lat: null, lon: 10 },
      { lat: 60, lon: 11 }
    ]
  }] });
  assert.equal((xml.match(/<trkseg>/g) || []).length, 2);
  assert.equal((xml.match(/<trkpt /g) || []).length, 2);
});
