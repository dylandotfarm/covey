import React from "react";
import { Box, Text } from "ink";
import { archiveKey, liveThreads, runKey, threadGroupKey, type AppState, type SidebarRow } from "../store.js";
import type { SidebarCell } from "../sidebar.js";
import { T, connColor, statusColor } from "../theme.js";
import { relTime, truncate } from "../lines.js";
import { runMemberStateLabel, runState, tallyRun } from "@covey/protocol";
import { buildSkew } from "../build.js";

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
          : <Text color={T.subtle}>  {state.order.length} machine{state.order.length === 1 ? "" : "s"}</Text>}
      </Box>
      {/* Painted from `cells`, not from `rows`: the blank lines above machine
          headers and the scroll window have to be identical to what App uses
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

/**
 * The mark on a thread a program started (#49). It is in Geometric Shapes,
 * the same block as the `◼` a run member row already paints, so it survives a
 * terminal with a narrow font as the rest of the sidebar does.
 */
export const AGENT_MARK = "◇";

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
      const dot = m.conn === "connected" ? "●" : m.conn === "connecting" ? "◌" : m.conn === "offline" ? "✗" : "○";
      const dotColor = connColor(m.conn);
      const name = m.info?.name ?? m.saved.name;
      // A machine behind the client is worth more than its os here: the os
      // never changes, and old code on the far end is what wastes an hour.
      const behind = m.conn === "connected" && buildSkew(state.clientBuild, m.info?.build) === "behind";
      // Room here is a dozen characters, so the reason lives in the summary
      // pane; what the row owes the reader is that nothing more will happen
      // unless they ask, which is what "enter to retry" says.
      const meta = m.conn === "offline" ? "offline · enter" : m.conn !== "connected" ? m.conn : behind ? "⚠ old build" : (m.info?.os ?? "");
      return (
        <Box paddingX={1} height={1} backgroundColor={bg}>
          <Text color={dotColor}>{dot} </Text>
          <Text color={T.text} bold>{truncate(name.toUpperCase(), width - 6 - meta.length)}</Text>
          {/* The words that say what to press are held to the same bar as the
              mark. Every other row's meta keeps `T.subtle`, which the sidebar
              has always used and which this change does not widen. */}
          <Text color={m.conn === "offline" ? connColor(m.conn) : behind ? T.warning : T.subtle}>  {meta}</Text>
        </Box>
      );
    }
    case "empty":
      return <Box paddingLeft={3} height={1} backgroundColor={bg}><Text color={T.subtle} italic>no projects — press a</Text></Box>;
    case "project": {
      const open = state.expanded[`${row.machine}:${row.projectId}`] ?? true;
      const threads = liveThreads(m, row.projectId);
      const busy = threads.some((t) => t.status === "running" || t.status === "starting");
      const waiting = threads.some((t) => t.status === "waiting" || t.pendingApprovals > 0);
      const agg = !open && (waiting || busy) ? <Text color={waiting ? T.awaiting : T.working}>●</Text> : <Text color={T.subtle}>{open ? "▾" : "▸"}</Text>;
      return (
        <Box paddingLeft={2} paddingRight={1} height={1} backgroundColor={bg}>
          {agg}
          <Text color={T.text}> {truncate(row.project!.title, width - 8)}</Text>
          <Text color={T.faint}> {threads.length || ""}</Text>
        </Box>
      );
    }
    case "archived": {
      const open = state.expanded[archiveKey(row.machine, row.projectId!)] ?? false;
      // A sibling of the project's threads, so it folds away with the project:
      // the caret lands under the first letter of the thread titles above it.
      return (
        <Box paddingLeft={4} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={T.faint}>{open ? "▾" : "▸"}</Text>
          <Text color={T.subtle}> {truncate("Archived", width - 10)}</Text>
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
        <Box paddingLeft={2} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={tint}>{open ? "▾" : "▸"}</Text>
          <Text color={T.text}> {truncate(run.name, width - 9 - meta.length)}</Text>
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
      const titleW = Math.max(6, width - 5 - right.length);
      return (
        <Box paddingLeft={4} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={tint}>{mem.state === "working" ? "●" : mem.state === "blocked" ? "◼" : mem.state === "merged" ? "✓" : mem.state === "withdrawn" ? "–" : "·"}</Text>
          <Text color={mem.state === "withdrawn" ? T.faint : T.muted}> {truncate(`${mem.task.key} ${mem.task.title}`, titleW).padEnd(titleW)}</Text>
          <Text color={tint}> {right}</Text>
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
      // The indent reproduces what it was before nesting existed: depth 2 (a
      // thread in its project) leads with 3 columns, and an archived thread —
      // depth 3, lining up under "Archived" — with 5. A child of a thread is
      // depth 3 and lands on the same 5.
      const indent = Math.max(1, 1 + 2 * (row.depth - 2));
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
      const titleW = Math.max(4, width - indent - 2 - 3 - time.length - held.length);
      return (
        <Box paddingLeft={indent} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={row.group ? T.subtle : T.awaiting}>{caret}</Text>
          <Text color={attention === "done" ? T.success : attention === "error" ? T.danger : statusColor(st, pulse)}>{showDot ? (attention === "done" ? "✓" : attention === "error" ? "✗" : "●") : t.pinnedAt ? "⋆" : " "} </Text>
          <Text color={active ? T.text : row.archived ? T.faint : T.muted} bold={active}>{truncate(t.title, titleW).padEnd(titleW)}</Text>
          <Text color={T.subtle}>{held}</Text>
          <Text color={T.faint}> {time}</Text>
        </Box>
      );
    }
  }
}
