import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The credentials behind every session, and what happens when they change.
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
 * The daemon cannot refresh the token itself. A refresh *is* the rotation that
 * revokes what the other sessions hold, so a daemon that refreshed early would
 * cause the fault it means to prevent. What it can do is watch the store and
 * stop the sessions that went stale — `credentialStamp` — and know a failure
 * of the credentials from a failure of the work — `isAuthFailure`.
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
 * The macOS keychain item, read for its modification date alone. The token
 * itself stays in the keychain: the daemon has no use for it, and a secret it
 * never reads is a secret it cannot leak.
 *
 * The read takes about 40 ms and asks the user for nothing, because an
 * attribute is not the password. Two accounts can hold this service name, so
 * the user's own comes first and the plain lookup is the fallback.
 */
async function keychainStamp(): Promise<string | null> {
  const lookups: string[][] = [];
  try { lookups.push(["-a", userInfo().username]); } catch { /* no user name to ask by */ }
  lookups.push([]);
  for (const account of lookups) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", ...account], { timeout: 5_000 });
      const stamp = parseKeychainStamp(stdout);
      if (stamp) return stamp;
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
