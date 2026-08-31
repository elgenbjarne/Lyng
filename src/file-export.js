/* Fil-eksport som virker både i Capacitor-appen og i en vanlig nettleser. */
(function exposeFileExport(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyngFileExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFileExportApi() {
  "use strict";

  function safeFileName(value) {
    const cleaned = String(value || "lyng-eksport")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/^\.+/, "")
      .trim();
    return cleaned || "lyng-eksport";
  }

  function escapeXml(value) {
    return String(value == null ? "" : value).replace(/[<>&"']/g, character => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
    }[character]));
  }

  function isoTime(value) {
    if (value == null || value === "") return "";
    const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }

  function validCoordinate(value, minimum, maximum) {
    if (value == null || value === "") return false;
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum;
  }

  function splitTrack(points) {
    const segments = [];
    let segment = [];
    const finish = () => {
      if (segment.length) segments.push(segment);
      segment = [];
    };
    for (const point of (points || [])) {
      if (point && point.breakBefore) finish();
      if (!point || !validCoordinate(point.lat, -90, 90) || !validCoordinate(point.lon, -180, 180)) {
        finish();
        continue;
      }
      segment.push(point);
    }
    finish();
    return segments;
  }

  function buildGpx(options) {
    const config = options || {};
    const waypointXml = (config.waypoints || [])
      .filter(point => point && validCoordinate(point.lat, -90, 90) && validCoordinate(point.lon, -180, 180))
      .map(point => {
        const time = isoTime(point.time);
        return `  <wpt lat="${Number(point.lat)}" lon="${Number(point.lon)}">` +
          `${time ? `<time>${time}</time>` : ""}<name>${escapeXml(point.name)}</name>` +
          `<desc>${escapeXml(point.description)}</desc></wpt>`;
      })
      .join("\n");
    const trackXml = (config.tracks || []).map(track => {
      const segments = splitTrack(track && track.points);
      if (!segments.length) return "";
      const segmentsXml = segments.map(points => {
        const pointsXml = points.map(point => {
          const time = isoTime(point.time);
          return `      <trkpt lat="${Number(point.lat)}" lon="${Number(point.lon)}">` +
            `${time ? `<time>${time}</time>` : ""}</trkpt>`;
        }).join("\n");
        return `    <trkseg>\n${pointsXml}\n    </trkseg>`;
      }).join("\n");
      return `  <trk><name>${escapeXml(track && track.name)}</name>\n${segmentsXml}\n  </trk>`;
    }).filter(Boolean).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="${escapeXml(config.creator || "Lyng")}" ` +
      `xmlns="http://www.topografix.com/GPX/1/1">\n${waypointXml}\n${trackXml}\n</gpx>`;
  }

  function isNative(capacitor) {
    if (!capacitor) return false;
    if (typeof capacitor.isNativePlatform === "function") {
      return !!capacitor.isNativePlatform();
    }
    return typeof capacitor.nativePromise === "function";
  }

  function hasPlugin(capacitor, name) {
    if (!capacitor) return false;
    if (typeof capacitor.isPluginAvailable === "function") {
      return !!capacitor.isPluginAvailable(name);
    }
    return !!(capacitor.Plugins && capacitor.Plugins[name]) ||
      typeof capacitor.nativePromise === "function";
  }

  async function callPlugin(capacitor, pluginName, method, options) {
    const plugin = capacitor && capacitor.Plugins && capacitor.Plugins[pluginName];
    if (plugin && typeof plugin[method] === "function") {
      return plugin[method](options || {});
    }
    if (capacitor && typeof capacitor.nativePromise === "function") {
      return capacitor.nativePromise(pluginName, method, options || {});
    }
    throw new Error(`${pluginName}.${method} er ikke tilgjengelig`);
  }

  async function saveNative(options, name) {
    const capacitor = options.capacitor;
    for (const pluginName of ["Filesystem", "Share"]) {
      if (!hasPlugin(capacitor, pluginName)) {
        throw new Error(`${pluginName}-tillegget mangler i Android-bygget`);
      }
    }

    const path = `lyng-eksport/${name}`;
    const written = await callPlugin(capacitor, "Filesystem", "writeFile", {
      path,
      data: String(options.content == null ? "" : options.content),
      directory: "CACHE",
      encoding: "utf8",
      recursive: true
    });
    let uri = written && written.uri;
    if (!uri) {
      const resolved = await callPlugin(capacitor, "Filesystem", "getUri", {
        path,
        directory: "CACHE"
      });
      uri = resolved && resolved.uri;
    }
    if (!uri) throw new Error("Android returnerte ingen filadresse");

    await callPlugin(capacitor, "Share", "share", {
      title: options.title || name,
      dialogTitle: options.dialogTitle || "Lagre eller del filen",
      files: [uri]
    });
    return { method: "native-share", name, uri };
  }

  function saveBrowser(options, name) {
    const documentRef = options.document;
    const urlApi = options.urlApi;
    const BlobCtor = options.BlobCtor;
    if (!documentRef || !urlApi || !BlobCtor) {
      throw new Error("Nettleseren støtter ikke filnedlasting");
    }

    const anchor = documentRef.createElement("a");
    const objectUrl = urlApi.createObjectURL(new BlobCtor(
      [String(options.content == null ? "" : options.content)],
      { type: options.type || "application/octet-stream" }
    ));
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.style.display = "none";
    documentRef.body.appendChild(anchor);
    anchor.click();
    const later = options.setTimeoutFn || setTimeout;
    later(() => {
      urlApi.revokeObjectURL(objectUrl);
      anchor.remove();
    }, 4000);
    return { method: "browser-download", name, uri: objectUrl };
  }

  async function saveFile(options) {
    if (!options || typeof options !== "object") throw new TypeError("Eksportalternativer mangler");
    const name = safeFileName(options.name);
    if (isNative(options.capacitor)) return saveNative(options, name);
    return saveBrowser(options, name);
  }

  return { saveFile, safeFileName, isNative, callPlugin, buildGpx, isoTime, splitTrack };
});
