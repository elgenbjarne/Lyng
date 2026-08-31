import { readFile } from "node:fs/promises";

for (const file of ["package.json", "capacitor.config.json"]) {
  JSON.parse(await readFile(file, "utf8"));
}

const html = await readFile("lyng.html", "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const [index, source] of scripts.entries()) {
  try {
    // Syntakssjekk uten å kjøre nettleserkoden.
    new Function(source);
  } catch (error) {
    throw new Error(`Inline-script ${index + 1} kompilerer ikke: ${error.message}`);
  }
}

const externalScripts = ["src/file-export.js", "src/survey-core.js", "src/survey-geometry-worker.js"];
for (const file of externalScripts) {
  try {
    new Function(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} kompilerer ikke: ${error.message}`);
  }
}

console.log(`${scripts.length} inline-script, ${externalScripts.length} eksterne script og 2 JSON-filer er syntaktisk gyldige`);
