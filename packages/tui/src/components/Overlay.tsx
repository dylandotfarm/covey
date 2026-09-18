import React from "react";
import { Box, Text } from "ink";
import { runMemberStateLabel, runState, tallyRun, type MachineUpdate, type Run, type RunMemberState, type UpdateStep } from "@covey/protocol";
import { browseRows, sumUsage, usageRows, fmtTokens, fmtCost, USAGE_WINDOWS, type Overlay } from "../store.js";
import { PLACEMENT_RULE } from "../run.js";
import { T } from "../theme.js";
import { truncate, SPINNER } from "../lines.js";

export function OverlayView({ overlay, cursor, filter, checked, width, height, update, machineName, tick, run, machineNameOf }: { overlay: Overlay; cursor: number; filter: string; checked: boolean; width: number; height: number; update?: MachineUpdate | null; machineName?: string; tick?: number; run?: Run | null; machineNameOf?: (id: string) => string }) {
  const w = Math.min(width - 4, 80);
  const maxRows = Math.max(4, Math.min(height - 10, 20));
  // Rendered in place of the transcript (not floated): Ink cannot paint an
  // opaque background under an absolutely positioned box.
  const frame = (title: string, body: React.ReactNode, footer: string) => (
    <Box flexDirection="column" width={width} height={height} alignItems="center" paddingTop={Math.max(0, Math.floor((height - maxRows - 6) / 2))}>
      <Box width={w} flexDirection="column" borderStyle="round" borderColor={T.accentDim} paddingX={1}>
        <Text color={T.text} bold>{title}</Text>
        {body}
        <Text color={T.faint}>{footer}</Text>
      </Box>
    </Box>
  );
  switch (overlay.kind) {
    case "help":
      return frame("Keys", (
        <Box flexDirection="column">
          {/* Keyed by position: several keys legitimately appear twice, once
              per pane they mean something in. */}
          {HELP.map(([k, d], i) => <Text key={i}><Text color={T.accent}>{k.padEnd(14)}</Text><Text color={T.muted}>{d}</Text></Text>)}
        </Box>
      ), "esc close");
    case "input":
      return frame(overlay.title, (
        <Box marginY={1}><Text color={T.text}>{filter}</Text><Text inverse> </Text>{filter.length === 0 && overlay.placeholder ? <Text color={T.subtle}>{overlay.placeholder}</Text> : null}</Box>
      ), "enter confirm · esc cancel");
    case "pick":
    case "palette": {
      const options = overlay.kind === "pick" ? overlay.options : [];
      const toggle = overlay.kind === "pick" ? overlay.toggle : undefined;
      const filtered = filterOptions(options, filter);
      const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), filtered.length - maxRows));
      return frame(overlay.kind === "pick" ? overlay.title : "Commands", (
        <Box flexDirection="column">
          <Text color={T.subtle}>› {filter}<Text inverse> </Text></Text>
          {filtered.slice(start, start + maxRows).map((o, i) => {
            const sel = start + i === cursor;
            // One column of gutter before the hint, or a label that fills the
            // row runs straight into it.
            const avail = w - 6 - (o.hint ? o.hint.length + 1 : 0);
            return <Text key={o.id} backgroundColor={sel ? T.selection : undefined} color={sel ? T.text : T.muted}>{" "}{truncate(o.label, avail).padEnd(avail)}<Text color={T.subtle}>{o.hint ? " " + o.hint : ""}</Text></Text>;
          })}
          {filtered.length === 0 && <Text color={T.subtle} italic> no matches</Text>}
          {toggle && <Text color={checked ? T.accent : T.subtle}> {checked ? "[x]" : "[ ]"} {truncate(toggle, w - 10)}</Text>}
        </Box>
      ), toggle ? "↑↓ move · tab check · enter select · esc cancel" : "↑↓ move · enter select · esc cancel");
    }
    case "update": {
      if (!update) return frame("Update", <Box marginY={1}><Text color={T.subtle}>starting…</Text></Box>, "esc close");
      const running = update.steps.find((s) => s.status === "running");
      const failed = update.steps.find((s) => s.status === "failed");
      const shown = failed ?? running;
      // The tail of whatever is running is the only part worth the rows.
      const outRows = Math.max(3, Math.min(maxRows - update.steps.length - 1, 10));
      const out = (shown?.output ?? "").split("\n").filter((l) => l.trim()).slice(-outRows);
      return frame(`Update ${machineName ?? ""}`.trim() + stateSuffix(update), (
        <Box flexDirection="column">
          {update.steps.map((s) => <StepRow key={s.name} step={s} width={w} tick={tick ?? 0} />)}
          {out.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {out.map((l, i) => <Text key={i} color={T.faint}>{"  " + truncate(l.replace(/\s+$/, ""), w - 6)}</Text>)}
            </Box>
          )}
          {update.error && <Text color={T.danger}>{truncate(update.error, w - 4)}</Text>}
        </Box>
      ), update.state === "running" || update.state === "restarting" ? "esc close — the update keeps running" : "esc close");
    }
    case "browse": {
      // Same list the key handler walks — one builder, so the highlighted row
      // and the row enter acts on can never be different things.
      const rows = browseRows(overlay.entries, filter);
      const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), rows.length - maxRows));
      return frame(`Add project on ${machineName ?? "machine"}`, (
        <Box flexDirection="column">
          <Text color={T.subtle}>{truncate(overlay.path, w - 4)}</Text>
          <Text color={T.subtle}>› {filter}<Text inverse> </Text></Text>
          {overlay.loading ? <Text color={T.subtle}>loading…</Text> : rows.slice(start, start + maxRows).map((r, i) => {
            const sel = start + i === cursor;
            const [icon, label] = r.kind === "up" ? ["  ", ".."]
              : r.kind === "new" ? ["+ ", r.name ? `New folder "${r.name}"` : "New folder…"]
              : [r.isRepo ? "⎇ " : "  ", r.name];
            const tint = r.kind === "dir" && r.isRepo ? T.success : r.kind === "new" ? T.accent : T.subtle;
            return (
              <Text key={r.kind + ":" + label} backgroundColor={sel ? T.selection : undefined} color={sel ? T.text : T.muted}>
                {" "}<Text color={tint}>{icon}</Text>{truncate(label, w - 9)}
              </Text>
            );
          })}
        </Box>
      ), "enter open dir · space select this dir · ctrl+n new folder · esc cancel");
    }
    case "usage":
      return frame("Usage — estimated", <UsageBody overlay={overlay} width={w} maxRows={maxRows} />,
        "←→ period · g group by thread/project/model/machine · esc close");
    case "run": {
      if (!run) return frame("Run", <Box marginY={1}><Text color={T.subtle}>this run is gone</Text></Box>, "esc close");
      return frame(`Run "${run.name}"`, (
        <RunBody run={run} machineName={machineNameOf ?? ((id) => id.slice(0, 8))} marked={overlay.marked}
          cursor={cursor} busy={overlay.busy} width={w} maxRows={maxRows} />
      ), "enter open · space mark · s send · d dispatch · m move · t state · p read PRs · a add · esc close");
    }
  }
}

