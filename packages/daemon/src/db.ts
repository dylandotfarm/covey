import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Project,
  Thread,
  TimelineItem,
  ShellEvent,
  ThreadEvent,
  ShellEventBody,
} from "@covey/protocol";

/**
 * SQLite persistence using Node's built-in sqlite (no native deps).
 *
 * Tables:
 *  projects / threads / items       — current state (projections)
 *  shell_events / thread_events     — append log with seq for replay
 *  transcripts                      — SDK SessionStore mirror (raw JSONL rows)
 *  command_receipts                 — idempotency for retried commands
 */
/** Take over the database that the previous name of this program wrote. The
 *  checkpoint empties the write-ahead log first, so the move keeps every turn
 *  that the old name recorded. */
function adoptOldDb(dir: string): void {
  const to = join(dir, "covey.db");
  const from = join(dir, "matui.db");
  if (existsSync(to) || !existsSync(from)) return;
  const old = new DatabaseSync(from);
  old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  old.close();
  renameSync(from, to);
  for (const ext of ["-wal", "-shm"]) rmSync(from + ext, { force: true });
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    adoptOldDb(dir);
    this.sql = new DatabaseSync(join(dir, "covey.db"));
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
        json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_thread_seq ON items(thread_id, seq);
      CREATE TABLE IF NOT EXISTS shell_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_events (
        thread_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq));
      CREATE TABLE IF NOT EXISTS thread_seq (
        thread_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transcripts (
        project_key TEXT NOT NULL, session_id TEXT NOT NULL, subpath TEXT NOT NULL DEFAULT '',
        ord INTEGER NOT NULL, uuid TEXT, json TEXT NOT NULL, mtime INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS transcripts_key ON transcripts(project_key, session_id, subpath, ord);
      CREATE UNIQUE INDEX IF NOT EXISTS transcripts_uuid
        ON transcripts(project_key, session_id, subpath, uuid) WHERE uuid IS NOT NULL;
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_checkpoints (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, before_tree TEXT, after_tree TEXT,
        cwd TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id));
    `);
    const cols = (this.sql.prepare("PRAGMA table_info(turn_checkpoints)").all() as any[]).map((c) => c.name);
    if (!cols.includes("user_message_uuid")) this.sql.exec("ALTER TABLE turn_checkpoints ADD COLUMN user_message_uuid TEXT");
  }

  private txDepth = 0;
  /** Re-entrant: nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) { this.txDepth++; try { return fn(); } finally { this.txDepth--; } }
    this.sql.exec("BEGIN");
    this.txDepth = 1;
    try {
      const r = fn();
      this.sql.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // ---- projects -----------------------------------------------------------
  listProjects(): Project[] {
    return this.sql.prepare("SELECT json FROM projects ORDER BY updated_at DESC").all()
      .map((r: any) => JSON.parse(r.json));
  }
  getProject(id: string): Project | null {
    const r: any = this.sql.prepare("SELECT json FROM projects WHERE id = ?").get(id);
    return r ? JSON.parse(r.json) : null;
  }
  putProject(p: Project) {
    this.sql.prepare("INSERT OR REPLACE INTO projects(id,json,updated_at) VALUES(?,?,?)")
      .run(p.id, JSON.stringify(p), p.updatedAt);
  }
  deleteProject(id: string) {
    this.sql.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---- threads ------------------------------------------------------------
  listThreads(): Thread[] {
    return this.sql.prepare("SELECT json FROM threads ORDER BY updated_at DESC").all()
      .map((r: any) => JSON.parse(r.json));
  }
  getThread(id: string): Thread | null {
    const r: any = this.sql.prepare("SELECT json FROM threads WHERE id = ?").get(id);
    return r ? JSON.parse(r.json) : null;
  }
  putThread(t: Thread) {
    this.sql.prepare(
      "INSERT OR REPLACE INTO threads(id,project_id,session_id,json,updated_at) VALUES(?,?,?,?,?)",
    ).run(t.id, t.projectId, t.sessionId, JSON.stringify(t), t.updatedAt);
  }
  deleteThread(id: string) {
    this.sql.prepare("DELETE FROM items WHERE thread_id = ?").run(id);
    this.sql.prepare("DELETE FROM thread_events WHERE thread_id = ?").run(id);
    this.sql.prepare("DELETE FROM thread_seq WHERE thread_id = ?").run(id);
    this.sql.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  // ---- items --------------------------------------------------------------
  listItems(threadId: string, limit = 200, beforeSeq?: number): { items: TimelineItem[]; hasMore: boolean } {
    const rows = (beforeSeq === undefined
      ? this.sql.prepare("SELECT json FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT ?")
          .all(threadId, limit + 1)
      : this.sql.prepare("SELECT json FROM items WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
          .all(threadId, beforeSeq, limit + 1)) as any[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map((r) => JSON.parse(r.json) as TimelineItem);
    return { items, hasMore };
  }
  getItem(id: string): TimelineItem | null {
    const r: any = this.sql.prepare("SELECT json FROM items WHERE id = ?").get(id);
    return r ? JSON.parse(r.json) : null;
  }
  putItem(item: TimelineItem) {
    this.sql.prepare("INSERT OR REPLACE INTO items(id,thread_id,seq,json) VALUES(?,?,?,?)")
      .run(item.id, item.threadId, item.seq, JSON.stringify(item));
  }
  deleteItem(id: string) {
    this.sql.prepare("DELETE FROM items WHERE id = ?").run(id);
  }
  allItems(threadId: string): TimelineItem[] {
    return (this.sql.prepare("SELECT json FROM items WHERE thread_id = ? ORDER BY seq ASC").all(threadId) as any[])
      .map((r) => JSON.parse(r.json));
  }

  // ---- event logs ---------------------------------------------------------
  appendShellEvent(ev: ShellEventBody): ShellEvent {
    const r: any = this.sql.prepare("INSERT INTO shell_events(json) VALUES(?) RETURNING seq").get(JSON.stringify(ev));
    const full = { ...ev, seq: Number(r.seq) } as ShellEvent;
    this.sql.prepare("UPDATE shell_events SET json = ? WHERE seq = ?").run(JSON.stringify(full), full.seq);
    return full;
  }
  shellSeq(): number {
    const r: any = this.sql.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM shell_events").get();
    return Number(r.s);
  }
  shellEventsAfter(seq: number, limit = 5000): ShellEvent[] {
    return (this.sql.prepare("SELECT json FROM shell_events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as any[])
      .map((r) => JSON.parse(r.json));
  }
  nextThreadSeq(threadId: string): number {
    const r: any = this.sql.prepare(
      `INSERT INTO thread_seq(thread_id, seq) VALUES(?, 1)
       ON CONFLICT(thread_id) DO UPDATE SET seq = seq + 1 RETURNING seq`,
    ).get(threadId);
    return Number(r.seq);
  }
  threadSeq(threadId: string): number {
    const r: any = this.sql.prepare("SELECT seq FROM thread_seq WHERE thread_id = ?").get(threadId);
    return r ? Number(r.seq) : 0;
  }
  appendThreadEvent(threadId: string, ev: ThreadEvent) {
    this.sql.prepare("INSERT OR REPLACE INTO thread_events(thread_id,seq,json) VALUES(?,?,?)")
      .run(threadId, ev.seq, JSON.stringify(ev));
    // keep the log bounded; items table is the durable truth
    this.sql.prepare(
      "DELETE FROM thread_events WHERE thread_id = ? AND seq < (SELECT MAX(seq) - 2000 FROM thread_events WHERE thread_id = ?)",
    ).run(threadId, threadId);
  }
  threadEventsAfter(threadId: string, seq: number): ThreadEvent[] | null {
    const oldest: any = this.sql.prepare("SELECT MIN(seq) AS s FROM thread_events WHERE thread_id = ?").get(threadId);
    if (oldest?.s != null && seq + 1 < Number(oldest.s)) return null; // gap too large → resnapshot
    return (this.sql.prepare("SELECT json FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq").all(threadId, seq) as any[])
      .map((r) => JSON.parse(r.json));
  }

  // ---- command receipts ---------------------------------------------------
  receipt(commandId: string): number | null {
    const r: any = this.sql.prepare("SELECT seq FROM command_receipts WHERE command_id = ?").get(commandId);
    return r ? Number(r.seq) : null;
  }
  putReceipt(commandId: string, seq: number) {
    this.sql.prepare("INSERT OR IGNORE INTO command_receipts(command_id,seq,at) VALUES(?,?,?)")
      .run(commandId, seq, new Date().toISOString());
  }

  // ---- turn checkpoints ---------------------------------------------------
  putCheckpoint(c: { threadId: string; turnId: string; beforeTree: string | null; afterTree: string | null; cwd: string; userMessageUuid?: string | null }) {
    const prev = this.getCheckpoint(c.threadId, c.turnId);
    this.sql.prepare(
      "INSERT OR REPLACE INTO turn_checkpoints(thread_id,turn_id,before_tree,after_tree,cwd,at,user_message_uuid) VALUES(?,?,?,?,?,?,?)",
    ).run(c.threadId, c.turnId, c.beforeTree, c.afterTree, c.cwd, prev?.at ?? new Date().toISOString(), c.userMessageUuid ?? prev?.userMessageUuid ?? null);
  }
  getCheckpoint(threadId: string, turnId?: string): { turnId: string; beforeTree: string | null; afterTree: string | null; cwd: string; at: string; userMessageUuid: string | null } | null {
    const sel = "SELECT turn_id AS turnId, before_tree AS beforeTree, after_tree AS afterTree, cwd, at, user_message_uuid AS userMessageUuid FROM turn_checkpoints";
    const r: any = turnId
      ? this.sql.prepare(`${sel} WHERE thread_id=? AND turn_id=?`).get(threadId, turnId)
      : this.sql.prepare(`${sel} WHERE thread_id=? AND after_tree IS NOT NULL ORDER BY at DESC LIMIT 1`).get(threadId);
    return r ?? null;
  }
  checkpointsAfter(threadId: string, at: string): { turnId: string }[] {
    return this.sql.prepare("SELECT turn_id AS turnId FROM turn_checkpoints WHERE thread_id=? AND at>=? ORDER BY at").all(threadId, at) as any[];
  }
  deleteCheckpoint(threadId: string, turnId: string) {
    this.sql.prepare("DELETE FROM turn_checkpoints WHERE thread_id=? AND turn_id=?").run(threadId, turnId);
  }
  /** Delete items with seq >= fromSeq; returns their ids. */
  deleteItemsFrom(threadId: string, fromSeq: number): string[] {
    const ids = (this.sql.prepare("SELECT id FROM items WHERE thread_id=? AND seq>=?").all(threadId, fromSeq) as any[]).map((r) => r.id as string);
    this.sql.prepare("DELETE FROM items WHERE thread_id=? AND seq>=?").run(threadId, fromSeq);
    return ids;
  }
  /** True if the main transcript still contains conversation messages. */
  transcriptHasMessages(projectKey: string, sessionId: string): boolean {
    const r: any = this.sql.prepare(
      "SELECT COUNT(*) AS n FROM transcripts WHERE project_key=? AND session_id=? AND subpath='' AND json_extract(json,'$.type') IN ('user','assistant')",
    ).get(projectKey, sessionId);
    return Number(r.n) > 0;
  }

  /** Drop transcript rows from the entry with `uuid` onward (all subpaths' main file only). */
  truncateTranscriptAt(projectKey: string, sessionId: string, uuid: string): number {
    const r: any = this.sql.prepare("SELECT ord FROM transcripts WHERE project_key=? AND session_id=? AND subpath='' AND uuid=?").get(projectKey, sessionId, uuid);
    if (!r) return 0;
    const res = this.sql.prepare("DELETE FROM transcripts WHERE project_key=? AND session_id=? AND subpath='' AND ord>=?").run(projectKey, sessionId, r.ord);
    return Number(res.changes);
  }
  /** User items still carrying a delivery flag — a restart has to clear both. */
  flaggedUserItems(threadId: string, flag: "queued" | "folded"): TimelineItem[] {
    return (this.sql.prepare(`SELECT json FROM items WHERE thread_id=? AND json_extract(json,'$.kind')='user' AND json_extract(json,'$.${flag}')=1 ORDER BY seq`).all(threadId) as any[]).map((r) => JSON.parse(r.json));
  }

  // ---- transcripts (SDK session store mirror) -----------------------------
  appendTranscript(projectKey: string, sessionId: string, subpath: string, entries: Record<string, unknown>[]) {
    const now = Date.now();
    const ins = this.sql.prepare(
      `INSERT OR IGNORE INTO transcripts(project_key,session_id,subpath,ord,uuid,json,mtime)
       VALUES(?,?,?,(SELECT COALESCE(MAX(ord),0)+1 FROM transcripts WHERE project_key=? AND session_id=? AND subpath=?),?,?,?)`,
    );
    this.transaction(() => {
      for (const e of entries) {
        ins.run(projectKey, sessionId, subpath, projectKey, sessionId, subpath,
          typeof e.uuid === "string" ? e.uuid : null, JSON.stringify(e), now);
      }
    });
  }
  loadTranscript(projectKey: string, sessionId: string, subpath: string): Record<string, unknown>[] | null {
    const rows = this.sql.prepare(
      "SELECT json FROM transcripts WHERE project_key=? AND session_id=? AND subpath=? ORDER BY ord",
    ).all(projectKey, sessionId, subpath) as any[];
    if (rows.length === 0) return null;
    return rows.map((r) => JSON.parse(r.json));
  }
  transcriptSubpaths(sessionId: string): { projectKey: string; subpath: string }[] {
    return this.sql.prepare(
      "SELECT DISTINCT project_key AS projectKey, subpath FROM transcripts WHERE session_id=?",
    ).all(sessionId) as any[];
  }
  listTranscriptSessions(projectKey: string): { sessionId: string; mtime: number }[] {
    return this.sql.prepare(
      "SELECT session_id AS sessionId, MAX(mtime) AS mtime FROM transcripts WHERE project_key=? AND subpath='' GROUP BY session_id",
    ).all(projectKey) as any[];
  }
  deleteTranscript(sessionId: string) {
    this.sql.prepare("DELETE FROM transcripts WHERE session_id=?").run(sessionId);
  }
}
