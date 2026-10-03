import { homedir } from "node:os";

/**
 * The panel's own decisions about the thread's shell (#10), kept pure so node
 * can test them: what covey draws where the shell has no prompt of its own,
 * and the two numbers the panel is bounded by.
 */

/**
 * How many rows of output the panel keeps.
 *
 * Rows here, bytes on the daemon (`TERMINAL_SCROLLBACK_BYTES`), and the two
 * are not a disagreement: the daemon bounds what it holds for a reader who
 * comes back, and this bounds what one client lays out. Two thousand rows is
 * about forty screens, which is further back than a reader scrolls to find the
 * line a build failed on.
 */
export const TERMINAL_ROWS = 2000;

/** How many command lines ↑ walks back through. */
export const TERMINAL_HISTORY = 200;

/**
 * The prompt covey draws.
 *
 * A shell driven through pipes is not interactive and prints no prompt, so
 * this is covey's and not bash's — which is why it says only the one thing a
 * reader needs from a prompt and cannot work out for themselves: where they
 * are. The home directory becomes `~`, as every shell writes it.
 */
export function shellPrompt(cwd: string, home = homedir()): string {
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/**
 * The line covey writes into the log for a command the reader just ran.
 *
 * Written as *escapes*, not as styled spans, so it goes through the same
 * parser the shell's own output does (`AnsiLog`). One route in means one place
 * where a colour can be wrong, and the echo cannot drift from the output it
 * sits above.
 *
 * It is covey's echo because there is no pty to echo for us: the reader would
 * otherwise watch output appear with no record of what they asked for, which
 * is unreadable the moment there is more than one command on the screen.
 */
export function echoLine(cwd: string, line: string, home = homedir()): string {
  return `\x1b[90m${shellPrompt(cwd, home)}\x1b[39m\x1b[1m $ \x1b[22m${line}\n`;
}

/**
 * The prompt on the row the reader types on, which is the short form.
 *
 * Two rows of this pane already name the directory in full — the header, and
 * the echo of every command that ran there — so a third full path would be the
 * same string three times and a prompt row with no room left to type in. A
 * worktree path is long by construction: covey's own are
 * `<projects>/<owner>/<repo>/<thread>`.
 *
 * The last two segments, because the last one alone is a thread id or a short
 * hash that names nothing a reader recognises.
 */
export function promptLead(cwd: string, home = homedir()): string {
  const full = shellPrompt(cwd, home);
  if (full.length <= 28) return full;
  const parts = full.split("/").filter(Boolean);
  return parts.length <= 2 ? full : `…/${parts.slice(-2).join("/")}`;
}

/**
 * How a shell's last command ended, for the panel's header.
 *
 * A status of nothing is a shell nobody has typed in yet, and 0 is said as
 * nothing too: a reader needs to be told when a command failed, and telling
 * them every time one worked is a row that stops being read.
 *
 * `bad` is what the colour comes from, and an interrupt is the reason it is
 * not simply "there is a label". The reader pressed ctrl+c; saying so in red
 * would report their own decision back to them as a fault.
 */
export function exitLabel(exitCode: number | null): { text: string; bad: boolean } | null {
  if (exitCode === null || exitCode === 0) return null;
  // 128 + n is how a shell reports a command that a signal ended.
  if (exitCode === 130) return { text: "interrupted", bad: false };
  if (exitCode > 128 && exitCode < 160) return { text: `killed by signal ${exitCode - 128}`, bad: true };
  return { text: `exit ${exitCode}`, bad: true };
}
