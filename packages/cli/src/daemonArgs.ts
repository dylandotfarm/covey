import { join } from "node:path";

/**
 * The command line for a daemon that the CLI starts.
 *
 * `--port` is always here, even for the default port. Before, the CLI left it
 * out for the default, so every daemon on the default port showed the same
 * command line as a daemon started with no port at all:
 *
 *     node <dir>/index.js daemon
 *
 * A pattern such as `pkill -f "index.js daemon"` then matched a throwaway
 * daemon and the daemon that hosts the session equally, and a session killed
 * its own host. The port in the command line makes the two look different in
 * `ps`. `covey stop --port N` remains the safe way to stop one of them.
 *
 * This lives in its own module because `index.ts` runs `main()` when it loads,
 * so a test cannot import it.
 */
export function daemonArgs(dir: string, port: number): string[] {
  return [join(dir, "index.js"), "daemon", "--port", String(port)];
}
