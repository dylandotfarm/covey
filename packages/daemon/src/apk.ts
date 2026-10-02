/**
 * The app itself, served by the machine that built it (#185).
 *
 * A native change moves the runtime version, and an app with a new runtime
 * version has to be installed by hand — the whole point of that rule is that a
 * bundle cannot land in a binary it would crash. So every native change costs
 * somebody a sideload, and a sideload meant typing an address into a phone's
 * browser from memory.
 *
 * It need not. The machine that built the app is a machine the phone already
 * knows, already trusts and already has a token for. So the daemon serves what
 * `pnpm run apk` left behind, and the settings screen links to it.
 *
 * This is **not** the over-the-air route and never becomes it. `/updates` ships
 * JavaScript into an app that is already installed, silently and often. This
 * hands over a whole binary for a person to install on purpose, and it exists
 * for exactly the case the other one refuses to handle.
 *
 * Nothing is built here. A machine that has never run `pnpm run apk` has no APK
 * and says so, which is most of them.
 */
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/** What the machine holds, for `MachineInfo.appBuild`. */
export interface AppBuild {
  /** The version the binary carries, which decides what it will accept. */
  version: string;
  /** When gradle wrote it. */
  builtAt: string;
  bytes: number;
}

/*
 * Where gradle leaves it, and where prebuild writes the version.
 *
 * This file is at `packages/daemon/{src,dist}/apk.{ts,js}`, and `mobile/` is
 * not a package of the workspace, so there is no name to resolve — the path is
 * counted out, exactly as `updates.ts` counts out `mobile/dist`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..", "..", "..", "mobile");
const APK = join(mobile, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
const GRADLE = join(mobile, "android", "app", "build.gradle");

/**
 * The version the APK carries.
 *
 * Read from the gradle file rather than from the binary, because the version
 * inside an APK is in a compiled manifest that would need a parser, and
 * `expo prebuild` writes this line and the build that follows it in one go. A
 * gradle file without the line belongs to no APK worth offering.
 */
async function versionName(): Promise<string | null> {
  try {
    const text = await readFile(GRADLE, "utf8");
    return /versionName\s+["']([^"']+)["']/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What this machine has, or null when it has never built the app. */
export async function appBuild(): Promise<AppBuild | null> {
  try {
    const info = await stat(APK);
    if (!info.isFile() || info.size === 0) return null;
    const version = await versionName();
    if (!version) return null;
    return { version, builtAt: info.mtime.toISOString(), bytes: info.size };
  } catch {
    return null;
  }
}

/**
 * Hand the APK over.
 *
 * `content-disposition` names the file, because Android decides whether to
 * offer an install from the name and the type, and a download called
 * `apk` with no extension is one a phone will not open.
 */
export async function serveApk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const build = await appBuild();
  if (!build) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("no app has been built on this machine\n");
    return;
  }

  res.writeHead(200, {
    "content-type": "application/vnd.android.package-archive",
    "content-length": String(build.bytes),
    "content-disposition": `attachment; filename="covey-${build.version}.apk"`,
    // The bytes change whenever somebody builds, and a stale APK is a sideload
    // that silently does nothing.
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(APK).pipe(res);
}
