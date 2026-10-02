/**
 * The app's configuration (issue #168).
 *
 * Two things here are decided at build time and never at run time, and both
 * are deliberate.
 *
 * **Which machine serves updates.** `EXPO_PUBLIC_COVEY_UPDATES_URL` names it, and
 * the URL is baked into the binary.

 * The name is not decoration. Expo loads `.env` for every one of its commands
 * and inlines an `EXPO_PUBLIC_` variable into the bundle, so this file and
 * `src/ota.ts` read *one* value from *one* place. The first APK built here got
 * that wrong: the variable was set for `expo prebuild`, which wrote the URL into
 * `AndroidManifest.xml`, and not for the gradle build, which wrote
 * `assets/app.config` from this file — so the binary carried a native layer that
 * would update and a JavaScript layer that reported it could not. One variable
 * loaded from a file cannot disagree with itself. A daemon that serves updates serves the JavaScript
 * this app runs, so that trust is named once, by the person who builds the
 * app, and is never inferred from a fleet list. The alternative — Expo's
 * `setUpdateURLAndRequestHeadersOverride` — needs
 * `updates.disableAntiBrickingMeasures`, which gives up the one measure that
 * lets a later update repair a broken one: a bad bundle would then need an
 * uninstall to recover, and an update that rewrites the update URL could take
 * the installation over. covey keeps the measure and rebuilds instead.
 *
 * **The token is not baked in.** It is a secret, and a binary is not a place
 * for one. `updates.requestHeaders` only declares the header, with no value;
 * `src/ota.ts` fills it at run time from the device's keychain through
 * `Updates.setUpdateRequestHeadersOverride`, which needs no such flag. Expo
 * requires the header be declared at build time to be overridable at run time,
 * which is why the empty declaration is here rather than absent.
 *
 * With no `EXPO_PUBLIC_COVEY_UPDATES_URL` the updates module is off and the app runs
 * whatever bundle it was built with. That is the development case, and it must
 * keep working on a machine that has never seen a certificate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";

/**
 * The version the runtime is keyed on. An update must match the app it lands in.
 *
 * `0.2.0` was `expo-speech-recognition`; `0.3.0` is `react-native-ble-plx`, for
 * the device (#178); `0.4.0` is `modules/covey-link`, the foreground service
 * that keeps that radio alive while the screen is off (#184). Both are native code, and a bundle that calls one cannot
 * run in an app built without it. Moving this moves the runtime version, so a
 * `0.2.0` install is offered nothing further — `updates.ts` in the daemon
 * answers it `noUpdateAvailable` rather than a manifest it could not use. That
 * is the protection working, and the cost is one sideload.
 *
 * **Move this whenever a native module is added or removed, and at no other
 * time.** A JavaScript change ships over the air and wants no bump; a bump
 * strands every installed app until somebody installs the new one by hand.
 */
const VERSION = "0.4.0";

const updatesUrl = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL?.trim();
/** The certificate is committed; the private key that matches it is not. */
const certificate = join(__dirname, "certs", "certificate.pem");
const signed = existsSync(certificate);

export default (): ExpoConfig => ({
  name: "covey",
  slug: "covey",
  version: VERSION,
  orientation: "default",
  scheme: "covey",
  userInterfaceStyle: "dark",
  android: {
    package: "io.github.dylandotfarm.covey",
  },
  // `appVersion` keys an update to the binary's own version, so a bundle built
  // against newer native modules can never land in an older app. Change
  // `VERSION` and every installed app stops taking updates until it is
  // rebuilt — which is the point.
  runtimeVersion: { policy: "appVersion" },
  updates: updatesUrl
    ? {
        url: updatesUrl,
        enabled: true,
        // The daemon reads it as the socket does: `authenticate()` takes a
        // bearer token. The value is empty here on purpose — see the note above.
        requestHeaders: { authorization: "" },
        // A check on every cold start. A daemon that is not reachable costs
        // the launch nothing: `fallbackToCacheTimeout: 0` means the app starts
        // on the bundle it has and the check runs behind it.
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        ...(signed
          ? { codeSigningCertificate: "./certs/certificate.pem", codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" } }
          : {}),
      }
    : { enabled: false },
  // Listed here and nowhere else. `expo install` writes a plugin into an
  // `app.json` when it finds one, and this config returns its own object
  // rather than extending what it is handed — so an `app.json` beside this
  // file is a config that looks authoritative and has no effect. There is
  // none, deliberately. Add a plugin to this list by hand.
  plugins: [
    "expo-secure-store",
    // Dictation (#172). The plugin asks for RECORD_AUDIO and adds the
    // `<queries>` entry Android needs to see a recognition service at all —
    // without it `isRecognitionAvailable()` answers false on a device that has
    // one.
    ["expo-speech-recognition", { microphonePermission: "covey uses the microphone to write your message when you dictate it." }],
    // `userInterfaceStyle: "dark"` above does nothing without this: the setting
    // is about the *system's* surfaces — the keyboard, the navigation bar — and
    // the app's own palette cannot reach them. Prebuild says so if it is missing.
    // The device (#178). The plugin writes the Bluetooth permissions into the
    // manifest: Android 12 split them into BLUETOOTH_SCAN and BLUETOOTH_CONNECT
    // and wants `neverForLocation` on the scan, which is true here — covey
    // looks for one service and reads no advertisement it did not come for.
    ["react-native-ble-plx", { isBackgroundEnabled: false, neverForLocation: true }],
    "expo-system-ui",
    "expo-image",
    "expo-video",
    // A daemon speaks plain HTTP on a private address, which is the ordinary
    // case: a tailnet peer, or a machine on the same network. Android 9 and
    // later refuse cleartext unless the app asks for it, and without this both
    // the socket and the update check fail with nothing to read. The traffic is
    // already on a network the reader controls, and a certificate for `100.x`
    // or `192.168.x` is not a thing they can get.
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
  ],
  experiments: { typedRoutes: false },
});
