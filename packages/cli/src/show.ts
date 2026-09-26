/**
 * `covey show`: put a picture or a video in the conversation — issue #160.
 *
 * An agent makes a screenshot, a chart or a recording, and until now the only
 * way to let a person look at it was to put it on a pull request. This is the
 * other route: the daemon copies the file into the thread's file store and
 * writes one note that carries it, so the phone paints it inline and the TUI
 * links it into a browser. Nothing reaches GitHub and nothing is committed.
 *
 * The daemon reads the path, so the path must be on the daemon's machine —
 * which is the machine the agent runs on. `thread.showFiles` therefore answers
 * a loopback connection only, as `secrets.env` does.
 *
 * `parseShowArgs` is pure, so a test can prove what each spelling asks for
 * without a daemon.
 */
import { basename, resolve } from "node:path";
import { MAX_SHOWN_FILES, PROTOCOL_VERSION } from "@covey/protocol";
import { LOOP_CLIENT, openRpc, type Rpc } from "./loop.js";

/** What one `covey show …` asks for. */
export interface ShowRequest {
  /** One line naming what the files show. Empty when the agent gave none. */
  text: string;
  files: { name: string; path: string }[];
}

export const SHOW_USAGE = `  covey show <file>... [--text "…"]
                             put a picture or a video in this conversation. The file is
                             copied into the thread's own files and served by this machine:
                             it shows inline on a phone, and the TUI links it to a browser.
                             Nothing goes to GitHub — use \`covey pr open --attach\` for that`;

/**
 * Read `covey show …`. An error is a sentence for the shell, never a throw.
 */
export function parseShowArgs(argv: string[]): { request: ShowRequest } | { error: string } {
  const rest = argv.slice(1);
  let text = "";
  const files: { name: string; path: string }[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--text") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) return { error: "--text needs one line of words, for example --text \"the composer after the fix\"" };
      text = v;
      continue;
    }
    // `--thread` and `--port` are read by the caller, off the whole command
    // line, so they and their values are stepped over rather than taken.
    if (arg === "--thread" || arg === "--port") { i++; continue; }
    if (arg.startsWith("--")) return { error: `covey show does not know ${arg}` };
    files.push({ name: basename(arg), path: resolve(arg) });
  }
  if (files.length === 0) return { error: "covey show needs a file, for example: covey show shot.png --text \"the sidebar after the fix\"" };
  if (files.length > MAX_SHOWN_FILES) return { error: `covey show takes ${MAX_SHOWN_FILES} files at a time, not ${files.length}` };
  return { request: { text, files } };
}

export interface ShowOutcome {
  ok: boolean;
  lines: string[];
}

/** Ask the local daemon to show the files. Every failure is a sentence. */
export async function runShow(
  request: ShowRequest,
  env: { threadId: string | undefined; port: number },
  connect: (url: string) => Promise<Rpc> = openRpc,
): Promise<ShowOutcome> {
  if (!env.threadId) return { ok: false, lines: ["this command speaks for a covey thread: run it inside one (COVEY_THREAD_ID is set there), or pass --thread <id>"] };
  const threadId = env.threadId;
  let rpc: Rpc;
  try {
    rpc = await connect(`ws://127.0.0.1:${env.port}`);
  } catch (e: any) {
    return { ok: false, lines: [`no covey daemon answers on port ${env.port}: ${e?.message ?? e}`] };
  }
  try {
    await rpc.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT, threadId });
    const r = (await rpc.call("thread.showFiles", { threadId, text: request.text, files: request.files })) as { files: { name: string; path: string }[] };
    return { ok: true, lines: describeShown(r.files) };
  } catch (e: any) {
    return { ok: false, lines: [String(e?.message ?? e)] };
  } finally {
    rpc.close();
  }
}

/**
 * What the agent reads back: the names, and where the copies went.
 *
 * The path is worth printing. The file is now the thread's own, so a later
 * `covey pr open --attach` can name the copy after the agent's `/tmp` is gone.
 */
export function describeShown(files: { name: string; path: string }[]): string[] {
  return [
    `showing ${files.length} file${files.length === 1 ? "" : "s"} in this conversation. A reader sees ${files.length === 1 ? "it" : "them"} inline on a phone, and opens ${files.length === 1 ? "it" : "them"} in a browser from the TUI`,
    ...files.map((f) => `  ${f.name}  ${f.path}`),
  ];
}
