/**
 * The app's configuration (issue #168).
 *
 * Two things here are decided at build time and never at run time, and both
 * are deliberate.
 *
 * **Which machine serves updates.** `COVEY_UPDATES_URL` names it, and the URL
 * is baked into the binary. A daemon that serves updates serves the JavaScript
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
 * With no `COVEY_UPDATES_URL` the updates module is off and the app runs
 * whatever bundle it was built with. That is the development case, and it must
 * keep working on a machine that has never seen a certificate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";

/** The version the runtime is keyed on. An update must match the app it lands in. */
const VERSION = "0.1.0";

const updatesUrl = process.env.COVEY_UPDATES_URL?.trim();
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
