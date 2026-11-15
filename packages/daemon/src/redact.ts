/**
 * Take a secret value back out of anything a session says — issue #126.
 *
 * Putting a secret in the session's environment keeps it out of the
 * conversation, but only until something prints it: a `printenv`, a script
 * that echoes its own command line, a library that logs the header it sent.
 * So every timeline item and every transcript line this daemon stores passes
 * through here first, and a value it finds becomes `[secret]`.
 *
 * This is not a sandbox. An agent told to print a value can still print it to
 * the screen of the tool that runs it; what this promises is narrower and
 * worth saying plainly — covey does not write the value down.
 *
 * **The marker names no secret.** It used to read `[secret NAME]`, and that
 * made it an oracle: a marker says a value stood in this exact place, so a
 * reader who can work out what stood there learns the value — and the name
 * told them which secret it was and what it was for. The reader very often
 * can. A pull request URL covey wrote reads
 * `https://github.com/[secret OWNER]/app/pull/37`, and anybody who looks the
 * repository up knows the owner. Note which way that runs: a credential is
 * never recoverable from the words around it, and a value that is also
 * ordinary text always is. The naming gave away exactly the values the length
 * rule below is least able to protect. Covey keeps the marker and drops the
 * name, so what is left to learn is that some string is a secret, not which.
 *
 * Nothing here runs for a thread with no secrets: `redactor` answers `null`
 * and the caller stores the item it already had.
 */

/** What a value becomes. It names no secret; see the note above. */
export const SECRET_MARKER = "[secret]";

/**
 * A value this long is replaced wherever it stands. A shorter one is replaced
 * only where it stands as a whole token.
 *
 * There used to be no second rule: a value shorter than this was left alone
 * altogether, and the secrets panel promised a redaction covey did not make.
 * A reader who sets `PIN` to four digits means it, and covey writing it down
 * is the one failure this file exists to prevent. So a short value is
 * redacted too, and the token rule is what makes that bearable: `abcd` inside
 * `some/path/abcd/world` is a piece of a path and not the value — replacing
 * it would cost the reader a line they need and tell nobody anything, since
 * the rest of the path says what stood there.
 */
export const WHOLE_TOKEN_BELOW = 8;

/**
 * The characters that carry a word, a path, a file name, a domain or a
 * version on. A short value stands as a whole token when neither side of the
 * match is one of these — so `PIN=1234` and `"1234"` are replaced, and
 * `v1.1234.0` is not.
 */
const TOKEN = /[A-Za-z0-9_\-./\\@+~]/;

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
 *
 * `keep` is covey's own bookkeeping, held out of the way: a string covey
 * already stores in the clear, which a value may be part of. The repository's
 * identity is the one that matters — the `projects` table holds
 * `github.com/owner/repo` whole, so redacting the owner out of a URL covey
 * itself wrote down writes nothing new away, costs the reader a link that
 * opens, and is the oracle described above at its plainest. This is
 * `keepFilePaths`' rule for a text covey wrote rather than for a field, and
 * the two overlap: a path in the thread's store starts with that same
 * identity. They are not one decision. This one says the repository's name is
 * public; that one says a file covey put in the store is covey's own.
 */
