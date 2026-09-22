/**
 * Take a secret value back out of anything a session says — issue #126.
 *
 * Putting a secret in the session's environment keeps it out of the
 * conversation, but only until something prints it: a `printenv`, a script
 * that echoes its own command line, a library that logs the header it sent.
 * So every timeline item and every transcript line this daemon stores passes
 * through here first, and a value it finds becomes `[secret NAME]`.
 *
 * This is not a sandbox. An agent told to print a value can still print it to
 * the screen of the tool that runs it; what this promises is narrower and
 * worth saying plainly — covey does not write the value down.
 *
 * Nothing here runs for a thread with no secrets: `redactor` answers `null`
 * and the caller stores the item it already had.
 */

/**
 * A value shorter than this is left alone.
 *
 * A short string turns up by chance — in prose, in a uuid, in a path — and
 * replacing every `abcd` in a transcript would cost the reader far more than
 * it protects. Real credentials are longer than this; the editor says so when
 * a short one is set.
 */
export const MIN_REDACTED_LENGTH = 8;

/**
 * Fields whose contents are covey's own bookkeeping, never a session's words.
 * Skipping them keeps an id or a timestamp from being rewritten by a secret
 * that happens to be a substring of it.
 */
const SKIP = new Set([
  "id", "threadId", "turnId", "toolUseId", "requestId", "seq", "kind",
  "createdAt", "updatedAt", "uuid", "parentUuid", "sessionId", "timestamp",
]);

/**
 * A function that replaces every secret value in a string, or `null` when
 * this environment holds nothing worth replacing.
 *
 * Longest value first, so a value that contains a shorter one is replaced
 * whole rather than left in pieces.
 */
export function redactor(env: Record<string, string>): ((s: string) => string) | null {
  const pairs = Object.entries(env)
    .filter(([, v]) => v.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (pairs.length === 0) return null;
  return (s: string) => {
    let out = s;
    for (const [key, value] of pairs) {
      if (out.includes(value)) out = out.split(value).join(`[secret ${key}]`);
    }
    return out;
  };
}

/**
 * The same value with every string in it redacted. The object comes back
 * unchanged, by identity, when no string held a secret — which is the common
 * case even on a thread that has them, and it keeps the store from writing a
 * new object for every item.
 */
export function redactDeep<T>(value: T, redact: (s: string) => string): T {
  return walk(value, redact) as T;
}

function walk(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = walk(v, redact);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = SKIP.has(k) ? v : walk(v, redact);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}
