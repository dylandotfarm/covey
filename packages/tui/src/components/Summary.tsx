import React from "react";
import { Box, Text } from "ink";
import { modelLabel, type MachineUpdate, type Project, type Thread } from "@covey/protocol";
import type { AppState, MachineState, PoolMember, SidebarRow, ThreadTally } from "../store.js";
import { liveThreads, byRecency, tallyThreads, permissionModeLabel, projectGroups, fleetMachines, fleetsOf, machineLabel } from "../store.js";
import { threadIsHidden } from "@covey/protocol";
import { T, connColor, connDot, statusColor } from "../theme.js";
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
  const inner = width - 4;
  const m = state.machines.get(row.machine);
  const body = row.kind === "project" && row.pool
    ? <ProjectSummary state={state} pool={row.pool} width={inner} height={height - 1} tick={state.tick} />
    : row.kind === "machines" || row.kind === "fleet" || !m
      ? <MachinesSummary state={state} fleet={row.fleet} height={height - 1} />
      : <MachineSummary m={m} state={state} width={inner} height={height - 1} tick={state.tick} />;
  return (
    /* `100%` for the same reason as `Transcript`: this box clips. */
    <Box flexDirection="column" width="100%" height={height} paddingX={2} paddingTop={1} overflow="hidden">
      {body}
    </Box>
  );
}

/**
 * A project across its pool: the repository, one line per machine that holds
 * it, and the threads of every machine in one list by recency.
 */
function ProjectSummary({ state, pool, width, height, tick }: { state: AppState; pool: PoolMember[]; width: number; height: number; tick: number }) {
  const p = pool[0]?.project;
  if (!p) return <Text color={T.subtle} italic>this project is no longer there</Text>;
  // One pass over each machine's threads: the live ones into the list, the
  // archived and moved ones counted, and a tally per machine for its line.
  const threads: Thread[] = [];
  const perMachine = new Map<string, Thread[]>();
  // `past` is a thread that is over, not one covey hides: the two are counted
  // differently, and the footer names only the first. The word `hidden` means
  // `Thread.hidden` everywhere else in covey, so it is not reused here.
  let past = 0;
  for (const x of pool) {
    const m = state.machines.get(x.machine);
    if (!m) continue;
    const mine: Thread[] = [];
    for (const t of m.threads.values()) {
      if (t.projectId !== x.projectId) continue;
      if (t.archivedAt || t.movedTo) { past++; continue; }
      // Covey's own reviewers, left out exactly as the sidebar leaves them out.
      // A count the reader cannot reconcile with the rows beside it is worse
      // than no count.
      if (threadIsHidden(t, state.showHidden)) continue;
      mine.push(t);
    }
    perMachine.set(x.machine, mine);
    threads.push(...mine);
  }
  threads.sort(byRecency);
  const tally = tallyThreads(threads);
  // Two header lines, a blank, one fact line, a blank, a line per machine, a
  // blank, the footer, and a row to say how many threads did not fit.
  const room = Math.max(1, height - 9 - pool.length);
  const shown = threads.slice(0, room);
  return (
    <>
      <Text color={T.text} bold wrap="truncate">{p.title}</Text>
      <Text color={T.subtle} wrap="truncate">{p.repositoryIdentity ?? p.workspaceRoot}{p.remoteUrl ? `   ${p.remoteUrl}` : ""}</Text>
      <Box height={1} />
      <Text wrap="truncate">
        <Counts t={tally} where={` on ${pool.length} machine${pool.length === 1 ? "" : "s"}`} />
        {past > 0 && <Text color={T.faint}>  ·  {past} archived or moved</Text>}
        {p.baseBranch && <Text color={T.subtle}>  ·  from {p.baseBranch}</Text>}
        {p.defaultModel && <Text color={T.subtle}>  ·  {modelLabel(p.defaultModel, state.machines.get(pool[0]!.machine)?.info?.models)}</Text>}
      </Text>
      <Box height={1} />
      {pool.map((x) => <PoolLine key={x.machine} state={state} x={x} tally={tallyThreads(perMachine.get(x.machine) ?? [])} width={width} />)}
      <Box height={1} />
      {shown.map((t) => <ThreadLine key={t.id} t={t} width={width} tick={tick} />)}
      {threads.length === 0 && <Text color={T.subtle} italic>no threads yet — press n to start one</Text>}
      {threads.length > shown.length && <Text color={T.faint}>  … {threads.length - shown.length} more</Text>}
      <Box flexGrow={1} />
      <Text color={T.faint} wrap="truncate">enter fold · n new thread · b base branch · ctrl+k add a machine to this project · D remove project</Text>
    </>
  );
}

/**
 * One machine of a pool: its state, what runs there, and where its copy of
 * the project is. The path takes whatever room the counts leave, because it
 * is the one fact about a clone that nothing else on screen shows.
 */
function PoolLine({ state, x, tally, width }: { state: AppState; x: PoolMember; tally: ThreadTally; width: number }) {
  const m = state.machines.get(x.machine);
  if (!m) return null;
  const name = machineLabel(state, x.machine).padEnd(12);
  const count = (tally.total ? `${tally.total} thread${tally.total === 1 ? "" : "s"}` : "no threads").padEnd(12);
  const busy = (tally.running ? `${tally.running} running  ` : "") + (tally.waiting ? `${tally.waiting} waiting` : "");
  const busyW = busy ? 18 : 0;
  const rest = width - 2 - name.length - count.length - busyW;
  const where = x.project.kind === "clone" ? x.project.workspaceRoot : `${x.project.workspaceRoot} (a checkout of your own)`;
  return (
    <Text wrap="truncate">
      <Text color={connColor(m.conn)}>{connDot(m.conn)} </Text>
      <Text color={T.text}>{name}</Text>
      <Text color={T.subtle}>{count}</Text>
      {busy && <Text color={tally.waiting ? T.awaiting : T.working}>{busy.padEnd(busyW)}</Text>}
      {rest > 8 && <Text color={T.faint}>{truncate(where, rest)}</Text>}
    </Text>
  );
}

