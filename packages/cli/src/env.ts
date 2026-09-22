/**
 * `covey env`: the names of the secrets a thread works with — issue #126.
 *
 * A person puts a value into covey from the TUI (`e` on a project or on a
 * thread). The daemon puts it in the environment of the Claude session, so a
 * tool call already reads `$STRIPE_KEY`. What the agent cannot do is *find
 * out* which names are there, because reading the environment would put the
 * values in the transcript. So it asks here, and gets names.
 *
 * `covey env exec -- cmd …` runs one command with the same environment, read
 * from the daemon now. It is for the case the session cannot cover: a secret
 * set while a turn was running, which reaches the session only at its next
 * start.
 *
 * Nothing in this file prints a value. `parseEnvArgs` is pure, so a test can
 * prove what each spelling asks for without a daemon.
 */
import { DEFAULT_PORT, PROTOCOL_VERSION, type SecretEntry } from "@covey/protocol";
import { LOOP_CLIENT, openRpc, type Rpc } from "./loop.js";

/** What one `covey env …` asks for. */
export type EnvRequest =
  | { kind: "list" }
  | { kind: "exec"; command: string; args: string[] };

export const ENV_USAGE = `  covey env                  the secrets this thread can use, by name. No values:
                             that is the point — a value must not enter the transcript.
                             They are already in your environment, so write $NAME in a
                             script, a curl header or a config file and run it
  covey env exec -- <cmd>    run one command with those secrets in its environment.
                             Use it when a secret was set after this session started`;

/**
 * Read `covey env …`. An error is a sentence for the shell, never a throw.
 */
export function parseEnvArgs(argv: string[]): { request: EnvRequest } | { error: string } {
  // argv is the whole command line: `env`, then the rest.
  const rest = argv.slice(1);
  const sub = rest[0];
  if (sub === undefined || sub === "list") return { request: { kind: "list" } };
  if (sub !== "exec") return { error: `covey env takes \`list\` or \`exec -- <command>\`, not ${sub}` };
  // `--` is the usual way to end covey's own flags, and it is optional: what
  // follows `exec` is the command either way.
  const after = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
  const command = after[0];
  if (!command) return { error: "covey env exec needs a command, for example: covey env exec -- ./deploy.sh" };
  return { request: { kind: "exec", command, args: after.slice(1) } };
}

export interface EnvOutcome {
  ok: boolean;
  lines: string[];
  /** Set by `exec`: the caller runs this, with `env` added to its own. */
  run?: { command: string; args: string[]; env: Record<string, string> };
}

/**
 * Ask the local daemon. `secrets.env` answers a loopback connection only, so
 * this works where the work is and nowhere else.
 */
export async function runEnv(
  request: EnvRequest,
  env: { threadId: string | undefined; port: number },
  connect: (url: string) => Promise<Rpc> = openRpc,
): Promise<EnvOutcome> {
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
    if (request.kind === "list") {
      const r = (await rpc.call("secrets.list", { threadId })) as { secrets: SecretEntry[] };
      return { ok: true, lines: describeSecrets(r.secrets) };
    }
    const r = (await rpc.call("secrets.env", { threadId })) as { env: Record<string, string> };
    return { ok: true, lines: [], run: { command: request.command, args: request.args, env: r.env } };
  } catch (e: any) {
    return { ok: false, lines: [String(e?.message ?? e)] };
  } finally {
    rpc.close();
  }
}

/**
 * The list an agent reads. Pure, and names only — a test holds it to that.
 */
export function describeSecrets(secrets: SecretEntry[]): string[] {
  if (secrets.length === 0) {
    return [
      "this thread has no secrets.",
      "A person adds one in the covey TUI: press e on the project row for every thread of the project, or on this thread's row for this thread alone.",
    ];
  }
  const width = Math.max(...secrets.map((s) => s.key.length));
  return [
    `${secrets.length} secret${secrets.length === 1 ? "" : "s"}, already in your environment. Write $NAME; never print the value.`,
    ...secrets.map((s) => `  ${s.key.padEnd(width)}  ${s.scope === "thread" ? (s.overrides ? "this thread (hides the project's)" : "this thread") : "the project"}`),
  ];
}
