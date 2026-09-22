import React from "react";
import { Box, Text } from "ink";
import { MACHINES_KEY, archiveKey, poolMachines, runKey, threadGroupKey, type AppState, type SidebarRow } from "../store.js";
import type { SidebarCell } from "../sidebar.js";
import { T, connColor, connDot, statusColor } from "../theme.js";
import { relTime, truncate } from "../lines.js";
import { hyperlinksEnabled, osc8 } from "../links.js";
import { runMemberStateLabel, runState, tallyRun } from "@covey/protocol";
import { buildSkew } from "../build.js";

const HYPERLINKS = hyperlinksEnabled();

export function Sidebar({ state, rows, cells, cursor, width, focused }: { state: AppState; rows: SidebarRow[]; cells: SidebarCell[]; cursor: number; width: number; focused: boolean }) {
  const inner = width - 1;
  return (
    /* `flexShrink={0}`: the sidebar is a rail of a fixed width, and the pane
       beside it takes what is left. Without this the two shrink together
       whenever their natural widths overrun the terminal — which the pane's now
       always does, its width being the width of its content. */
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} borderColor={T.border}>
      <Box paddingX={1} height={1}>
        <Text color={T.text} bold>covey</Text>
        {/* A client goes stale while it runs and cannot feel it, so the one
            place the reader always looks says so. */}
        {state.clientStale
          ? <Text color={T.warning}>  ⚠ newer build on disk</Text>
          : <Text color={T.subtle}>  {truncate(headerCount(rows, state), width - 9)}</Text>}
      </Box>
      {/* Painted from `cells`, not from `rows`: the blank lines above the
          projects and the scroll window have to be identical to what App uses
          to work out which row a click landed on. */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {cells.map((c, i) => c.kind === "blank"
          ? <Box key={`b${i}`} height={1} />
          : <Row key={rows[c.index]!.key} row={rows[c.index]!} state={state} selected={c.index === cursor && focused} active={isActive(state, rows[c.index]!)} width={inner} />)}
      </Box>
      <Box paddingX={1} height={1}>
        <Text color={T.faint}>{focused ? "n new  a add  m move  ? help" : "tab focus  ? help"}</Text>
      </Box>
    </Box>
  );
}

/** "3 projects · 2 machines": what the tree holds, at a glance. Read off the
 *  rows, which already hold one project row per group. */
function headerCount(rows: SidebarRow[], state: AppState): string {
  let p = 0;
  for (const r of rows) if (r.kind === "project") p++;
  const m = state.order.length;
  return `${p} project${p === 1 ? "" : "s"} · ${m} machine${m === 1 ? "" : "s"}`;
}

/**
 * The mark on a thread a program started (#49). It is in Geometric Shapes,
 * the same block as the `◼` a run member row already paints, so it survives a
 * terminal with a narrow font as the rest of the sidebar does.
 */
export const AGENT_MARK = "◇";

/**
 * How far from the left a row of each kind starts, in columns.
 *
 * One number cannot serve every kind, because they spend different room before
 * the title: a thread row keeps a two-column gutter for the caret or the `◇`
 * and two more for its status dot, while a run, a project and the archive
 * folder spend two columns on a caret and a space. These three put the title of
 * a run and of a run member at the same column as the title of a thread at the
 * same depth, which is what makes the indent read as "under" rather than as a
 * second kind of list.
 *
 * A project is a top-level row, so a thread directly under one is at depth 1.
 * A run the client cannot place in a project sits at depth 0, beside the
 * projects, and keeps the one column they have.
 */
export function threadIndent(depth: number): number { return Math.max(1, 1 + 2 * (depth - 1)); }
export function runIndent(depth: number): number { return depth <= 0 ? 1 : threadIndent(depth) + 2; }
export function memberIndent(depth: number): number { return runIndent(depth - 1) + 2; }

function isActive(s: AppState, r: SidebarRow) {
  return r.kind === "thread" && s.selected?.machine === r.machine && s.selected.threadId === r.thread!.id;
}

