import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";

const run = promisify(execFile);

/**
 * The credentials behind every session, and what happens when they run out.
 *
 * Each session subprocess reads the one credential store this machine has, and
 * then keeps its access token in memory. The token lives about eight hours.
 * Whichever process refreshes it first gets a new pair and the server revokes
 * the old one, so every other live session now holds a token the API refuses:
 * `Failed to authenticate. API Error: 401 OAuth access token has been revoked.`
 * Measured on 2026-09-18: the store changed at 21:09:20, and a session that
 * started at 20:52 failed at 21:17 while a new process on the same credentials
 * answered at once.
 *
 * A resumed session cannot refresh at all. The SDK resumes from covey's store
 * into a temporary config directory, and the copy of the credentials it writes
 * there carries the access token and *no refresh token* (`wnt` in `sdk.mjs`
 * deletes it; measured on 2026-09-22 on six such copies). So a resumed session
 * dies when the access token expires, whatever else happens:
 * `Failed to authenticate. API Error: 401 OAuth access token has expired.`
 * And a daemon that has run for a day holds only resumed sessions, so nothing
 * on the machine refreshes the store. A new session copies the same expired
 * token and fails the same way, and the thread is stuck until a person runs
 * `claude` by hand.
 *
 * So the daemon asks Claude Code to refresh. `refreshCredentials` runs one
 * fresh one-turn process against the real store, the way `claude -p` does;
 * that process holds the refresh token, refreshes the pair, and saves it where
 * every later session reads it. The daemon never touches the token itself and
 * never talks to the OAuth server. It refreshes only when the token is
 * expired, or about to be, or when a session that read it failed — a refresh
 * *is* the rotation that revokes what the other sessions hold, so an early
 * one would cause the fault it means to prevent.
 *
 * The rest is knowing: `credentialExpiry` reads when the token runs out,
 * `credentialStamp` sees a rotation, and `isAuthFailure` tells a failure of
 * the credentials from a failure of the work.
 */

/** Names the credential rather than the request. */
const CREDENTIAL = /oauth|authenticat|credential|api[ _]?key/i;
/** Says the credential is the thing at fault. */
const REFUSED = /\b401\b|\b403\b|revoked|expired|invalid|unauthori[sz]ed/i;

/**
 * Did this turn die on the credentials rather than on the work?
 *
 * Both halves must be there. `401` alone is a web page a tool fetched, and
 * `expired` alone is a certificate in a build log; the text has to name the
 * credential *and* say it was refused. The daemon reads only the CLI's own
 * error text with this, never a tool's output, so the two together are enough.
 */
export function isAuthFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return CREDENTIAL.test(text) && REFUSED.test(text);
}

/** Where Claude Code keeps its settings, and its credentials on Linux. */
function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * A fingerprint of the credential store: a different string means the token
 * changed. `null` means this machine keeps its credentials somewhere we cannot
 * read, and the watch stays off — a daemon that cannot see a rotation must
 * still run.
 */
export async function credentialStamp(): Promise<string | null> {
  const file = await fileStamp(configDir());
  if (file) return file;
  if (process.platform === "darwin") return keychainStamp();
  return null;
}

