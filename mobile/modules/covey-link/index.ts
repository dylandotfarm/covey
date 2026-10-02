/**
 * The service that keeps the device reachable while the phone is locked (#184).
 *
 * Android stops a background app from receiving Bluetooth scan results while
 * the screen is off, and kills the process when the app is swiped away. Either
 * one makes the device unreachable, and the reader sees a button that does
 * nothing. A foreground service is the mechanism Android offers for both.
 *
 * It holds no Bluetooth of its own. `device/ble.ts` still owns the scan and the
 * connection; this keeps the process they run in alive. The cost is a
 * notification Android will not let covey hide, which is the right trade: a
 * reader should be able to see what is holding their radio open.
 *
 * Android only. On any other platform these are three calls that answer false,
 * so nothing above has to ask which platform it is on.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface CoveyLinkNative {
  isRunning: () => boolean;
  start: () => boolean;
  stop: () => boolean;
}

/*
 * Optional on purpose. A bundle delivered over the air can land in an app built
 * before this module existed, and `requireNativeModule` would throw at import
 * time and take the whole app with it. Answering false is the behaviour of an
 * older app, which is exactly what it is.
 */
const native = requireOptionalNativeModule<CoveyLinkNative>("CoveyLink");

/** Whether this build can hold the link while the screen is off at all. */
export const linkServiceAvailable = Platform.OS === "android" && native !== null;

export function linkServiceRunning(): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.isRunning();
  } catch {
    return false;
  }
}

export function startLinkService(): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.start();
  } catch {
    return false;
  }
}

export function stopLinkService(): boolean {
  if (!linkServiceAvailable) return false;
  try {
    return native!.stop();
  } catch {
    return false;
  }
}
