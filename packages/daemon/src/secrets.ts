/**
 * The environment a thread works in — issue #126.
 *
 * A project holds a set of names and values. A thread may hold its own, which
 * hide the project's names of the same spelling. The daemon puts the merged
 * set into the environment of the Claude session it starts, so a tool call, a
 * script the agent writes and a `curl` it runs all read `$STRIPE_KEY` the way
 * they read `$PATH`.
 *
 * A value goes to three places and no others:
 *
 *  1. the environment of a session (`Engine.startSession`);
 *  2. the redactor, which takes the value back out of anything a session says
 *     (`redact.ts`);
 *  3. `covey env exec`, over loopback, on the machine that runs the work.
 *
 * Nothing here reaches a command, an event, a snapshot or an export. What
 * those carry is the name, which is not a secret and which the editor and the
 * agent both need.
 *
 * This file is pure: it reads and writes through a `Db` and nothing else.
 */
import type { SecretEntry, SecretScope, SecretWrite } from "@covey/protocol";
import { secretKeyError } from "@covey/protocol";
import type { Db } from "./db.js";

/**
 * Apply every write to one scope. A `value` of `null` takes the name away;
 * anything else is stored as it was given, with no trimming — trailing space
 * in a token is the caller's business and stripping it would break a value
 * that needs it.
 *
 * Returns the names that scope holds afterwards, which is what goes on the
 * `Project` or the `Thread`. Throws the first bad name as a sentence, so
 * nothing is half-written.
 */
export function applySecretWrites(
  db: Db,
  scope: SecretScope,
  ownerId: string,
  writes: SecretWrite[],
  at: string,
): string[] {
  for (const w of writes) {
    const bad = secretKeyError(String(w?.key ?? ""));
    if (bad) throw new Error(bad);
  }
  db.transaction(() => {
    for (const w of writes) {
      if (w.value === null) db.removeSecret(scope, ownerId, w.key);
      else db.putSecret(scope, ownerId, w.key, String(w.value), at);
    }
  });
  return db.secretKeys(scope, ownerId);
}

/**
 * The environment of one thread: its project's names, with the thread's own
 * written over them. The order is the whole rule — a thread that sets a name
 * the project also sets gets its own value.
 */
export function threadEnv(db: Db, projectId: string, threadId: string): Record<string, string> {
  return { ...db.secretValues("project", projectId), ...db.secretValues("thread", threadId) };
}

/**
 * The same merge, as names alone with where each came from. This is what
 * `secrets.list` answers and what `covey env` prints.
 */
export function threadSecretList(db: Db, projectId: string, threadId: string): SecretEntry[] {
  const project = db.secretRows("project", projectId);
  const thread = db.secretRows("thread", threadId);
  const hidden = new Set(thread.map((r) => r.key));
  const out: SecretEntry[] = [
    ...thread.map((r) => ({ key: r.key, scope: "thread" as const, updatedAt: r.updatedAt, ...(hiddenBy(project, r.key) ? { overrides: true } : {}) })),
    ...project.filter((r) => !hidden.has(r.key)).map((r) => ({ key: r.key, scope: "project" as const, updatedAt: r.updatedAt })),
  ];
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A project's own names, for `secrets.list` with no thread. */
export function projectSecretList(db: Db, projectId: string): SecretEntry[] {
  return db.secretRows("project", projectId).map((r) => ({ key: r.key, scope: "project" as const, updatedAt: r.updatedAt }));
}

function hiddenBy(rows: { key: string }[], key: string): boolean {
  return rows.some((r) => r.key === key);
}
