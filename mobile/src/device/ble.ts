/**
 * The radio, the phone's half (#178).
 *
 * The device is the peripheral and this is the central: the app scans for the
 * service, connects, subscribes to the uplink, and writes to the downlink. It
 * has to be this way round — a phone cannot advertise reliably while its app is
 * in the background, and a device in a pocket must be findable the moment
 * somebody opens covey.
 *
 * Nothing here knows what a message means. It carries bytes, puts fragments
 * back together with the same `Reassembler` the firmware mirrors, and hands
 * whole messages up to `bridge.ts`. The framing, the codec and the message
 * bodies are all in `@covey/client`, which node tests, because the other end of
 * this wire is C that cannot be tested beside it.
 *
 * `react-native-ble-plx` is a native module, so a bundle that imports this
 * cannot run in an app built without it. That is why `app.config.ts` moves to
 * `0.3.0`: see the note on `VERSION` there.
 */
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, type Device, type Subscription } from "react-native-ble-plx";
import {
  DEVICE_DOWNLINK_UUID, DEVICE_SERVICE_UUID, DEVICE_UPLINK_UUID, Reassembler, fragments,
  usablePayload, type DeviceMessage,
} from "@covey/client";

/**
 * Base64, because that is the only shape `react-native-ble-plx` takes.
 *
 * Written here rather than taken from a global. React Native has had `atob` and
 * `btoa` since 0.74, but they are defined over Latin-1 strings and the error a
 * stray character makes is a silently wrong byte in the middle of an utterance.
 * Twenty lines that are obviously right are worth more than that.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** Where the link is. The settings screen says each of these in words. */
export type LinkState = "off" | "denied" | "scanning" | "connecting" | "ready" | "lost";

export interface LinkEvents {
  onState: (state: LinkState, detail?: string) => void;
  onMessage: (message: DeviceMessage) => void;
}

/**
 * Ask Android for what a scan needs.
 *
 * Android 12 split Bluetooth into its own two permissions; before that a scan
 * counted as locating the user and needed the location permission instead. A
 * phone that refuses either gets `denied` and a sentence, rather than a scan
 * that finds nothing and never says why.
 */
async function permitted(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const api = typeof Platform.Version === "number" ? Platform.Version : parseInt(String(Platform.Version), 10);
  const wanted = api >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const got = await PermissionsAndroid.requestMultiple(wanted);
  if (!wanted.every((p) => got[p] === PermissionsAndroid.RESULTS.GRANTED)) return false;

  /*
   * The notification, asked for separately and not required.
   *
   * From Android 13 a notification needs permission, and the foreground service
   * that keeps the link alive while the screen is off carries one. Refusing it
   * does not stop the service - it only makes it invisible - so a refusal must
   * not stop the radio with it.
   */
  if (api >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
  }
  return true;
}

export class DeviceLink {
  private manager: BleManager | null = null;
  private device: Device | null = null;
  private monitor: Subscription | null = null;
  private gone: Subscription | null = null;
  private readonly rx = new Reassembler();
  private msgId = 1;
  private payload = 20;
  private stopped = true;
  /** Serialises writes: two at once on one characteristic interleave fragments. */
  private queue: Promise<void> = Promise.resolve();

  state: LinkState = "off";
  /** What the device said it is, once it has said it. */
  name: string | null = null;

  constructor(private readonly ev: LinkEvents) {}

  private set(state: LinkState, detail?: string): void {
    this.state = state;
    this.ev.onState(state, detail);
  }

  /** Look for a device and stay connected to it until `stop`. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    /*
     * There is no Bluetooth in the browser harness.
     *
     * `pnpm run web` is how a layout is looked at before an APK exists
     * (docs/MOBILE.md); the bundle builds there because nothing constructs a
     * `BleManager` until this line. Say so rather than throw, so the settings
     * page can still be looked at.
     */
    if (Platform.OS === "web") {
      this.set("denied", "A browser has no Bluetooth. Run the app on the phone.");
      return;
    }
    this.stopped = false;
    if (!(await permitted())) {
      this.set("denied", "covey may not use Bluetooth. Android's settings can allow it.");
      this.stopped = true;
      return;
    }
    this.manager = new BleManager();
    this.scan();
  }

  private scan(): void {
    if (this.stopped || !this.manager) return;
    this.set("scanning");
    this.manager.startDeviceScan([DEVICE_SERVICE_UUID], null, (err, found) => {
      if (this.stopped) return;
      if (err) {
        this.set("lost", err.message);
        return;
      }
      if (!found) return;
      this.manager?.stopDeviceScan();
      void this.attach(found);
    });
  }

  private async attach(found: Device): Promise<void> {
    try {
      this.set("connecting", found.name ?? undefined);
      const dev = await found.connect({ requestMTU: 517 });
      await dev.discoverAllServicesAndCharacteristics();
      this.device = dev;
      this.name = dev.name ?? null;
      /*
       * What the connection actually agreed, not what was asked for.
       *
       * Android grants less than 517 often enough that assuming it is the way
       * to send fragments the device silently drops. `mtu` is what came back.
       */
      this.payload = usablePayload(dev.mtu);

      this.monitor = dev.monitorCharacteristicForService(
        DEVICE_SERVICE_UUID, DEVICE_UPLINK_UUID,
        (err, chr) => {
          if (err || !chr?.value) return;
          const message = this.rx.push(fromBase64(chr.value));
          if (message) this.ev.onMessage(message);
        },
      );
      this.gone = dev.onDisconnected(() => {
        this.monitor?.remove();
        this.device = null;
        this.set("lost");
        // Look again. A device walks out of range and comes back.
        if (!this.stopped) setTimeout(() => this.scan(), 1000);
      });
      this.set("ready", dev.name ?? undefined);
    } catch (e) {
      this.device = null;
      this.set("lost", (e as Error).message);
      if (!this.stopped) setTimeout(() => this.scan(), 2000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.monitor?.remove();
    this.gone?.remove();
    this.manager?.stopDeviceScan();
    const dev = this.device;
    this.device = null;
    this.name = null;
    if (dev) await dev.cancelConnection().catch(() => {});
    this.manager?.destroy();
    this.manager = null;
    this.set("off");
  }

  connected(): boolean {
    return this.device !== null && this.state === "ready";
  }

  /**
   * Send one message.
   *
   * Written without a response, which is what makes a thread list arrive in one
   * go rather than one round trip per fragment. Calls are put in a queue
   * because two messages written at once would interleave their fragments, and
   * the device throws away a message whose fragments do not follow each other.
   */
  send(type: number, body: Uint8Array): Promise<void> {
    const run = async () => {
      const dev = this.device;
      if (!dev) return;
      const id = this.msgId++ & 0xffff;
      for (const frame of fragments(type, body, this.payload, id)) {
        await dev.writeCharacteristicWithoutResponseForService(
          DEVICE_SERVICE_UUID, DEVICE_DOWNLINK_UUID, toBase64(frame),
        );
      }
    };
    this.queue = this.queue.then(run, run).catch(() => {});
    return this.queue;
  }
}
