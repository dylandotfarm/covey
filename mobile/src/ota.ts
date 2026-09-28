/**
 * Taking a new bundle from the daemon that serves it (issue #168).
 *
 * The machine is decided when the app is built — `EXPO_PUBLIC_COVEY_UPDATES_URL`,
 * which `app.config.ts` also reads — and that file says why it is not a run-time
 * setting.
 * What is decided at run time is the *credential*: the token is a secret, a
 * binary is no place for one, so the app reads it from the device's keychain and
 * hands it to `expo-updates` through `setUpdateRequestHeadersOverride`. That
 * call needs no `disableAntiBrickingMeasures`, which is the whole reason the
 * split is this way round.
 *
 * Expo will only let a header be overridden if the build declared it, which is
 * why `app.config.ts` carries an empty `authorization`. Overriding replaces
 * *every* custom header from the build, so this sends the full set each time
 * rather than a patch.
 *
 * Nothing here decides whether to restart the app. A reload throws away what the
 * reader was typing, so the app never takes an update on its own: it says one is
 * ready and the reader taps. `checkAutomatically: ON_LOAD` means the check has
 * usually finished by the time they look.
 */
import * as Updates from "expo-updates";
import { readMachines, readToken } from "./machines";

/**
 * Where this build asks for updates, or null when it was built without a machine.
 *
 * Read from the environment variable and *not* from `Constants.expoConfig`. The
 * two are written by different build steps — `expo prebuild` puts the URL into
 * `AndroidManifest.xml`, and the gradle build writes `assets/app.config` from
 * `app.config.ts` — and the first APK built here proved they can disagree: the
 * native layer would update and this function said the build took no updates.
 * Metro inlines an `EXPO_PUBLIC_` variable at bundle time, so this is the same
 * literal the app config was built from.
 */
export function updatesUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_COVEY_UPDATES_URL?.trim();
  return url ? url : null;
}

/**
 * Whether this build can take an update at all. False in development, always.
 *
 * `Updates.isEnabled` is the *native* answer, read from the manifest the build
 * wrote, and it is the one that decides whether a check can happen at all. The
 * URL is this bundle's own idea of where. Both have to agree, and
 * `updateInconsistency` is what says so when they do not.
 */
export function updatesEnabled(): boolean {
  return Updates.isEnabled && Boolean(updatesUrl());
}

/**
 * A build whose two halves disagree, described, or null when they agree.
 *
 * There is exactly one way to produce this and it is worth naming rather than
 * hiding: a build that set the environment variable for one step and not the
 * other. Saying "this build takes no updates" would be a lie the reader could
 * not act on, because the native layer would go on updating without them.
 */
export function updateInconsistency(): string | null {
  const url = updatesUrl();
  if (Updates.isEnabled && !url) {
    return "This build updates itself but does not say from where. It was built with EXPO_PUBLIC_COVEY_UPDATES_URL set for one step and not the other — see docs/MOBILE.md.";
  }
  if (!Updates.isEnabled && url) {
    return `This build names ${url} for updates but the updates module is off in the binary. Rebuild after a prebuild with the same environment.`;
  }
  return null;
}

/**
 * The machine that serves this app its bundles, as the reader knows it.
 *
 * Matched by host and port against the machines they added, so the settings
 * screen can name it rather than printing a URL. A build pointed at a machine
 * this device has never dialled is the ordinary case on a first launch, and
 * there is no name to give then.
 */
export async function updateMachineName(): Promise<string | null> {
  const url = updatesUrl();
  if (!url) return null;
  try {
    const host = new URL(url).host;
    const found = (await readMachines()).find((m) => new URL(m.url).host === host);
    return found?.name ?? host;
  } catch {
    return null;
  }
}

/**
 * Give `expo-updates` the token for the machine it is about to ask.
 *
 * The token is matched to the update URL by host, never taken from the first
 * machine in the list: the machine that serves bundles is chosen at build time
 * and is very often not the one the reader added first.
 *
 * A machine that needs no token — loopback, or a tailnet peer, which the daemon
 * authenticates by `whois` — gets an empty header, and the daemon ignores it.
 */
export async function primeUpdateToken(): Promise<void> {
  if (!Updates.isEnabled) return;
  const url = updatesUrl();
  if (!url) return;
  let token: string | undefined;
  try {
    const host = new URL(url).host;
    const machine = (await readMachines()).find((m) => new URL(m.url).host === host);
    if (machine) token = await readToken(machine.url);
  } catch {
    // An address neither this app nor the reader can parse is one to leave
    // alone: the build's own headers then stand.
    return;
  }
  try {
    Updates.setUpdateRequestHeadersOverride({ authorization: token ? `Bearer ${token}` : "" });
  } catch {
    // An older `expo-updates` than this app was written against. The build's
    // own headers stand, and a machine that needs a token says 401 — which the
    // settings screen shows as the check error it is.
  }
}

/** What the settings screen says about updates. */
export interface UpdateStatus {
  enabled: boolean;
  /** The machine that serves bundles, as the reader knows it. */
  machine: string | null;
  /** The bundle running now: an update's id, or null for the one built in. */
  updateId: string | null;
  createdAt: Date | null;
  runtimeVersion: string | null;
  embedded: boolean;
}

export function updateStatus(machine: string | null): UpdateStatus {
  return {
    enabled: updatesEnabled(),
    machine,
    updateId: Updates.updateId,
    createdAt: Updates.createdAt,
    runtimeVersion: Updates.runtimeVersion,
    embedded: Updates.isEmbeddedLaunch,
  };
}

/**
 * Ask the daemon whether there is a newer bundle, and take it if there is.
 *
 * Returns what to tell the reader. It never reloads: that is their tap, because
 * a reload throws away the message they were writing.
 */
export async function fetchUpdate(): Promise<{ ready: true } | { ready: false; message: string }> {
  if (!updatesEnabled()) return { ready: false, message: "This build takes no updates over the air." };
  await primeUpdateToken();
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return { ready: false, message: "No newer bundle on that machine." };
    await Updates.fetchUpdateAsync();
    return { ready: true };
  } catch (e) {
    // The daemon's own words reach here: a 401 from the gate, or the message
    // `updates.ts` writes when the machine holds no signing key.
    return { ready: false, message: (e as Error).message || "The update check failed." };
  }
}

/** Restart into the bundle already downloaded. */
export async function applyUpdate(): Promise<void> {
  await Updates.reloadAsync();
}
