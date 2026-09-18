import React from "react";
import { Box, Text } from "ink";
import { KNOWN_MODELS, type MachineUpdate, type Project, type Thread } from "@covey/protocol";
import type { AppState, MachineState, SidebarRow, ThreadTally } from "../store.js";
import { liveThreads, byRecency, tallyThreads, permissionModeLabel, workspaceModeLabel } from "../store.js";
import { T, connColor, statusColor } from "../theme.js";
import { relTime, truncate } from "../lines.js";
import { buildLine, buildSkew } from "../build.js";

/**
 * What the main pane shows while the sidebar cursor sits on something that is
 * not a thread. Threads have a transcript to show; a project or a machine has
 * only the shape of what is under it, which is exactly what you want to see
 * before deciding where to go — so arrowing over the tree reads like browsing
 * rather than like guessing.
 */
export function Summary({ state, row, width, height }: { state: AppState; row: SidebarRow; width: number; height: number }) {
  const m = state.machines.get(row.machine);
  if (!m) return null;
  const inner = width - 4;
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={2} paddingTop={1} overflow="hidden">
      {row.kind === "project" && row.projectId
        ? <ProjectSummary m={m} projectId={row.projectId} width={inner} height={height - 1} tick={state.tick} />
        : <MachineSummary m={m} state={state} width={inner} height={height - 1} tick={state.tick} />}
    </Box>
  );
}

function ProjectSummary({ m, projectId, width, height, tick }: { m: MachineState; projectId: string; width: number; height: number; tick: number }) {
  const p = m.projects.get(projectId);
  if (!p) return <Text color={T.subtle} italic>this project is no longer there</Text>;
  const threads = liveThreads(m, projectId).sort(byRecency);
  const tally = tallyThreads(threads);
  const hidden = [...m.threads.values()].filter((t) => t.projectId === projectId && (t.archivedAt || t.movedTo)).length;
  // Two header lines, a blank, two fact lines, a blank, the footer, and a row
  // to say how many threads did not fit.
  const room = Math.max(1, height - 8);
  const shown = threads.slice(0, room);
  return (
    <>
      <Text color={T.text} bold wrap="truncate">{p.title}</Text>
      <Text color={T.subtle} wrap="truncate">{p.workspaceRoot}{p.repositoryIdentity ? `   ${p.repositoryIdentity}` : ""}</Text>
      <Box height={1} />
      <Text wrap="truncate">
        <Counts t={tally} />
        {hidden > 0 && <Text color={T.faint}>  ·  {hidden} archived or moved</Text>}
      </Text>
      <Text wrap="truncate">
        <Text color={T.subtle}>new threads run in </Text>
        <Text color={T.muted}>{workspaceModeLabel(p.defaultWorkspaceMode)}</Text>
        {p.defaultModel && <Text color={T.subtle}>  ·  {modelLabel(p.defaultModel)}</Text>}
      </Text>
      <Box height={1} />
      {shown.map((t) => <ThreadLine key={t.id} t={t} width={width} tick={tick} />)}
      {threads.length === 0 && <Text color={T.subtle} italic>no threads yet — press n to start one</Text>}
      {threads.length > shown.length && <Text color={T.faint}>  … {threads.length - shown.length} more</Text>}
      <Box flexGrow={1} />
      <Text color={T.faint} wrap="truncate">enter fold · n new thread · N worktree from HEAD · D remove project</Text>
    </>
  );
}

function MachineSummary({ m, state, width, height, tick }: { m: MachineState; state: AppState; width: number; height: number; tick: number }) {
  const info = m.info;
  const projects = [...m.projects.values()].sort((a, b) => a.title.localeCompare(b.title));
  const tally = tallyThreads(liveThreads(m));
  const settings = info?.settings;
  const skew = buildSkew(state.clientBuild, info?.build);
  const room = Math.max(1, height - (m.update ? 9 : 8) - (m.error ? 1 : 0) - (skew === "same" || skew === "unknown" ? 0 : 1));
  const shown = projects.slice(0, room);
  const meta = info
    ? [`${info.os}/${info.arch}`, `daemon ${info.daemonVersion}`, info.claudeCodeVersion ? `claude ${info.claudeCodeVersion}` : "", info.tailnetName ?? ""].filter(Boolean).join("  ·  ")
    : m.saved.url;
  return (
    <>
      <Text wrap="truncate">
        <Text color={T.text} bold>{(info?.name ?? m.saved.name).toUpperCase()}</Text>
        {/* The same colour the row uses, from the same place: the pane that
            explains `offline` must not paint it as the error the row says it
            is not. Every other state keeps the colour it had. */}
        <Text color={connColor(m.conn)}>  {m.conn}</Text>
        {/* The reason belongs beside the word, not a pane away: "offline"
            alone reads like a verdict, and a bad token is a different job
            from a machine that is off. */}
        {m.conn === "offline" && m.error && <Text color={T.subtle}> — {m.error}</Text>}</Text>
      <Text color={T.subtle} wrap="truncate">{meta}</Text>
      {/* Build skew across machines is the normal state here — a client on a
          laptop against a daemon on a Pi — so name it rather than leave the
          reader to find out from behaviour that does not match the code. */}
      {(skew === "behind" || skew === "ahead") && (
        <Text wrap="truncate">
          <Text color={skew === "behind" ? T.warning : T.subtle}>
            {skew === "behind" ? "⚠ this machine runs an older build than your client" : "this machine runs a newer build than your client"}
          </Text>
          <Text color={T.faint}>  {buildLine(info?.build)} vs {buildLine(state.clientBuild)}</Text>
        </Text>
      )}
      {m.error && m.conn !== "offline" && <Text color={T.danger} wrap="truncate">{m.error}</Text>}
      <Box height={1} />
      <Text wrap="truncate"><Counts t={tally} where={` in ${projects.length} project${projects.length === 1 ? "" : "s"}`} /></Text>
      <Text color={T.subtle} wrap="truncate">
        new threads here: {settings?.defaultModel ? modelLabel(settings.defaultModel) : "model from Claude settings"}  ·  {permissionModeLabel(settings?.defaultPermissionMode)}
      </Text>
      {m.update && (
        <Text wrap="truncate">
          <Text color={T.subtle}>last update: </Text>
          <Text color={updateColor(m.update.state)}>{m.update.state}</Text>
          {m.update.toCommit && <Text color={T.subtle}> — {m.update.toCommit}</Text>}
        </Text>
      )}
      <Box height={1} />
      {shown.map((p) => <ProjectLine key={p.id} m={m} p={p} width={width} />)}
      {projects.length === 0 && <Text color={T.subtle} italic>{m.conn === "connected" ? "no projects yet — press a to add one" : "nothing to show until it connects"}</Text>}
      {projects.length > shown.length && <Text color={T.faint}>  … {projects.length - shown.length} more</Text>}
      <Box flexGrow={1} />
      <Text color={T.faint} wrap="truncate">{m.conn === "offline"
        ? "nobody is dialling this machine any more · enter tries again"
        : "enter control panel — update, restart, default model and mode · a add project"}</Text>
    </>
  );
}

