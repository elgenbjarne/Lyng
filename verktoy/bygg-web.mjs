import { cp, copyFile, mkdir } from "node:fs/promises";

async function copy(source, destination) {
  await mkdir(destination.substring(0, Math.max(destination.lastIndexOf("/"), destination.lastIndexOf("\\"))), { recursive: true });
  await copyFile(source, destination);
}

await mkdir("www/vendor", { recursive: true });
await copy("lyng.html", "www/index.html");
await copy("src/file-export.js", "www/file-export.js");
await copy("src/survey-core.js", "www/survey-core.js");
await copy("src/survey-geometry-worker.js", "www/survey-geometry-worker.js");
await copy("src/survey-storage.js", "www/survey-storage.js");
await copy("src/survey-track-view.js", "www/survey-track-view.js");
await copy("node_modules/leaflet/dist/leaflet.js", "www/vendor/leaflet.js");
await copy("node_modules/leaflet/dist/leaflet.css", "www/vendor/leaflet.css");
await copy("node_modules/@turf/turf/turf.min.js", "www/vendor/turf.min.js");
await cp("node_modules/leaflet/dist/images", "www/vendor/images", { recursive: true, force: true });

for (const font of ["figtree", "caprasimo"]) {
  await mkdir(`www/vendor/${font}`, { recursive: true });
  await cp(`node_modules/@fontsource/${font}/files`, `www/vendor/${font}/files`, { recursive: true, force: true });
  await copy(`node_modules/@fontsource/${font}/index.css`, `www/vendor/${font}/index.css`);
}

console.log("Web-appen er klargjort i www/");
