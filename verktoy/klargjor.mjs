/* Kjøres i GitHub Actions etter «npx cap add android».
   Setter varseltekst, ikon og versjonsnummer på Android-prosjektet. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const RES = "android/app/src/main/res";
const bygg = process.env.BYGG || "1";
const pakkeVersjon = JSON.parse(readFileSync("package.json", "utf8")).version;
const versjonsserie = pakkeVersjon.split(".").slice(0, 2).join(".");

/* 1. Strenger som bakgrunnstjenesten leser */
const strSti = `${RES}/values/strings.xml`;
let str = readFileSync(strSti, "utf8");
if (!str.includes("capacitor_background_geolocation_notification_icon")) {
  str = str.replace("</resources>",
`    <string name="capacitor_background_geolocation_notification_channel_name">Sporing i bakgrunnen</string>
    <string name="capacitor_background_geolocation_notification_icon">drawable/ic_lyng</string>
    <string name="capacitor_background_geolocation_notification_color">#3A4A80</string>
</resources>`);
  writeFileSync(strSti, str);
  console.log("strings.xml oppdatert");
}

/* 2. Varselikon. Må være hvitt på gjennomsiktig — ellers blir varselet
      mulig å sveipe bort, og sporingen kan stoppe. */
mkdirSync(`${RES}/drawable`, { recursive: true });
writeFileSync(`${RES}/drawable/ic_lyng.xml`,
`<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M11,2 L13,2 L13,7 L11,7 Z"/>
  <path android:fillColor="#FFFFFFFF" android:pathData="M12,14 m-7,0 a7,7 0 1,0 14,0 a7,7 0 1,0 -14,0"/>
</vector>
`);
console.log("ic_lyng.xml skrevet");

/* 3. Versjon, så du ser hvilket bygg som ligger på telefonen */
const gSti = "android/app/build.gradle";
let g = readFileSync(gSti, "utf8");
const forKode = g.match(/versionCode\s+\d+/);
const forNavn = g.match(/versionName\s+"[^"]*"/);
g = g.replace(/versionCode\s+\d+/, `versionCode ${bygg}`);
g = g.replace(/versionName\s+"[^"]*"/, `versionName "${versjonsserie}.${bygg}"`);
writeFileSync(gSti, g);
console.log(`versjon: ${forKode?.[0]} -> versionCode ${bygg}, ${forNavn?.[0]} -> "${versjonsserie}.${bygg}"`);