export function redactor(env: Record<string, string>, keep: string[] = []): ((s: string) => string) | null {
  // Whitespace alone is no credential, and a value of one space would make a
  // marker of every gap between two words.
  const pairs = Object.entries(env)
    .filter(([, v]) => v.trim().length > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (pairs.length === 0) return null;
  // Longest first here too, so a kept string inside another is not cut in two.
  const kept = [...new Set(keep.filter(Boolean))].sort((a, b) => b.length - a.length);
  const replace = (s: string) => {
    // A marker this puts in is final, and no later value is looked for inside
    // it. The eight-character floor used to make that impossible: `[secret]`
    // is eight characters, so nothing short enough to sit inside one was
    // looked for at all. With every value looked for, a reader whose secret is
    // `secret` would have read `[[secret]]` — untidy rather than unsafe, but
    // it is covey's own text and no value of the reader's.
    let segs: Segment[] = [{ text: s, done: false }];
    for (const [, value] of pairs) {
      if (!segs.some((g) => !g.done && g.text.includes(value))) continue;
      segs = segs.flatMap((g) => (g.done ? [g] : cut(g.text, value)));
    }
    return segs.map((g) => g.text).join("");
  };
  return (s: string) => {
    // The common string holds none of covey's own bookkeeping, and then this
    // costs one `includes` per kept string and nothing else.
    if (!kept.some((k) => s.includes(k))) return replace(s);
    return segments(s, kept).map((seg) => (seg.kept ? seg.text : replace(seg.text))).join("");
  };
}

/** `s` cut into the runs covey vouches for and the runs between them. */
function segments(s: string, kept: string[]): { text: string; kept: boolean }[] {
  let out: { text: string; kept: boolean }[] = [{ text: s, kept: false }];
  for (const k of kept) {
    const next: { text: string; kept: boolean }[] = [];
    for (const seg of out) {
      if (seg.kept || !seg.text.includes(k)) { next.push(seg); continue; }
      seg.text.split(k).forEach((bit, i) => {
        if (i) next.push({ text: k, kept: true });
        if (bit) next.push({ text: bit, kept: false });
      });
    }
    out = next;
  }
  return out;
}

/** A run of text, and whether redaction is finished with it. */
interface Segment { text: string; done: boolean }

/**
 * `s` cut on `value`: every occurrence replaced by a marker nothing may reach
 * into — or, for a value short enough to turn up by chance, every occurrence
 * that stands as a whole token.
 */
function cut(s: string, value: string): Segment[] {
  const anywhere = value.length >= WHOLE_TOKEN_BELOW;
  const out: Segment[] = [];
  // Where the text not yet emitted starts, which a match covey passes over
  // does not move.
  let from = 0;
  for (let at = s.indexOf(value); at >= 0; at = s.indexOf(value, at + value.length)) {
    const end = at + value.length;
    if (!anywhere && (TOKEN.test(s[at - 1] ?? "") || TOKEN.test(s[end] ?? ""))) continue;
    if (at > from) out.push({ text: s.slice(from, at), done: false });
    out.push({ text: SECRET_MARKER, done: true });
    from = end;
  }
  if (from < s.length) out.push({ text: s.slice(from), done: false });
  return out;
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

/**
 * The fields of a timeline item that carry files covey wrote itself: the
 * attachments of a message, and the files of a `covey show` note.
 */
const FILE_FIELDS = ["attachments", "files"] as const;

/**
 * `redacted` with the file paths of `raw` put back, for every file the thread
 * really holds.
 *
 * A stored attachment's `path` is covey's own bookkeeping and never a
 * session's words: the daemon writes the bytes into the thread's file store
 * and records where it put them. A project directory can carry a secret value
 * in its name — a repository owned by an account that is also a login, say —
 * and the path would then become `/…/[secret NAME]/…`. The `/file` route
 * refuses a path outside the store, so the picture the reader clicks is a
 * refusal instead of a picture.
 *
 * `held` is what keeps that narrow. Not every attachment is in the store: one
 * sent with no inline bytes keeps the path it came with
 * (`materialiseAttachments`), and that path is anywhere on the machine. A path
 * outside the store buys no picture — the route refuses it however it is
 * spelled — so it stays as the redaction made it, and the promise here is the
 * whole truth: the only value this writes down is part of the store's own
 * root, which is the thread's worktree, and the `threads` table carries that
 * whole.
 */
export function keepFilePaths<T>(redacted: T, raw: T, held: (path: string) => boolean): T {
  if (redacted === raw || !redacted || typeof redacted !== "object") return redacted;
  let out = redacted as Record<string, unknown>;
  for (const field of FILE_FIELDS) {
    const red = out[field];
    const src = (raw as Record<string, unknown>)[field];
    if (!Array.isArray(red) || !Array.isArray(src) || red.length !== src.length) continue;
    let changed = false;
    const files = red.map((f, i) => {
      const path = (src[i] as { path?: unknown } | undefined)?.path;
      if (!f || typeof f !== "object" || typeof path !== "string" || (f as { path?: unknown }).path === path) return f;
      // The question is asked only for a path the walk rewrote, so a thread
      // with no secrets and an item with nothing in the store pay nothing.
      if (!held(path)) return f;
      changed = true;
      return { ...(f as object), path };
    });
    if (changed) out = { ...out, [field]: files };
  }
  return out as T;
}

/**
 * A marker an older covey left behind, and the name inside it.
 *
 * Nothing writes this form now — a marker names no secret (see the note at the
 * top). It is read, and only here, because the items on disk from before that
 * change carry it.
 */
const MARKER = /\[secret ([A-Za-z_][A-Za-z0-9_]*)\]/g;

/**
 * A function that puts the values back into a string an older covey redacted,
 * or `null` when this environment holds nothing to put back.
 *
 * One route needs this and no other: a client asks the `/file` route for a
 * path it read off a timeline item, and an item written before `keepFilePaths`
 * carries a named marker in place of a directory. The route still resolves the
 * answer against the thread's own store, so this gives a client no path it
 * could not already name.
 *
 * `WHOLE_TOKEN_BELOW` is the rule those items were written under — a shorter
 * value was left alone then — so a name standing for one now cannot have been
 * what covey replaced, and the marker stays as it is.
 *
 * A marker covey writes today carries nothing to put back, which costs this
 * route nothing: `keepFilePaths` keeps the path of a file in the store, and a
 * path outside it is refused however it is spelled.
 *
 * One pass, so a value that holds a marker of its own is never read again.
 */
export function unredactor(env: Record<string, string>): ((s: string) => string) | null {
  const values = new Map(Object.entries(env).filter(([, v]) => v.length >= WHOLE_TOKEN_BELOW));
  if (values.size === 0) return null;
  return (s: string) => {
    MARKER.lastIndex = 0;
    return s.replace(MARKER, (whole, key: string) => values.get(key) ?? whole);
  };
}
