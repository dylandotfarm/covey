import type { SessionStore, SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";

/**
 * SDK SessionStore backed by our SQLite db.
 *
 * The SDK mirrors every transcript line here (after writing its own local
 * JSONL). On `resume`, the SDK calls `load()` and materialises a temp JSONL for
 * the subprocess — which means a session imported from ANOTHER machine resumes
 * fine even though no local ~/.claude/projects/<slug>/<id>.jsonl exists.
 *
 * We use a single fixed projectKey per thread (the thread id) so the key does
 * not depend on the cwd, which differs across machines.
 */
export function makeSessionStore(db: Db): SessionStore {
  return {
    async append(key: SessionKey, entries) {
      db.appendTranscript(key.projectKey, key.sessionId, key.subpath ?? "", entries as Record<string, unknown>[]);
    },
    async load(key: SessionKey) {
      return db.loadTranscript(key.projectKey, key.sessionId, key.subpath ?? "") as SessionStoreEntry[] | null;
    },
    async listSessions(projectKey: string) {
      return db.listTranscriptSessions(projectKey);
    },
  };
}
