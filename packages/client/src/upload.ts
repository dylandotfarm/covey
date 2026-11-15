/**
 * A file too big to carry inline, and the one question covey asks about it.
 *
 * Under `MAX_ATTACHMENT_BYTES` a drop rides in the `turn.send` frame and costs
 * nobody anything they would notice. Over it the file goes to `POST /upload`
 * on the daemon that holds the thread, and that is a different act: minutes of
 * a mobile link, and megabytes left in the worktree until the thread goes. So
 * the reader is asked first, every time, on every client.
 *
 * The *words* of that question are here, pure and node-tested, because three
 * clients ask it and three copies of a sentence is how "2 automated reviews
 * hidden" and "2 hidden now" came to describe the same two threads
 * (`hiddenPanel` is the same rule). The *asking* is each client's own: a pick
 * overlay in the terminal, `confirm` on the page, an `Alert` on the phone. So
 * is the upload itself, because only the platform knows how to stream a file
 * it holds — a path, a `File`, or a `content://` URI.
 */
import { MAX_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES } from "@covey/protocol";
import { megabytes, type FailedDrop } from "./attach.js";

/** One file that needs the reader's word, as the question needs to read it. */
export interface LargeFile {
  name: string;
  /** Bytes, as the picker reported them. */
  size: number;
}

/** The question a client puts to the reader about a drop it cannot carry inline. */
export interface LargeDropPrompt {
  /** The question itself: one file by name and its size, or how many and how much. */
  title: string;
  /** Why covey asks, and what a yes costs. Several files are named here. */
  detail: string;
  /**
   * The same in one line, for a client whose answer is one row — the TUI's
   * pick, where a long hint truncates the label it sits beside away. It keeps
   * the half a reader cannot work out for themselves: where the file goes, and
   * that the agent is told about it.
   */
  short: string;
  /** What the yes reads as. Never "OK": a reader skims the verb. */
  accept: string;
}

/**
 * The question to ask about `files`, or null when there is nothing to ask.
 *
 * Null for an empty list, so a caller can ask this first and go straight on
 * when every file of the drop fits inline — which is nearly every drop.
 */
export function largeDropPrompt(files: LargeFile[]): LargeDropPrompt | null {
  if (files.length === 0) return null;
  const total = files.reduce((n, f) => n + f.size, 0);
  const one = files.length === 1 ? files[0]! : null;
  const title = one
    ? `Send ${one.name} (${megabytes(one.size)} MB)?`
    : `Send ${files.length} files (${megabytes(total)} MB)?`;
  // The names go in the detail rather than the title: a title is one row on
  // every one of the three clients, and a list of names is what pushes the
  // size — the number the reader is deciding on — off the end of it.
  const named = one ? "" : `${files.map((f) => `${f.name} (${megabytes(f.size)} MB)`).join(", ")}. `;
  // "this message is over it" and never "that file is over it": a client counts
  // the whole message against the cap, so a 20 MB file picked beside another
  // 20 MB one takes this route while being under the cap itself. The sentence
  // has to be true of every file it is shown about, and the title already
  // carries the number the reader is deciding on.
  return {
    title,
    detail: `${named}A message carries ${megabytes(MAX_ATTACHMENT_BYTES)} MB without asking and this one is over that, so ${one ? "it goes" : "they go"} to the machine as an upload: it takes as long as the link takes, and ${one ? "it stays" : "they stay"} in the thread's working directory until the thread goes. covey tells the agent the file is large, and tells it not to commit one.`,
    short: "uploaded to the machine; covey tells the agent not to commit it",
    accept: files.length === 1 ? "Send it" : "Send them",
  };
}

