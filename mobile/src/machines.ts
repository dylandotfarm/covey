/**
 * The machines this device knows, across launches (issue #168).
 *
 * The web client has no such file: the page is *served* by a daemon, so it
 * knows one address before it runs a line — its own origin — and it asks that
 * daemon for the rest (`machine.access`). An app has no origin. So the first
 * machine is typed in by a person, and this is where it is kept.
 *
 * The rest still comes from the fleet, exactly as it does on the page, and a
 * fleet member is *not* written here: the TUI owns that list, it changes, and a
 * copy on the phone would go stale. Only what a person typed is kept.
 *
 * A token is a credential, so it goes in the device's keychain through
 * `expo-secure-store` and never into `AsyncStorage` beside the addresses. The
 * two stores are keyed together: the address list names the machines and each
 * token is filed under its own address.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

/** One machine a person added. */
export interface SavedMachine {
  /** The `ws://host:port` this device dials. */
  url: string;
  name: string;
  /**
   * The fleet this machine last said it was in, absent for the default one.
   *
   * A cache and nothing else: the machine declares its own fleet, and covey
   * reads the machine's answer whenever it has one. This is what holds a
   * machine that is away in its own fleet across a launch, instead of
   * dropping its work into the default fleet's list until it answers — which
   * on a phone is most of the day. The TUI keeps the same field for the same
   * reason.
   */
  fleet?: string;
}

const LIST_KEY = "covey.machines";
const LOD_KEY = "covey.lod";
const SHOW_HIDDEN_KEY = "covey.showHidden";

/**
 * A key `expo-secure-store` accepts, made from a URL.
 *
 * The store allows alphanumerics, `.`, `-` and `_` only, and a URL has none of
 * that guarantee, so the URL is hex-encoded. Reversible, which matters: a
 * token has to be found again from the address and removed with it.
 */
function tokenKey(url: string): string {
  let hex = "";
  for (const ch of new TextEncoder().encode(url)) hex += ch.toString(16).padStart(2, "0");
  return `covey.token.${hex}`;
}

/** The machines a person added, in the order they added them. */
export async function readMachines(): Promise<SavedMachine[]> {
  try {
    const raw = await AsyncStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    // Anything a newer build wrote that this one cannot read is dropped rather
    // than crashing the launch: the reader can add the machine again. Each
    // field is taken one at a time for the same reason — a fleet name that is
    // not a string would reach `fleetOf` and throw where nothing catches.
    return (list as Partial<SavedMachine>[]).flatMap((m) => {
      if (typeof m?.url !== "string" || typeof m.name !== "string") return [];
      return [{ url: m.url, name: m.name, ...(typeof m.fleet === "string" ? { fleet: m.fleet } : {}) }];
    });
  } catch {
    return [];
  }
}

/** The token for one machine, or undefined when it needs none. */
export async function readToken(url: string): Promise<string | undefined> {
  try { return (await SecureStore.getItemAsync(tokenKey(url))) ?? undefined; } catch { return undefined; }
}

/**
 * Write the whole list, as the store holds it.
 *
 * **The list is written from memory and never read back to be changed.** It
 * had a writer per act — add this machine, forget that one — and each read the
 * list, changed its own record and wrote the lot back. A person's fingers
 * arrive one at a time, so that stood until the fleet gave covey a field it
 * writes *itself*: a machine's snapshot carries it, and every machine this
 * device has sends one within a few milliseconds of the launch. Two writers
 * that each read before either wrote is the second write built on the first's
 * stale copy, and on a first launch with two machines in one fleet — the setup
 * this feature is for — one of them keeps nothing. It would not heal, either:
 * the store's own guard reads the field it set in memory, so nothing writes
 * again until the next launch, where that machine sits in the default fleet
 * and one fleet reads as two.
 *
 * So `store.saved` is the list, every change is made there, and this writes
 * it. The last write of a frame then carries every change of that frame.
 *
 * **It rejects rather than swallowing a failed write**, unlike the preference
 * writers below it. A preference that did not land costs a setting; this list
 * is the one record the app cannot rediscover, so a machine a person typed in
 * that was not written works for this session and is gone at the next launch.
 * The add path turns that into a sentence in the field the reader is already
 * looking at. The fleet is a cache and its caller catches, because there is
 * nothing to say about a cache that will be written again.
 */
export async function saveMachines(list: SavedMachine[]): Promise<void> {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
}

/**
 * Keep a machine's token, or take it away when it needs none.
 *
 * Its own call beside the list, because the two stores are different: the
 * addresses go in `AsyncStorage` and a token is a credential, so it goes in
 * the device's keychain. Never the address alone — a token left behind under
 * an address nobody dials is a credential nothing will ever clear.
 */
export async function saveToken(url: string, token: string | undefined): Promise<void> {
  if (token) await SecureStore.setItemAsync(tokenKey(url), token);
  else await SecureStore.deleteItemAsync(tokenKey(url)).catch(() => {});
}

/** The level of detail this device reads transcripts at (#149). */
export async function readLod(): Promise<string | null> {
  try { return await AsyncStorage.getItem(LOD_KEY); } catch { return null; }
}

export async function saveLod(lod: string): Promise<void> {
  await AsyncStorage.setItem(LOD_KEY, lod).catch(() => {});
}

/**
 * Whether this device paints the threads covey hides: its automated reviewers.
 *
 * A preference of the device, beside the level of detail and under the same
 * rule — it travels in no command and no daemon hears it. The page keeps the
 * same switch in `localStorage` under the same name.
 */
export async function readShowHidden(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(SHOW_HIDDEN_KEY)) === "1"; } catch { return false; }
}

export async function saveShowHidden(on: boolean): Promise<void> {
  await AsyncStorage.setItem(SHOW_HIDDEN_KEY, on ? "1" : "0").catch(() => {});
}

/**
 * Which push-to-talk button this device holds: `src/talk.ts` has the modes.
 *
 * A preference of the device, beside the two above and under the same rule. It
 * is stored as the mode's own word rather than a flag, because there are three
 * of them and a second flag would make a fourth state that means nothing.
 */
const TALK_KEY = "covey.talk";

export async function readTalk(): Promise<string | null> {
  try { return await AsyncStorage.getItem(TALK_KEY); } catch { return null; }
}

export async function saveTalk(mode: string): Promise<void> {
  await AsyncStorage.setItem(TALK_KEY, mode).catch(() => {});
}

/**
 * Whether the reader asked to be told when a thread needs them.
 *
 * A preference of the device, beside the others, and the only one that costs
 * something while the app is closed: it holds the process alive so the socket
 * is there to hear the news. Off until somebody asks, like the device switch
 * above it and for the same reason.
 */
const NOTIFY_KEY = "covey.notify";

export async function readNotifyWanted(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(NOTIFY_KEY)) === "1"; } catch { return false; }
}

export async function saveNotifyWanted(on: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIFY_KEY, on ? "1" : "0").catch(() => {});
}

/** Whether the reader asked covey to look for a device (#178). */
const DEVICE_KEY = "covey.device";

export async function readDeviceWanted(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(DEVICE_KEY)) === "1"; } catch { return false; }
}

export async function saveDeviceWanted(on: boolean): Promise<void> {
  await AsyncStorage.setItem(DEVICE_KEY, on ? "1" : "0").catch(() => {});
}