/** Counts shared by both summaries, coloured the way the sidebar dots are. */
function Counts({ t, where }: { t: ThreadTally; where?: string }) {
  return (
    <Text>
      <Text color={T.text}>{t.total}</Text>
      <Text color={T.subtle}> thread{t.total === 1 ? "" : "s"}{where ?? ""}</Text>
      {t.running > 0 && <Text color={T.working}>  ·  {t.running} running</Text>}
      {t.waiting > 0 && <Text color={T.awaiting}>  ·  {t.waiting} waiting on you</Text>}
      {t.queued > 0 && <Text color={T.warning}>  ·  {t.queued} queued</Text>}
      {t.files > 0 && (
        <Text>
          <Text color={T.subtle}>  ·  </Text>
          <Text color={T.success}>+{t.additions}</Text>
          <Text color={T.danger}> −{t.deletions}</Text>
          <Text color={T.subtle}> in {t.files} file{t.files === 1 ? "" : "s"}</Text>
        </Text>
      )}
    </Text>
  );
}

const STATUS_W = 11;
const DIFF_W = 12;
const TIME_W = 5;

function ThreadLine({ t, width, tick }: { t: Thread; width: number; tick: number }) {
  const st = t.pendingApprovals > 0 ? "waiting" : t.status;
  const label = st === "idle" ? "" : st === "starting" ? "running" : st;
  const d = t.latestTurn?.diff;
  const diff = d && !d.unavailable && d.files.length > 0 ? `+${d.additions} −${d.deletions}` : "";
  const titleW = Math.max(12, width - 2 - STATUS_W - DIFF_W - TIME_W);
  return (
    <Text wrap="truncate">
      <Text color={statusColor(st, tick % 2 === 0)}>{st === "idle" ? (t.pinnedAt ? "⋆ " : "· ") : "● "}</Text>
      <Text color={T.text}>{truncate(t.title, titleW).padEnd(titleW)}</Text>
      <Text color={st === "error" ? T.danger : st === "waiting" ? T.awaiting : T.subtle}>{label.padEnd(STATUS_W)}</Text>
      <Text>{" ".repeat(Math.max(0, DIFF_W - diff.length))}</Text>
      {diff && <Text><Text color={T.success}>+{d!.additions}</Text><Text color={T.danger}> −{d!.deletions}</Text></Text>}
      <Text color={T.faint}>{relTime(t.lastMessageAt ?? t.createdAt).padStart(TIME_W)}</Text>
    </Text>
  );
}

function ProjectLine({ m, p, width }: { m: MachineState; p: Project; width: number }) {
  const tally = tallyThreads(liveThreads(m, p.id));
  const titleW = Math.max(12, Math.min(34, Math.floor(width * 0.4)));
  const count = (tally.total ? `${tally.total} thread${tally.total === 1 ? "" : "s"}` : "no threads").padEnd(12);
  const busy = (tally.running ? `${tally.running} running  ` : "") + (tally.waiting ? `${tally.waiting} waiting` : "");
  const rest = width - 2 - titleW - count.length - 18;
  return (
    <Text wrap="truncate">
      <Text color={tally.waiting ? T.awaiting : tally.running ? T.working : T.subtle}>{tally.waiting || tally.running ? "● " : "· "}</Text>
      <Text color={T.text}>{truncate(p.title, titleW).padEnd(titleW)}</Text>
      <Text color={T.subtle}>{count}</Text>
      <Text color={tally.waiting ? T.awaiting : T.working}>{busy.padEnd(18)}</Text>
      {rest > 12 && <Text color={T.faint}>{truncate(p.workspaceRoot, rest)}</Text>}
    </Text>
  );
}

function modelLabel(id: string): string {
  return KNOWN_MODELS.find((k) => k.id === id)?.label ?? id;
}

function updateColor(state: MachineUpdate["state"]): string {
  return state === "failed" ? T.danger : state === "succeeded" ? T.success : T.working;
}
