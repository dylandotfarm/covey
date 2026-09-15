import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { platform } from "node:os";

const run = promisify(execFile);

/** Locate the tailscale CLI across platforms. */
export function tailscaleBinary(): string | null {
  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/opt/homebrew/bin/tailscale",
          "/usr/local/bin/tailscale",
        ]
      : platform() === "win32"
        ? ["C:\\Program Files\\Tailscale\\tailscale.exe"]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"];
  for (const c of candidates) if (existsSync(c)) return c;
  return "tailscale"; // hope it's on PATH
}

export interface TailscaleSelf {
  dnsName: string;
  ips: string[];
  userId: number;
  hostName: string;
}

async function tsJson(args: string[]): Promise<any | null> {
  const bin = tailscaleBinary();
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, args, { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function tailscaleSelf(): Promise<TailscaleSelf | null> {
  const status = await tsJson(["status", "--json"]);
  if (!status?.Self || status.BackendState !== "Running") return null;
  return {
    dnsName: String(status.Self.DNSName ?? "").replace(/\.$/, ""),
    ips: (status.Self.TailscaleIPs ?? []) as string[],
    userId: Number(status.Self.UserID),
    hostName: String(status.Self.HostName ?? ""),
  };
}

export interface PeerIdentity {
  userId: number;
  loginName: string;
  nodeName: string;
}

const whoisCache = new Map<string, { at: number; id: PeerIdentity | null }>();

/** Identify the tailnet peer behind a source ip. Null if not a tailnet peer. */
export async function whois(ip: string): Promise<PeerIdentity | null> {
  const clean = ip.replace(/^::ffff:/, "");
  const cached = whoisCache.get(clean);
  if (cached && Date.now() - cached.at < 60_000) return cached.id;
  const j = await tsJson(["whois", "--json", clean]);
  const id: PeerIdentity | null = j?.UserProfile
    ? {
        userId: Number(j.UserProfile.ID),
        loginName: String(j.UserProfile.LoginName ?? ""),
        nodeName: String(j.Node?.Name ?? "").replace(/\.$/, ""),
      }
    : null;
  whoisCache.set(clean, { at: Date.now(), id });
  return id;
}

export function isLoopback(ip: string): boolean {
  const c = ip.replace(/^::ffff:/, "");
  return c === "127.0.0.1" || c === "::1" || c.startsWith("127.");
}

export function isTailnetIp(ip: string): boolean {
  const c = ip.replace(/^::ffff:/, "");
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(c) || c.startsWith("fd7a:115c:a1e0");
}