/** The file Claude Code writes where there is no keychain. */
export async function fileStamp(dir: string): Promise<string | null> {
  try {
    const s = await stat(join(dir, ".credentials.json"));
    return `file:${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/**
 * When the access token in the store expires, in milliseconds since the epoch.
 * `null` means the store cannot be read, and then only a failure tells the
 * daemon the token is dead.
 *
 * On Linux this is one number out of `.credentials.json`. On macOS the
 * keychain gives the number only with the whole item, so the daemon reads the
 * item the way the SDK itself does at every resume, takes the number, and
 * keeps nothing else.
 */
export async function credentialExpiry(): Promise<number | null> {
  const file = await fileExpiry(configDir());
  if (file !== null) return file;
  if (process.platform === "darwin") return parseExpiry(await keychainRead(["-w"]));
  return null;
}

/** The expiry out of the file Claude Code writes where there is no keychain. */
export async function fileExpiry(dir: string): Promise<number | null> {
  try {
    return parseExpiry(await readFile(join(dir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `claudeAiOauth.expiresAt` out of the store's JSON; `null` for anything else. */
export function parseExpiry(json: string | null | undefined): number | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json)?.claudeAiOauth?.expiresAt;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The macOS keychain item, read for its modification date alone. The token
 * itself stays in the keychain: the daemon has no use for it, and a secret it
 * never reads is a secret it cannot leak.
 *
 * The read takes about 40 ms and asks the user for nothing, because an
 * attribute is not the password.
 */
async function keychainStamp(): Promise<string | null> {
  return parseKeychainStamp((await keychainRead([])) ?? "");
}

/**
 * What `security` prints for the Claude Code item, with `extra` added to the
 * lookup: nothing for the attributes, `-w` for the payload. Two accounts can
 * hold this service name, so the user's own comes first and the plain lookup
 * is the fallback. `null` when there is no item, or no keychain.
 */
async function keychainRead(extra: string[]): Promise<string | null> {
  const lookups: string[][] = [];
  try { lookups.push(["-a", userInfo().username]); } catch { /* no user name to ask by */ }
  lookups.push([]);
  for (const account of lookups) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", ...account, ...extra], { timeout: 5_000 });
      if (stdout.trim()) return stdout;
    } catch {
      /* no item under that account, or no keychain on this machine */
    }
  }
  return null;
}

/** The `mdat` attribute out of what `security` prints. */
export function parseKeychainStamp(out: string): string | null {
  // `security` prints the date twice: as hex, then as text that carries a
  // trailing NUL inside its quotes. Read the text, and fall back to the hex.
  const m = /"mdat"<timedate>=(?:0x([0-9A-Fa-f]+))?\s*(?:"(\d{14}Z))?/.exec(out);
  if (!m) return null;
  const date = m[2] ?? m[1];
  return date ? `keychain:${date}` : null;
}

/** How long the refresh may take before the daemon gives up on it. */
const REFRESH_TIMEOUT_MS = 90_000;

/**
 * Make Claude Code refresh the credential store.
 *
 * This starts one fresh Claude Code process — no resume, no temporary config
 * directory — and asks it for one word. That process reads the real store,
 * which holds the refresh token; it refreshes the pair when the access token
 * is expired or near it, saves the new pair where every later session reads
 * it, and answers. The daemon reads nothing and writes nothing: the refresh
 * is Claude Code's own, exactly as under `claude -p`.
 *
 * It resolves when the process answered, which proves the store now holds a
 * token the API takes. It rejects with the process's own error text when it
 * did not: `isAuthFailure` on that text tells a dead refresh token, which only
 * `claude auth login` mends, from a fault of the network or the model.
 *
 * The process gets no tools, no settings and no transcript on disk, and none
 * of covey's own variables, so it can neither act nor be mistaken for a thread.
 */
export async function refreshCredentials(): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS);
  timer.unref?.();
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.COVEY_THREAD_ID;
  delete env.COVEY_PROJECT_ID;
  try {
    const q = query({
      prompt: "Reply with the one word OK.",
      options: {
        cwd: tmpdir(),
        model: "haiku",
        maxTurns: 1,
        tools: [],
        persistSession: false,
        settingSources: [],
        systemPrompt: "Reply with the one word OK.",
        permissionMode: "default",
        env,
        abortController: abort,
        stderr: () => {},
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.is_error) throw new Error(("result" in m && typeof m.result === "string" && m.result) || m.subtype);
      return;
    }
    throw new Error(abort.signal.aborted ? `the refresh did not finish in ${REFRESH_TIMEOUT_MS / 1000} seconds` : "the process ended without a result");
  } finally {
    clearTimeout(timer);
  }
}