/**
 * Split a drop into the files to ask about and the files already going up.
 *
 * A chip is the only record of a file and there is no chip until the bytes
 * land, so between the yes and the answer `revealDrop` has nothing to match:
 * a second paste of that path reads as a fresh drop, and at this size that is
 * the whole file over the link twice and a `clip-2.mp4` nobody asked for. The
 * path a file is read from is the identity, not the chunk the reader pasted,
 * because the same file reaches the composer by several spellings — whole, cut
 * in two, or copied in a file manager.
 *
 * Here rather than in a client, because it is a rule and not a gesture, and
 * because every client has the same window.
 */
export function splitInFlight<T extends { name: string; path: string }>(
  files: readonly T[],
  inFlight: ReadonlySet<string>,
): { waiting: T[]; already: T[] } {
  const waiting: T[] = [];
  const already: T[] = [];
  for (const f of files) (inFlight.has(f.path) ? already : waiting).push(f);
  return { waiting, already };
}

/** What to tell a reader who dropped a file that is already on its way. */
export function inFlightNotice(already: readonly { name: string }[]): string {
  if (already.length === 1) return `${already[0]!.name} is already on its way to the machine`;
  return `${already.length} of those files are already on their way to the machine`;
}

/**
 * A file over the ceiling, in the reader's words — the one size covey refuses
 * however willing the reader is.
 *
 * Shared, unlike each client's own sentence for a file that merely needs
 * asking about, because this one says the same thing everywhere: there is no
 * route for it, and the way through is to put the file on the machine and name
 * it. That is #132's rule — the reader is told which of the problems this is
 * and what to do about it.
 */
export function tooLargeToUpload(name: string, size: number): FailedDrop {
  const limit = `${megabytes(MAX_UPLOAD_BYTES)} MB`;
  return {
    name,
    chip: `${megabytes(size)} MB, over the ${limit} limit`,
    message: `${name} is ${megabytes(size)} MB, over the ${limit} covey carries at all. Put it on the machine the thread runs on and tell the agent where it is.`,
  };
}

/**
 * Where a large file goes: `POST /upload` on the daemon that holds the thread.
 *
 * `base` is that machine's socket URL as an HTTP origin, with the token on it
 * when the client dials with one (`httpBaseFor` in the TUI, `httpBase` on the
 * page) — the same base `/file` is read from, because one listener answers
 * both and the credentials are already right.
 *
 * The name is a hint and not a promise: the store renames a second `clip.mp4`
 * rather than overwrite the first, and the route answers with the path it
 * actually wrote.
 */
export function uploadUrl(base: string, threadId: string, name: string): string {
  const cut = base.indexOf("?");
  const origin = (cut < 0 ? base : base.slice(0, cut)).replace(/\/+$/, "");
  const q = new URLSearchParams(cut < 0 ? "" : base.slice(cut + 1));
  q.set("thread", threadId);
  q.set("name", name);
  return `${origin}/upload?${q.toString()}`;
}

/** What the composer says while a large file goes up, with the share of it that has. */
export function uploadingLabel(name: string, sent?: number, total?: number): string {
  if (sent === undefined || !total) return `uploading ${name}…`;
  return `uploading ${name} — ${Math.min(100, Math.round((sent / total) * 100))}%`;
}

/**
 * What the route answers: the path it wrote, which is the path the attachment
 * then carries with no `data` beside it.
 */
export interface UploadAnswer {
  /** Absolute path of the copy, inside that thread's own file store. */
  path: string;
  /** What the store called it, which is the asked-for name unless one was taken. */
  name: string;
}

/** Read the route's answer, or throw a sentence a composer can show. */
export function readUploadAnswer(status: number, body: string): UploadAnswer {
  if (status !== 200) {
    const said = body.trim().split("\n")[0] ?? "";
    throw new Error(said || `the machine answered ${status} to the upload`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("the machine's answer to the upload was not readable"); }
  const a = parsed as Partial<UploadAnswer>;
  if (!a || typeof a.path !== "string" || !a.path) throw new Error("the machine's answer to the upload named no file");
  return { path: a.path, name: typeof a.name === "string" && a.name ? a.name : a.path };
}
