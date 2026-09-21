/**
 * Every address a phone can open this daemon's web client at.
 *
 * The daemon computes this, not the page: only the daemon knows which
 * interfaces the machine has and how it is bound. `covey info` prints the same
 * list, so the terminal and the page never disagree about an address.
 */
import { hostname, networkInterfaces } from "node:os";
import type { WebAddress } from "@covey/protocol";
import { isTailnetIp } from "./tailscale.js";

export interface AddressInput {
  port: number;
  /** "loopback" | "tailnet" | "all" | explicit ip */
  bind: string;
  /** The MagicDNS name, when tailscale runs. */
  tailnetName?: string | undefined;
  tailnetIps?: string[] | undefined;
}

/** For a test: the interfaces to read instead of the machine's own. */
export interface Interfaces {
  lanIps: string[];
  host: string;
}

function readInterfaces(): Interfaces {
  const lanIps: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4" || isTailnetIp(a.address)) continue;
      lanIps.push(a.address);
    }
  }
  return { lanIps, host: hostname().split(".")[0] ?? "" };
}

export function webAddresses(c: AddressInput, ifaces: Interfaces = readInterfaces()): WebAddress[] {
  const out: WebAddress[] = [];
  const url = (host: string) => `http://${host}:${c.port}/`;
  const lanReachable = c.bind === "all" || (c.bind !== "tailnet" && c.bind !== "loopback");
  const tailnetReachable = c.bind === "all" || c.bind === "tailnet";
  if (c.tailnetName) out.push({ kind: "tailnet", url: url(c.tailnetName), reachable: tailnetReachable });
  for (const ip of (c.tailnetIps ?? []).filter((ip) => ip.includes("."))) out.push({ kind: "tailnet", url: url(ip), reachable: tailnetReachable });
  // The mDNS name resolves only where a responder runs, so it is offered and
  // not promised: `reachable` says what the bind allows, not what the LAN does.
  if (ifaces.host && ifaces.lanIps.length) out.push({ kind: "mdns", url: url(`${ifaces.host}.local`), reachable: lanReachable });
  for (const ip of ifaces.lanIps) out.push({ kind: "lan", url: url(ip), reachable: lanReachable });
  return out;
}

/** The address with the token on it, for every address that needs one. */
export function withToken(a: WebAddress, token: string): string {
  return a.kind === "tailnet" ? a.url : `${a.url}?token=${token}`;
}