/**
 * Every machine of one fleet, its state, and how many projects it holds.
 *
 * `fleet` is the fleet whose row the cursor is on. Without one — a cursor on
 * nothing, which is how this pane is reached before any machine answers — it
 * is every machine the client has.
 */
function MachinesSummary({ state, fleet, height }: { state: AppState; fleet?: string; height: number }) {
  const keys = fleet === undefined ? state.order : fleetMachines(state, fleet);
  const shown = keys.slice(0, Math.max(1, height - 4));
  const groups = projectGroups(state, fleet).length;
  // The name only when there is a second fleet to tell it from.
  const title = fleet !== undefined && fleetsOf(state).length > 1 ? `${fleet} — MACHINES` : "MACHINES";
  return (
    <>
      <Text color={T.text} bold wrap="truncate">{title}</Text>
      <Text color={T.subtle} wrap="truncate">{keys.length} machine{keys.length === 1 ? "" : "s"}  ·  {groups} project{groups === 1 ? "" : "s"}</Text>
      <Box height={1} />
      {shown.map((k) => {
        const m = state.machines.get(k)!;
        const name = machineLabel(state, k).padEnd(12);
        const meta = m.conn === "connected" ? [m.info?.os ?? "", m.info?.daemonVersion ? `daemon ${m.info.daemonVersion}` : ""].filter(Boolean).join("  ·  ") : m.conn === "offline" ? (m.error ?? "offline") : m.conn;
        return (
          <Text key={k} wrap="truncate">
            <Text color={connColor(m.conn)}>{connDot(m.conn)} </Text>
            <Text color={T.text}>{name}</Text>
            <Text color={T.subtle}>{`${m.projects.size} project${m.projects.size === 1 ? "" : "s"}`.padEnd(12)}</Text>
            <Text color={m.conn === "offline" ? connColor(m.conn) : T.subtle}>{meta}</Text>
          </Text>
        );
      })}
      {keys.length === 0 && <Text color={T.subtle} italic>no machines — ctrl+k adds one</Text>}
      <Box flexGrow={1} />
      <Text color={T.faint} wrap="truncate">enter unfold · enter on a machine opens its control panel · ctrl+k add machine</Text>
    </>
  );
}

function MachineSummary({ m, state, width, height, tick }: { m: MachineState; state: AppState; width: number; height: number; tick: number }) {
  const info = m.info;
  const projects = [...m.projects.values()].sort((a, b) => a.title.localeCompare(b.title));
  const tally = tallyThreads(liveThreads(m, undefined, state.showHidden));
  const settings = info?.settings;
  const skew = buildSkew(state.clientBuild, info?.build);
  const room = Math.max(1, height - (m.update ? 10 : 9) - (m.error ? 1 : 0) - (skew === "same" || skew === "unknown" ? 0 : 1));
  const webAt = info?.webAddresses?.find((a) => a.reachable)?.url;
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
        new threads here: {settings?.defaultModel ? modelLabel(settings.defaultModel, info?.models) : "model from Claude settings"}  ·  {permissionModeLabel(settings?.defaultPermissionMode)}
      </Text>
      <Text wrap="truncate">
        <Text color={T.subtle}>web server: </Text>
        <Text color={settings?.webEnabled ? T.success : T.subtle}>{settings?.webEnabled ? "on" : "off"}</Text>
        {settings?.webEnabled && <Text color={T.subtle}>  ·  {webAt ?? "no address the daemon listens on"}</Text>}
        {settings?.bind && <Text color={T.subtle}>  ·  listens on {settings.bind}</Text>}
      </Text>
      {m.update && (
        <Text wrap="truncate">
          <Text color={T.subtle}>last update: </Text>
          <Text color={updateColor(m.update.state)}>{m.update.state}</Text>
          {m.update.toCommit && <Text color={T.subtle}> — {m.update.toCommit}</Text>}
        </Text>
      )}
      <Box height={1} />
      {shown.map((p) => <ProjectLine key={p.id} m={m} p={p} width={width} showHidden={state.showHidden} />)}
      {projects.length === 0 && <Text color={T.subtle} italic>{m.conn === "connected" ? "no projects yet — press a to add one" : "nothing to show until it connects"}</Text>}
      {projects.length > shown.length && <Text color={T.faint}>  … {projects.length - shown.length} more</Text>}
      <Box flexGrow={1} />
      <Text color={T.faint} wrap="truncate">{m.conn === "offline"
        ? "nobody is dialling this machine any more · enter tries again"
        : "enter control panel — update, restart, web server, default model and mode · a add project"}</Text>
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

function ProjectLine({ m, p, width, showHidden }: { m: MachineState; p: Project; width: number; showHidden: boolean }) {
  const tally = tallyThreads(liveThreads(m, p.id, showHidden));
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

function updateColor(state: MachineUpdate["state"]): string {
  return state === "failed" ? T.danger : state === "succeeded" ? T.success : T.working;
}
