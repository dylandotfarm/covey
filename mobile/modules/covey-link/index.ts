/**
 * The service that keeps covey reachable while nobody is looking (#184).
 *
 * Android stops a background app from receiving Bluetooth scan results while
 * the screen is off, suspends a cached app's network in Doze, and kills the
 * process when the app is swiped away. Each of those makes covey unreachable
 * with a locked phone — the device's talk button does nothing, and a thread
 * that needs the reader cannot tell them. A foreground service is the mechanism
 * Android offers for all of it.
 *
 * It holds no Bluetooth and no socket of its own. `device/ble.ts` owns the scan
 * and the connection and `store.ts` owns the machines; this keeps the process
 * they run in alive.
 *
 * **It is held for reasons and released by reason.** Two switches want it — the
 * device, and notifications — and either may be on without the other, so
 * neither may turn the service off. The service keeps the set and composes what
 * its notification says from it; the words are in `CoveyLinkService.text`,
 * beside the notification they go in.
 *
 * Android only. On any other platform these are calls that answer false, so
 * nothing above has to ask which platform it is on.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** Why covey is holding the process alive. The service knows these words. */
export type LinkHold = "device" | "watch";

interface CoveyLinkNative {
  isRunning: () => boolean;
  hold: (reason: LinkHold) => boolean;
  release: (reason: LinkHold) => boolean;
}

/*
 * Optional on purpose. A bundle delivered over the air can land in an app built
 * before this module existed, and `requireNativeModule` would throw at import
 * time and take the whole app with it. Answering false is the behaviour of an
 * older app, which is exactly what it is.
 */
const native = requireOptionalNativeModule<CoveyLinkNative>("CoveyLink");

/** Whether this build can hold the process while the screen is off at all. */
export const linkServiceAvailable = Platform.OS === "android" && native !== null;

export function linkServiceRunning(): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.isRunning();
  } catch {
    return false;
  }
}

/**
 * Keep the process alive for one reason, and say so in the shade.
 *
 * Asking twice for the same reason is one hold: the switch that wants it may be
 * read again at launch, and Android may restart the service with nothing held.
 */
export function holdLinkService(reason: LinkHold): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.hold(reason);
  } catch {
    /*
     * An app built before the service took a reason has `start` and `stop` and
     * no `hold`, and an Expo module refuses a call it does not define. It
     * cannot happen through the update channel — a native module moves the
     * runtime version, so that bundle is never offered to that app — and it
     * answers the way an older build answers everything here: false, which
     * reads as "this build cannot hold it", which is true.
     */
    return false;
  }
}

/** Let one reason go. The service stops when it was the last. */
export function releaseLinkService(reason: LinkHold): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.release(reason);
  } catch {
    return false;
  }
}
