import { CLAUDE_SYSTEM, type ClaudeInstall, type ClaudeRelease } from "@covey/protocol";

/**
 * Which Claude Code a machine runs, said in a way a reader can act on.
 *
 * A covey session never runs the `claude` on the machine's PATH: the Agent SDK
 * spawns its own bundled binary, and SDK `0.3.N` carries Claude Code `2.1.N`.
 * So the version every thread reports is the one the daemon's own dependency
 * pins, and a reader who ran `claude update` in a terminal changed nothing —
 * which they found out as a 400 from the API, with a model their own Claude
 * Code knew and every covey thread refused.
 *
 * This is the list that fixes it. Three kinds of choice, and they are not
 * interchangeable:
 *
 * - **the one the lockfile pins**, which every machine has, needs no network,
 *   and is what covey falls back to. It is first because it is the way back:
 *   a reader who picked badly has one row to press, and it always works.
 * - **a version covey installs**, under the daemon's own data directory, so
 *   nothing touches the checkout and the machine's own update still works.
 * - **this machine's `claude`**, which pairs covey's SDK with somebody else's
 *   binary. Offered because a reader asked for it, and labelled rather than
 *   recommended: the two ship as a pair, and `claude update` then moves what
 *   every thread on the machine runs without covey hearing about it.
 *
 * Pure, and every client reads it: the TUI's machine control panel, the web
 * client's machine sheet and the phone's settings all offer one list, so the
 * same setting has the same words in a terminal and on a phone. Three copies
 * is what `hiddenPanel` was before it moved here, and they had drifted.
 */

/**
 * One row of the picker. `id` is what goes to `machine.setClaude`, with `""`
 * for the lockfile's version — the empty id every covey picker uses for "the
 * default" — so a client maps one choice to one command and reads nothing.
 *
 * `hint` stays a description of the choice even when the choice is the one in
 * force; each client writes "current" its own way, as the session-limit
 * pickers do. `pickable` is false for a row that cannot be chosen, which is
 * only ever the system row on a machine with no `claude`: it is shown rather
 * than hidden, because a reader looking for that row needs to be told it is
 * not there instead of wondering where it went.
 */
export interface ClaudeChoice {
  id: string;
  label: string;
  hint: string;
  current: boolean;
  pickable: boolean;
}

/** The id `machine.setClaude` wants for a row: `null` for the lockfile's. */
export function claudeValue(id: string): string | null {
  return id === "" ? null : id;
}

/** `2.1.325`, or the SDK version when covey cannot name the Claude Code. */
export function releaseLabel(r: ClaudeRelease): string {
  return r.exact || r.claude !== r.sdk ? r.claude : `sdk ${r.sdk}`;
}

/** `today`, `yesterday`, `5 days ago`. Absent dates say nothing at all. */
export function ageLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * What the control panel's own row says now.
 *
 * The source is named every time, because the number alone is what misled a
 * reader in the first place: `2.1.280` looks like a fact about the machine and
 * is really a fact about one dependency.
 */
export function claudeValueLabel(install?: ClaudeInstall): string {
  if (!install) return "unknown";
  const v = install.version ?? "unknown";
  const where = install.source === "lockfile" ? "covey's own" : install.source === "system" ? "this machine's" : "installed by covey";
  return `${v} (${where})`;
}

/**
 * The warning a fallback deserves, or null.
 *
 * `requested` is only set when the setting asked for something covey is not
 * running, and the reader has to be told *which* version went missing as well
 * as which one they got — one word for two facts is what made a screenshot
 * read as "unreadable" for weeks (#132).
 */
export function claudeNotice(install?: ClaudeInstall): string | null {
  if (!install?.requested) return null;
  const asked = install.requested === CLAUDE_SYSTEM ? "this machine's own claude" : `sdk ${install.requested}`;
  return `${asked}: ${install.reason ?? "not available"} — running ${install.version ?? "the built-in Claude Code"} instead`;
}

/**
 * The picker.
 *
 * The order is the reader's: the way back first, then the newest, then their
 * own, then the recent few. A version that would appear twice appears once —
 * the newest release is also the first of the recent list, and two rows that
 * do the same thing is a reader wondering what the difference is.
 */
export function claudeChoices(install?: ClaudeInstall, now = Date.now()): ClaudeChoice[] {
  if (!install) return [];
  const rows: ClaudeChoice[] = [];
  const seen = new Set<string>();

  // 1. The lockfile's. Always offered, always works, and marked when in force.
  rows.push({
    id: "",
    label: install.lockfile ? `Covey's own (${releaseLabel(install.lockfile)})` : "Covey's own",
    hint: "the version this covey was built with",
    current: install.source === "lockfile",
    pickable: true,
  });

  // 2. The newest the registry offers. Absent until covey has read it, and the
  //    caller shows `availableError` rather than an empty list.
  const latest = install.available?.[0];
  if (latest) {
    seen.add(latest.sdk);
    rows.push({
      id: latest.sdk,
      label: `Latest (${releaseLabel(latest)})`,
      hint: [ageLabel(latest.publishedAt, now), latest.installed ? "already here" : ""].filter(Boolean).join(" · ") || "the newest Claude Code published",
      current: install.source === "managed" && install.sdk === latest.sdk,
      pickable: true,
    });
  }

  // 3. This machine's own. Shown even when there is none, so the reader is
  //    told rather than left looking for it.
  //
  //    Three states and not two. `undefined` is "covey has not looked" — the
  //    machine does not probe the PATH at start, so this is what the first
  //    paint holds while the registry read is still in flight — and painting
  //    that as "no claude here" is a claim covey has not earned. It stays
  //    pickable, because the daemon probes again and refuses by name when
  //    there is really none. `null` is "covey looked and there is none".
  const sys = install.system;
  rows.push({
    id: CLAUDE_SYSTEM,
    label: sys ? `This machine's claude (${releaseLabel(sys)})` : "This machine's claude",
    hint: sys ? "moves when you run `claude update`" : sys === null ? "no `claude` on this machine's PATH" : "",
    current: install.source === "system",
    pickable: sys !== null,
  });

  // 4. The recent few, newest first, minus whatever is already above.
  for (const r of install.available ?? []) {
    if (seen.has(r.sdk)) continue;
    seen.add(r.sdk);
    rows.push({
      id: r.sdk,
      label: releaseLabel(r),
      hint: [ageLabel(r.publishedAt, now), r.installed ? "already here" : ""].filter(Boolean).join(" · "),
      current: install.source === "managed" && install.sdk === r.sdk,
      pickable: true,
    });
  }

  // A version the reader is running that the registry no longer lists — an
  // older pick, or a read that failed — would otherwise vanish from its own
  // picker, and nothing would be marked as current.
  if (install.source === "managed" && install.sdk && !seen.has(install.sdk)) {
    rows.push({
      id: install.sdk,
      label: releaseLabel({ sdk: install.sdk, claude: install.version ?? install.sdk, exact: !!install.version }),
      hint: "already here",
      current: true,
      pickable: true,
    });
  }
  return rows;
}

/**
 * What the picker says about the registry, under the rows.
 *
 * A read that failed says so. An empty list with nothing above it reads as
 * "npm has published nothing", which is never what happened.
 */
export function claudeListNote(install?: ClaudeInstall): string | null {
  if (!install) return null;
  if (install.availableError) return install.availableError;
  if (!install.available?.length) return "covey has not read the list of versions yet";
  return null;
}
