import React from "react";
import { Box, Text } from "ink";
import { archiveKey, liveThreads, runKey, type AppState, type SidebarRow } from "../store.js";
import type { SidebarCell } from "../sidebar.js";
import { T, statusColor } from "../theme.js";
import { relTime, truncate } from "../lines.js";
import { runMemberStateLabel, runState, tallyRun } from "@covey/protocol";
import { buildSkew } from "../build.js";

export function Sidebar({ state, rows, cells, cursor, width, focused }: { state: AppState; rows: SidebarRow[]; cells: SidebarCell[]; cursor: number; width: number; focused: boolean }) {
  const inner = width - 1;
  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} borderColor={T.border}>
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
      const dotColor = m.conn === "connected" ? T.success : m.conn === "connecting" ? T.warning : m.conn === "offline" ? T.faint : T.danger;
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
          <Text color={behind ? T.warning : T.subtle}>  {meta}</Text>
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
      const pad = row.archived ? 5 : 3; // in the folder, the title lines up under "Archived"
      const titleW = width - pad - 3 - time.length;
      return (
        <Box paddingLeft={pad} paddingRight={1} height={1} backgroundColor={bg}>
          <Text color={attention === "done" ? T.success : attention === "error" ? T.danger : statusColor(st, pulse)}>{showDot ? (attention === "done" ? "✓" : attention === "error" ? "✗" : "●") : t.pinnedAt ? "⋆" : " "} </Text>
          <Text color={active ? T.text : row.archived ? T.faint : T.muted} bold={active}>{truncate(t.title, titleW).padEnd(titleW)}</Text>
          <Text color={T.faint}> {time}</Text>
        </Box>
      );
    }
  }
}
