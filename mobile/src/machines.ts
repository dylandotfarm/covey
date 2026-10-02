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
}

const LIST_KEY = "covey.machines";
const LOD_KEY = "covey.lod";

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
    // than crashing the launch: the reader can add the machine again.
    return list.filter((m): m is SavedMachine =>
      typeof m === "object" && m !== null && typeof (m as SavedMachine).url === "string" && typeof (m as SavedMachine).name === "string");
  } catch {
    return [];
  }
}

/** The token for one machine, or undefined when it needs none. */
export async function readToken(url: string): Promise<string | undefined> {
  try { return (await SecureStore.getItemAsync(tokenKey(url))) ?? undefined; } catch { return undefined; }
}

/** Add a machine, or change the name and the token of one already there. */
export async function saveMachine(m: SavedMachine, token: string | undefined): Promise<void> {
  const list = await readMachines();
  const at = list.findIndex((x) => x.url === m.url);
  if (at >= 0) list[at] = m; else list.push(m);
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
  if (token) await SecureStore.setItemAsync(tokenKey(m.url), token);
  else await SecureStore.deleteItemAsync(tokenKey(m.url)).catch(() => {});
}

/** Forget a machine, and the token with it — never the address alone. */
export async function forgetMachine(url: string): Promise<void> {
  const list = (await readMachines()).filter((m) => m.url !== url);
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
  await SecureStore.deleteItemAsync(tokenKey(url)).catch(() => {});
}

/** The level of detail this device reads transcripts at (#149). */
export async function readLod(): Promise<string | null> {
  try { return await AsyncStorage.getItem(LOD_KEY); } catch { return null; }
}

export async function saveLod(lod: string): Promise<void> {
  await AsyncStorage.setItem(LOD_KEY, lod).catch(() => {});
}

/** Whether the reader asked covey to look for a device (#178). */
const DEVICE_KEY = "covey.device";

export async function readDeviceWanted(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(DEVICE_KEY)) === "1"; } catch { return false; }
}

export async function saveDeviceWanted(on: boolean): Promise<void> {
  await AsyncStorage.setItem(DEVICE_KEY, on ? "1" : "0").catch(() => {});
}
