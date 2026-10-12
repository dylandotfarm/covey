/**
 * The volume keys, as a push-to-talk button.
 *
 * A thumb on a button slides off it. The reader's hand moves while they think,
 * the press ends, and half the sentence is gone — which is what the volume keys
 * are for: a key you can feel has an edge, and a hold on it survives the hand
 * moving. So the composer offers both, and `src/talk.ts` holds the choice.
 *
 * Covey takes *either* key, and while it holds one the volume does not move.
 * That is the cost of the feature and the reason it is off until a reader asks
 * for it: a phone whose volume rocker talks instead of changing the volume is
 * a surprise nobody should be given. The keys are taken only while the
 * composer is on screen, so every other screen of the app leaves them alone.
 *
 * Android only. On any other platform these are calls that answer false and a
 * watch that hears nothing, so nothing above has to ask which platform it is
 * on.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** One press, or one release, of one key. */
export interface VolumeKeyPress {
  key: "volumeDown" | "volumeUp";
  /** True for the press, false for the release. Never repeated. */
  pressed: boolean;
}

interface CoveyKeysNative {
  setWatching: (on: boolean) => boolean;
  isWatching: () => boolean;
  addListener: (event: "keypress", listener: (e: VolumeKeyPress) => void) => { remove: () => void };
}

/*
 * Optional on purpose, as `covey-link` is. A bundle delivered over the air can
 * land in an app built before this module existed, and `requireNativeModule`
 * would throw at import time and take the whole app with it. Answering false
 * is the behaviour of that older app, which is exactly what it is.
 */
const native = requireOptionalNativeModule<CoveyKeysNative>("CoveyKeys");

/** Whether this build can read the volume keys at all. */
export const volumeKeysAvailable = Platform.OS === "android" && native !== null;

/**
 * Take the volume keys, until the returned function gives them back.
 *
 * The listener is added before the keys are taken, so no press is ever
 * swallowed with nothing to hear it — the native side fails open on a missing
 * listener for the same reason.
 */
export function holdVolumeKeys(onPress: (e: VolumeKeyPress) => void): () => void {
  if (!volumeKeysAvailable) return () => {};
  /*
   * Caught, and it is not ceremony. This runs in an effect as the composer
   * mounts, so a native call that throws is a conversation the reader cannot
   * open — the error boundary catches it and paints "covey stopped" over the
   * whole app. Dictation by the button is the worst this may cost.
   */
  let sub: { remove: () => void };
  try {
    sub = native!.addListener("keypress", onPress);
    native!.setWatching(true);
  } catch {
    return () => {};
  }
  return () => {
    try {
      sub.remove();
      native!.setWatching(false);
    } catch {
      /* The module went with a reload, which released them already. */
    }
  };
}