/** Column widths: estimated cost, turns, input, output, cache. */
const COLS = [8, 7, 8, 8, 8] as const;

/**
 * Totals for every connected machine, in one table.
 *
 * Every cost here is the SDK's own estimate at list prices. On a subscription
 * plan no such money is charged, so the column says `estimated` and each
 * figure carries a `~`. It must not read as a bill.
 */
function UsageBody({ overlay, width, maxRows }: { overlay: Extract<Overlay, { kind: "usage" }>; width: number; maxRows: number }) {
  const period = USAGE_WINDOWS[overlay.window] ?? USAGE_WINDOWS[0]!;
  const total = sumUsage(overlay.reports.map((r) => r.total));
  const rows = usageRows(overlay.reports, overlay.groupBy);
  // The frame keeps two columns for its border and two more for its padding.
  // Cost, turns and the three token columns are fixed; the label takes the
  // rest. One column over and every row wraps onto a second line.
  const inner = width - 4;
  const labelW = Math.max(12, inner - COLS.reduce((n, c) => n + c, 0));
  const cell = (s: string, n: number) => truncate(s, n).padStart(n);
  return (
    <Box flexDirection="column">
      <Box>
        {USAGE_WINDOWS.map((w, i) => (
          <Text key={w.id} color={i === overlay.window ? T.text : T.subtle} backgroundColor={i === overlay.window ? T.selection : undefined}>
            {` ${w.label} `}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={T.muted}>
          {"by " + overlay.groupBy}
          {overlay.loading ? <Text color={T.subtle}> · reading…</Text> : null}
        </Text>
      </Box>
      <Text color={T.subtle}>
        {truncate(`${period.label}, all machines`, labelW).padEnd(labelW)}
        {cell("est.", COLS[0])}{cell("turns", COLS[1])}{cell("in", COLS[2])}{cell("out", COLS[3])}{cell("cache", COLS[4])}
      </Text>
      <Text color={T.text} bold>
        {truncate("Total", labelW).padEnd(labelW)}
        {cell(fmtCost(total.estimatedCostUsd), COLS[0])}{cell(String(total.turns), COLS[1])}
        {cell(fmtTokens(total.inputTokens), COLS[2])}{cell(fmtTokens(total.outputTokens), COLS[3])}
        {cell(fmtTokens(total.cacheReadInputTokens + total.cacheCreationInputTokens), COLS[4])}
      </Text>
      {rows.slice(0, maxRows).map((r) => (
        <Text key={r.key} color={T.muted}>
          {truncate(r.machine ? `${r.label} · ${r.machine}` : r.label, labelW).padEnd(labelW)}
          {cell(fmtCost(r.total.estimatedCostUsd), COLS[0])}{cell(String(r.total.turns), COLS[1])}
          {cell(fmtTokens(r.total.inputTokens), COLS[2])}{cell(fmtTokens(r.total.outputTokens), COLS[3])}
          {cell(fmtTokens(r.total.cacheReadInputTokens + r.total.cacheCreationInputTokens), COLS[4])}
        </Text>
      ))}
      {!overlay.loading && rows.length === 0 && <Text color={T.subtle} italic> no turns in this period</Text>}
      {rows.length > maxRows && <Text color={T.faint}>{` …and ${rows.length - maxRows} more`}</Text>}
      {overlay.errors.map((e) => <Text key={e.machine} color={T.danger}>{truncate(` ${e.machine}: ${e.message}`, width - 2)}</Text>)}
      <Box marginTop={1}>
        <Text color={T.faint}>{truncate("est. = the SDK's list-price estimate, not money charged", width - 2)}</Text>
      </Box>
    </Box>
  );
}

function stateSuffix(u: MachineUpdate): string {
  switch (u.state) {
    case "running": return " — running";
    case "restarting": return " — restarting the daemon";
    case "succeeded": return u.toCommit ? ` — done, now at ${u.toCommit}` : " — done";
    case "failed": return " — failed";
  }
}

function StepRow({ step, width, tick }: { step: UpdateStep; width: number; tick: number }) {
  const [icon, color] = step.status === "ok" ? ["✓", T.success]
    : step.status === "failed" ? ["✗", T.danger]
    : step.status === "running" ? [SPINNER[tick % SPINNER.length]!, T.working]
    : step.status === "skipped" ? ["–", T.subtle]
    : ["·", T.faint];
  const note = step.note ?? (step.status === "running" ? step.command : "");
  return (
    <Text>
      <Text color={color}>{" " + icon + " "}</Text>
      <Text color={step.status === "pending" ? T.subtle : T.text}>{step.label.padEnd(9)}</Text>
      <Text color={T.subtle}>{truncate(note, width - 16)}</Text>
    </Text>
  );
}

export function filterOptions<O extends { label: string; hint?: string }>(options: O[], filter: string): O[] {
  const f = filter.trim().toLowerCase();
  if (!f) return options;
  return options.filter((o) => (o.label + " " + (o.hint ?? "")).toLowerCase().includes(f));
}


/** Columns of the run panel: state, machine, branch, pull request. */
const RUN_COLS = { state: 10, machine: 8, branch: 18, pr: 7 } as const;

/**
 * A run and its members: task, thread, machine, branch, pull request, state.
 *
 * Every field here streams over the shell subscription the sidebar already
 * holds, except the pull request, which is fetched — see `refreshPullRequests`.
 */
function RunBody({ run, machineName, marked, cursor, busy, width, maxRows }: {
  run: Run;
  /** The machine each member works on, by machine id. */
  machineName: (id: string) => string;
  marked: Set<string>;
  cursor: number;
  busy: string | null;
  width: number;
  maxRows: number;
}) {
  const t = tallyRun(run);
  const inner = width - 4;
  const taskW = Math.max(10, inner - 2 - RUN_COLS.state - RUN_COLS.machine - RUN_COLS.branch - RUN_COLS.pr);
  const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), run.members.length - maxRows));
  const cell = (s: string, n: number) => truncate(s, n).padEnd(n);
  return (
    <Box flexDirection="column">
      <Text color={T.subtle}>{truncate(run.goal, inner)}</Text>
      <Box marginTop={1}>
        <Text color={T.muted}>
          {`${t.total} member${t.total === 1 ? "" : "s"} · ${t.machines} machine${t.machines === 1 ? "" : "s"} · `}
          <Text color={T.subtle}>{`planned ${t.planned}  working ${t.working}  in review ${t.review}  merged ${t.merged}`}</Text>
          {t.blocked > 0 ? <Text color={T.awaiting}>{`  blocked ${t.blocked}`}</Text> : null}
          {t.withdrawn > 0 ? <Text color={T.faint}>{`  withdrawn ${t.withdrawn}`}</Text> : null}
        </Text>
      </Box>
      <Text color={T.faint}>
        {"  "}{cell("task", taskW)}{cell("state", RUN_COLS.state)}{cell("machine", RUN_COLS.machine)}{cell("branch", RUN_COLS.branch)}{cell("pr", RUN_COLS.pr)}
      </Text>
      {run.members.slice(start, start + maxRows).map((m, i) => {
        const sel = start + i === cursor;
        const on = marked.has(m.id);
        return (
          <Text key={m.id} backgroundColor={sel ? T.selection : undefined} color={sel ? T.text : T.muted}>
            <Text color={on ? T.accent : T.faint}>{on ? "▸ " : "  "}</Text>
            {cell(`${m.task.key} ${m.task.title}`, taskW)}
            <Text color={memberTint(m.state)}>{cell(runMemberStateLabel(m.state), RUN_COLS.state)}</Text>
            {cell(machineName(m.machineId), RUN_COLS.machine)}
            {cell(m.branch ?? "", RUN_COLS.branch)}
            {cell(m.pullRequest ? `#${m.pullRequest.number}` : "", RUN_COLS.pr)}
          </Text>
        );
      })}
      {run.members.length === 0 && <Text color={T.subtle} italic> no members — press a to add a task</Text>}
      {run.members.length > maxRows && <Text color={T.faint}>{` …${run.members.length - maxRows} more`}</Text>}
      {/* A note is the operator's own sentence about one member; the row it
          belongs to has no space for it, so it sits under the list. */}
      {noteFor(run, cursor) && <Box marginTop={1}><Text color={T.awaiting}>{truncate(noteFor(run, cursor)!, inner)}</Text></Box>}
      {/* The rule, before it runs. Placement that cannot be read is placement
          nobody overrides, and the operator is the one who knows that this
          task needs a Mac. Once the run is dispatched it has nothing to say. */}
      {runState(run) === "planning" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={T.faint}>{truncate(`Placed: ${PLACEMENT_RULE}`, inner)}</Text>
          <Text color={T.faint}>{truncate("m moves a member before dispatch.", inner)}</Text>
        </Box>
      )}
      {busy && <Box marginTop={1}><Text color={T.working}>{truncate(busy, inner)}</Text></Box>}
    </Box>
  );
}