function Row({ row, state, selected, active, width }: { row: SidebarRow; state: AppState; selected: boolean; active: boolean; width: number }) {
  const bg = selected ? T.selection : undefined;
  const m = state.machines.get(row.machine)!;
  switch (row.kind) {
    case "machine": {
      // An offline machine gets its own mark. It used to share "○" with every
      // other kind of silence, so a machine nobody was dialling any more looked
      // exactly like one about to answer (issue #68).
      const dot = connDot(m.conn);
      const dotColor = connColor(m.conn);
      const name = m.info?.name ?? m.saved.name;
      // A machine behind the client is worth more than its os here: the os
      // never changes, and old code on the far end is what wastes an hour.
      const behind = m.conn === "connected" && buildSkew(state.clientBuild, m.info?.build) === "behind";
      // Room here is a dozen characters, so the reason lives in the summary
      // pane; what the row owes the reader is that nothing more will happen
      // unless they ask, which is what "enter to retry" says.
      // A connected machine with nothing on it says so, and what to press:
      // its emptiness has no row of its own now that projects lead the tree.
      const meta = m.conn === "offline" ? "offline · enter" : m.conn !== "connected" ? m.conn : behind ? "⚠ old build" : m.projects.size === 0 ? "no projects · a" : (m.info?.os ?? "");
      return (
        <Box paddingLeft={3} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={dotColor}>{dot} </Text>
          <Text color={T.text} bold>{truncate(name.toUpperCase(), width - 8 - meta.length)}</Text>
          {/* The words that say what to press are held to the same bar as the
              mark. Every other row's meta keeps `T.subtle`, which the sidebar
              has always used and which this change does not widen. */}
          <Text color={m.conn === "offline" ? connColor(m.conn) : behind ? T.warning : T.subtle}>  {meta}</Text>
        </Box>
      );
    }
    case "machines": {
      const open = state.expanded[MACHINES_KEY] ?? false;
      const offline = state.order.filter((k) => state.machines.get(k)?.conn === "offline").length;
      const behind = state.order.filter((k) => { const x = state.machines.get(k); return x?.conn === "connected" && buildSkew(state.clientBuild, x.info?.build) === "behind"; }).length;
      // Furled, the section still says what needs a person: a machine the
      // client no longer dials, or one on an old build.
      const meta = offline ? `${offline} offline` : behind ? `${behind} old build` : String(state.order.length);
      // The padding on both sides, the caret, its space, and the two before the meta.
      return (
        <Box paddingX={1} height={1} backgroundColor={bg}>
          <Text color={T.subtle}>{open ? "▾" : "▸"}</Text>
          <Text color={T.text} bold> {truncate("MACHINES", width - 6 - meta.length)}</Text>
          <Text color={offline ? connColor("offline") : behind ? T.warning : T.faint}>  {meta}</Text>
        </Box>
      );
    }
    case "empty":
      return <Box paddingLeft={1} height={1} backgroundColor={bg}><Text color={T.subtle} italic>no projects — press a</Text></Box>;
    case "project": {
      const open = state.expanded[row.groupKey!] ?? true;
      // Every machine in the pool answers the three questions: a fold may
      // never hide that something inside it is working, that something is
      // waiting on a person, or how much there is. `sidebarRows` summed them
      // once, over the walk that found the threads, so a paint reads three
      // fields and scans nothing.
      const { busy = false, waiting = false, count = 0 } = row;
      const agg = !open && (waiting || busy) ? <Text color={waiting ? T.awaiting : T.working}>●</Text> : <Text color={T.subtle}>{open ? "▾" : "▸"}</Text>;
      // The last row whose width was a constant rather than a sum of the cells
      // it paints: the indent, the caret or the dot, the space before the
      // title, the space before the number, and the padding on the right. The
      // constant was sized for a count of one digit, and Ink pays for an
      // overfull row by shrinking a cell — the cell it took here was the one
      // holding the caret and the attention dot. So a project with a hundred
      // planned tasks lost the dot that says a member inside it is blocked,
      // and could not even show that it was furled. The number is as long as
      // the work in the project, so the title takes what is left.
      const num = count ? String(count) : "";
      // A pool of more than one machine says so, because the threads under it
      // then carry a machine each.
      const machines = poolMachines(row.pool ?? []);
      const pool = machines > 1 ? ` ${machines}⧉` : "";
      // A project that works from a named branch says which. Two projects of
      // one repository are one row each, one per base branch, and both carry
      // the same title — the base is the only thing that tells the work on
      // `main` from the work on a feature branch. It takes half the room at
      // most, so the title still reads.
      const room = Math.max(1, width - 5 - num.length - pool.length);
      const branch = row.project!.baseBranch;
      const base = branch ? ` · ${truncate(branch, Math.max(3, Math.floor(room / 2) - 3))}` : "";
      return (
        <Box paddingLeft={1} paddingRight={1} height={1} backgroundColor={bg}>
          {agg}
          <Text color={T.text} bold> {truncate(row.project!.title, Math.max(1, room - base.length))}</Text>
          <Text color={T.subtle}>{base}</Text>
          <Text color={T.subtle}>{pool}</Text>
          <Text color={T.faint}> {num}</Text>
        </Box>
      );
    }
    case "archived": {
      const open = state.expanded[archiveKey(row.groupKey!)] ?? false;
      // A sibling of the project's threads, so it folds away with the project:
      // the caret lands under the first letter of the thread titles above it.
      //
      // The width is the sum of the cells, as every other row in this pane is,
      // though this one cannot be beaten: the title is the literal "Archived",
      // so the row is 16 columns and the digits of the count. It would take a
      // project of a quadrillion archived threads to fill a pane.
      const indent = threadIndent(row.depth) + 3;
      return (
        <Box paddingLeft={indent} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={T.faint}>{open ? "▾" : "▸"}</Text>
          <Text color={T.subtle}> {truncate("Archived", width - indent - 4 - String(row.count).length)}</Text>
          <Text color={T.faint}> {row.count}</Text>
        </Box>
      );
    }
    case "run": {
      const run = row.run!;
      const open = state.expanded[runKey(row.machine, run.id)] ?? true;
      const t = tallyRun(run);
      // What is left to do, not what is done: a run is watched until it ends.
      const left = t.total - t.merged - t.withdrawn;
      const st = runState(run);
      const meta = st === "planning" ? `${t.total} planned` : st === "finished" ? "done" : `${left} of ${t.total} left`;
      const tint = t.blocked > 0 ? T.awaiting : st === "finished" ? T.success : st === "planning" ? T.subtle : T.working;
      return (
        <Box paddingLeft={runIndent(row.depth)} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={tint}>{open ? "▾" : "▸"}</Text>
          {/* The caret, its space, the two before the meta, and the padding. */}
          <Text color={T.text}> {truncate(run.name, width - runIndent(row.depth) - 5 - meta.length)}</Text>
          <Text color={T.subtle}>  {meta}</Text>
        </Box>
      );
    }
    case "member": {
      const mem = row.member!;
      const label = runMemberStateLabel(mem.state);
      const who = state.machines.get(row.machine);
      // The member's thread is on whichever machine took the task, which is
      // not always the machine holding the run — so the row says which.
      const on = [...state.machines.values()].find((x) => x.info?.machineId === mem.machineId);
      const where = on?.info?.name ?? "";
      const tint = mem.state === "blocked" ? T.awaiting
        : mem.state === "working" ? T.working
        : mem.state === "merged" ? T.success
        : mem.state === "withdrawn" ? T.faint : T.subtle;
      const right = `${label}${where && where !== who?.info?.name ? ` · ${where}` : ""}`;
      const indent = memberIndent(row.depth);
      // Every column the row spends beside the title: the state mark, the space
      // before the title, the space before the state, and the padding on the
      // right. A row that asks for more than it has is not refused — Ink gives
      // the extra back by shrinking a cell, and the cell it took was the state
      // mark, so a member row painted its state twice in words and never once
      // as the mark this pane reads by.
      //
      // The floor under the title is the other half of that sum: `right` holds
      // the state *and* the name of the machine the task went to, which is as
      // long as somebody's machine name, so the two together outran the width
      // whatever the sum said. The title keeps its floor; the state takes the
      // room that is left and no more.
      const titleW = Math.max(6, width - indent - 4 - right.length);
      const room = width - indent - 4 - titleW;
      const shownRight = room > 0 ? truncate(right, room) : "";
      return (
        <Box paddingLeft={indent} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={tint}>{mem.state === "working" ? "●" : mem.state === "blocked" ? "◼" : mem.state === "merged" ? "✓" : mem.state === "withdrawn" ? "–" : "·"}</Text>
          <Text color={mem.state === "withdrawn" ? T.faint : T.muted}> {truncate(`${mem.task.key} ${mem.task.title}`, titleW).padEnd(titleW)}</Text>
          <Text color={tint}>{shownRight ? ` ${shownRight}` : ""}</Text>
        </Box>
      );
    }
    case "thread": {
      const t = row.thread!;
      const pulse = state.tick % 2 === 0;
      const st = t.pendingApprovals > 0 ? "waiting" : t.status;
      const attention = state.attention.get(`${row.machine}:${t.id}`);
      const showDot = st !== "idle" || !!attention;
      const time = relTime(t.lastMessageAt ?? t.createdAt);
      // One row, one line, always. The indent and the two fixed cells below
      // come out of the same width the title is measured against, so a row can
      // never grow a second line — that is what silently breaks the mouse hit
      // test, because `sidebarCells` gives every row exactly one line.
      //
      // The indent reproduces what it was before nesting existed, and a run
      // and its members are measured against it — see `threadIndent`.
      const indent = threadIndent(row.depth);
      const open = state.expanded[threadGroupKey(row.machine, t.id)] ?? false;
      // The tree gutter: one fixed two-column cell, so every thread title in
      // the sidebar starts in the same column. It holds the caret when the row
      // heads a group, and otherwise the mark of a thread a program started —
      // a glyph, not a colour, because covey runs over ssh, in tmux, and on
      // terminals with a narrow palette, and colour alone also fails a reader
      // who cannot tell the pair apart.
      //
      // The mark used to sit between the status dot and the title, which
      // pushed an agent's title two columns right and made a thread that is
      // nobody's child read as somebody's child — the indent is the sidebar's
      // one way of saying "under", and nothing else may spend it. A row that is
      // both a group and an agent spends the cell on the caret: what it is
      // holding is the more useful of the two, and its children carry the mark.
      const caret = row.group ? (open ? "▾ " : "▸ ") : row.agent ? `${AGENT_MARK} ` : "  ";
      // What a furled group is holding back, so the way in is visible.
      const held = row.group && !open && row.hidden ? ` ${row.hidden}` : "";
      // Which machine, when the project is on more than one. Short, because
      // the title is what the row is for.
      const tag = row.tag ? ` ${truncate(row.tag, 6)}` : "";
      // The same sum for a thread row: the gutter, the status dot and its
      // space, the space before the time, and the padding on the right.
      const titleW = Math.max(4, width - indent - 6 - time.length - held.length - tag.length);
      // The issue the thread took goes before the title, the way a run member
      // row leads with its task key: the number is the link a reader follows,
      // and on a terminal that knows OSC 8 it is one (#108). The link wraps
      // the number only, after the cut, so the row keeps its one line.
      const title = t.issue ? `#${t.issue.number} ${t.title}` : t.title;
      const shown = truncate(title, titleW).padEnd(titleW);
      const ref = t.issue ? `#${t.issue.number}` : "";
      const linked = ref && t.issue?.url && HYPERLINKS && shown.startsWith(ref) ? osc8(t.issue.url, ref) + shown.slice(ref.length) : shown;
      return (
        <Box paddingLeft={indent} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={row.group ? T.subtle : T.awaiting}>{caret}</Text>
          <Text color={attention === "done" ? T.success : attention === "error" ? T.danger : statusColor(st, pulse)}>{showDot ? (attention === "done" ? "✓" : attention === "error" ? "✗" : "●") : t.pinnedAt ? "⋆" : " "} </Text>
          <Text color={active ? T.text : row.archived ? T.faint : T.muted} bold={active}>{linked}</Text>
          <Text color={T.subtle}>{held}</Text>
          <Text color={T.faint}>{tag}</Text>
          <Text color={T.faint}> {time}</Text>
        </Box>
      );
    }
  }
}