function noteFor(run: Run, cursor: number): string | null {
  const m = run.members[cursor];
  return m?.note ? `${m.task.key}: ${m.note}` : null;
}

function memberTint(s: RunMemberState): string {
  switch (s) {
    case "blocked": return T.awaiting;
    case "working": return T.working;
    case "merged": return T.success;
    case "withdrawn": return T.faint;
    default: return T.subtle;
  }
}

const HELP: [string, string][] = [
  ["tab", "switch focus: sidebar ↔ composer"],
  ["ctrl+k", "command palette (move, rename, model, mode, streaming, machines…)"],
  ["shift+tab", "cycle permission mode (→ bypass = never ask)"],
  ["ctrl+n", "new thread in current project"],
  ["ctrl+t", "toggle sidebar"],
  ["ctrl+o", "show every tool call / fold them back into >_ rows"],
  ["ctrl+b", "background the running tool calls — they report back later"],
  ["ctrl+c", "quit (press twice)"],
  ["sidebar", ""],
  ["  ↑/↓ j/k", "move — what you land on is shown on the right"],
  ["  enter", "open thread / fold project or archive / machine panel"],
  ["  n", "new thread (asks worktree vs. checkout in a git repo)"],
  ["  N", "new thread in a worktree branched from HEAD"],
  ["  a", "add project — browse dirs, ctrl+n makes a new folder"],
  ["  m", "move thread to another machine"],
  ["  r", "rename thread"],
  ["  x", "archive / unarchive thread (sending a message unarchives)"],
  ["", "  archiving hands back the worktree, keeping its branch"],
  ["  D", "delete thread"],
  ["ctrl+k", "…also: revert to before a turn (esc esc too), model, mode"],
  ["ctrl+k", "…and: usage — tokens and estimated cost, per period"],
  ["ctrl+k", "…and: start a run — one task each, across machines"],
  ["run panel", "(enter on a run row in the sidebar)"],
  ["  ↑/↓ j/k", "move · enter open that member's thread"],
  ["  space", "mark a member, for \"send to these\""],
  ["  s", "send one message to every member, the marked, or one"],
  ["  d", "dispatch — one thread per task, one worktree each"],
  ["  m", "move a member to another machine (before dispatch)"],
  ["  t", "set a member's state (blocked is not an error)"],
  ["  p", "read each member's pull request"],
  ["  a / D / r", "add a task · drop an undispatched member · rename"],
  ["machine panel", ""],
  ["  enter", "on a machine row: update (pull, rebuild, restart),"],
  ["", "  restart, default model, default mode"],
  ["composer", ""],
  ["  enter", "send"],
  ["  shift+enter", "newline (ctrl+j always works)"],
  ["  cmd+⌫ / ⌦", "delete to start / end of line"],
  ["  alt+⌫ / ⌦", "delete word back / forward"],
  ["  ctrl+u / w", "delete to line start / word back"],
  ["  ctrl+v", "attach the clipboard image (needs pngpaste / wl-paste / xclip)"],
  ["", "  drag a file onto the window to attach it — any type"],
  ["  alt+← / →", "move the caret by word (esc b / esc f too)"],
  ["  cmd+← / →", "start / end of line"],
  ["  ctrl+a / e", "start / end of line"],
  ["  enter", "…while a turn runs: joins it at the next tool call"],
  ["  esc", "interrupt running turn"],
  ["  esc esc", "revert files and conversation to before a turn"],
  ["  ↑ / ↓", "move by row; from the top/bottom row: past messages"],
  ["  y / a / n", "allow / always allow / deny a pending approval"],
  ["conversation", "(no focus of its own — cmd works while you type)"],
  ["  cmd+↑↓ / j k", "scroll a line · +shift a page · pgup/pgdn too"],
  ["  cmd+g / +shift", "oldest loaded / back to the newest"],
  ["  cmd+d", "show changes from the last turn (d in the sidebar)"],
  ["  cmd+o", "expand/collapse last tool call"],
  ["  click", "on a ▸ or >_ row: fold or unfold it"],
  ["mouse", ""],
  ["  click", "sidebar: open that row, as enter would"],
  ["  drag", "conversation/diff: select and copy (shift+drag = terminal's own)"],
  ["  alt+click", "reveal the file, or open the URL (ctrl+click does it too)"],
  ["  wheel", "scroll the conversation · +alt a page · over a list, move in it"],
];
