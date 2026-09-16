import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { appendFileSync } from "node:fs";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { KNOWN_MODELS, type Attachment, type PermissionMode, type WorkspaceMode, type UsageGroupBy } from "@covey/protocol";
import { Store, USAGE_WINDOWS, sidebarRows, archiveKey, selectionBounds, workspaceOptions, workspaceModeLabel, permissionModeLabel, isLoopbackUrl, previewPage, browseRows, isFolderName, parentPath, type PickOption, type Selection, type SidebarRow, type Overlay } from "../store.js";
import { diffToLines, selectedText, activityLine, truncate } from "../lines.js";
import { parseMouse, copyToClipboard, type MouseEvent } from "../mouse.js";
import { sidebarCells, rowAtScreenRow, cursorIndex } from "../sidebar.js";
import { Sidebar } from "./Sidebar.js";
import { Summary } from "./Summary.js";
import { Transcript, layoutTranscript } from "./Transcript.js";
import { DiffPanel } from "./DiffPanel.js";
import { Composer } from "./Composer.js";
import { OverlayView, filterOptions } from "./Overlay.js";
import * as Ed from "../editor.js";
import { readClipboardImage, readDroppedFiles } from "../attachments.js";
import { T } from "../theme.js";

const SIDEBAR_W = 34;
/** Screen row (1-based) of the sidebar list's first line: below the title. */
const SIDEBAR_TOP = 2;
/**
 * How long the sidebar cursor has to sit still before the thread under it is
 * opened. Long enough that holding ↓ through a list costs one subscription
 * rather than one per row, short enough that a deliberate move feels immediate.
 */
const PREVIEW_MS = 120;

/** shift+tab order. Bypass sits third so it is two presses from default. */
const PERMISSION_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

/** The machine-wide default mode, in plain words. "" clears it. */
const MACHINE_MODES: PickOption[] = [
  { id: "", label: "From Claude settings", hint: "permissions.defaultMode" },
  { id: "default", label: "Manual", hint: "approve every tool" },
  { id: "acceptEdits", label: "Auto", hint: "file edits go through, other tools ask" },
  { id: "bypassPermissions", label: "Bypass", hint: "never ask" },
];

/** What `g` cycles through in the usage overlay. */
const USAGE_GROUPINGS: UsageGroupBy[] = ["thread", "project", "model", "machine"];

export function App({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const on = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", on);
    return () => { stdout.off("resize", on); };
  }, [stdout]);

  /**
   * The sidebar cursor is a row key, not an index. The tree re-sorts under it
   * — a turn on any machine moves its thread to the top of its project — and
   * an index would then point at a different thread than it did a moment ago,
   * with the preview opening a conversation nobody asked for.
   */
  const [cursorKey, setCursorKey] = useState("");
  /** The index that key was on, for when the row it names goes away. */
  const lastCursor = useRef(0);
  const [ovCursor, setOvCursor] = useState(0);
  const [ovFilter, setOvFilter] = useState("");
  const [ovToggle, setOvToggle] = useState(false);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  // Answering a question uses its own buffer and cursor so the composer draft
  // is preserved across the interruption.
  const [answerDraft, setAnswerDraft] = useState("");
  const [questionCursor, setQuestionCursor] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimer = useRef<NodeJS.Timeout | null>(null);
  /** Transcript line the mouse went down on, so a click can fold what it hit. */
  const pressedLine = useRef<number | null>(null);

  const rows = useMemo(() => sidebarRows(state), [state]);
  const cursor = cursorIndex(rows, cursorKey, lastCursor.current);
  const sidebarVisible = !state.sidebarCollapsed && size.cols >= 70;
  // Hoisted out of Sidebar for the same reason the transcript's lines are:
  // the click hit test and the painter have to agree on which row is where.
  const cells = useMemo(() => sidebarCells(rows, cursor, Math.max(0, size.rows - 2)), [rows, cursor, size.rows]);
  const mainW = size.cols - (sidebarVisible ? SIDEBAR_W : 0);
  const pending = store.pendingRequest();
  // Wrap here rather than in Composer: the box has to be sized to the wrapped
  // row count, so both need the same answer.
  const editorRows = useMemo(() => Ed.wrapEditorLines(draft, mainW - 4), [draft, mainW]);
  const maxEditorRows = 10;
  const attachmentCount = state.view ? store.attachments(state.view.threadId).length : 0;
  const composerRows = pending
    ? 3 + (pending.kind === "question" && answerDraft.length > 0 ? 1 : 0)
    : Math.min(maxEditorRows, Math.max(1, editorRows.length)) + 2 + (attachmentCount > 0 ? 1 : 0);
  const transcriptH = Math.max(3, size.rows - composerRows - 2 - 1);
  const baseLayout = useMemo(() => layoutTranscript(state.view, mainW - 2, state.expandedItems, questionCursor, state.toolsExpanded), [state.view, mainW, state.expandedItems, questionCursor, state.toolsExpanded]);
  // Append the live activity row outside the heavy memo, so the spinner can
  // animate without re-rendering every timeline item.
  const layout = useMemo(() => {
    const turn = state.view?.thread?.latestTurn;
    if (!turn || turn.state !== "running") return baseLayout;
    const items = [...(state.view?.items.values() ?? [])];
    const tools = items.filter((i) => i.kind === "tool" && i.turnId === turn.turnId);
    const active = tools.find((i) => i.kind === "tool" && i.status === "running");
    return {
      ...baseLayout,
      lines: [...baseLayout.lines, activityLine({
        tick: state.tick,
        elapsedMs: Date.now() - Date.parse(turn.startedAt),
        tools: tools.length,
        toolActive: !!active,
      })],
    };
  }, [baseLayout, state.view, state.tick]);
  // Hoisted out of DiffPanel so mouse hit-testing and rendering agree on the
  // same line array.
  const diffLines = useMemo(() => (state.diffView?.diff ? diffToLines(state.diffView.diff.patch, mainW - 2) : []), [state.diffView?.diff, mainW]);
  const machineName = state.view ? (state.machines.get(state.view.machine)?.info?.name ?? "") : "";

  useEffect(() => { lastCursor.current = cursor; }, [cursor]);
  // The key has to name a row that exists. When the row it named has gone,
  // `cursorIndex` has already fallen back to the nearest surviving one; write
  // that row's key back, or the cursor is an index again until the next move.
  useEffect(() => {
    if (rows.length > 0 && !rows.some((r) => r.key === cursorKey)) setCursorKey(rows[cursor]!.key);
  }, [rows, cursorKey, cursor]);
  // Reset the answer buffer when a different request comes up, so a stale
  // half-typed answer never carries into the next question.
  const pendingId = pending && (pending.kind === "approval" || pending.kind === "question") ? pending.requestId : null;
  useEffect(() => { setAnswerDraft(""); setQuestionCursor(0); }, [pendingId]);
  // A relaunch is the CLI's job (it rebuilds and re-execs); all we do is
  // unmount cleanly so the terminal is handed back in one piece.
  useEffect(() => { if (state.relaunch) { store.shutdown(); exit(); } }, [state.relaunch, store, exit]);
  // per-thread drafts
  const threadKey = state.selected?.threadId ?? "";
  useEffect(() => { setDraft(store.draft(threadKey)); setCaret(store.draft(threadKey).length); }, [threadKey, store]);
  useEffect(() => { store.setDraft(threadKey, draft); }, [draft, threadKey, store]);

  const openPick = (title: string, options: PickOption[], onPick: (id: string, checked: boolean) => void, toggle?: string) => { setOvCursor(0); setOvFilter(""); setOvToggle(false); store.setOverlay({ kind: "pick", title, options, onPick, toggle }); };
  const openInput = (title: string, onSubmit: (v: string) => void, initial = "", placeholder?: string, onCancel?: () => void) => { setOvFilter(initial); store.setOverlay({ kind: "input", title, onSubmit, initial, placeholder, onCancel }); };

  // ---- actions ----------------------------------------------------------------
  const currentRow = rows[cursor];

  /**
   * Move the cursor `delta` rows and remember the row it lands on. The update
   * is functional because Ink hands a batched chunk of j/k — or of wheel
   * events — to one handler call: reading `cursor` from the closure would make
   * the whole chunk one step.
   */
  const moveCursor = (delta: number) => setCursorKey((k) => {
    const to = rows[Math.max(0, Math.min(rows.length - 1, cursorIndex(rows, k, lastCursor.current) + delta))];
    return to ? to.key : k;
  });
  /** Put the cursor on a row the mouse found, by index. */
  const pointCursor = (index: number) => { const r = rows[index]; if (r) setCursorKey(r.key); };
  const contextMachine = state.selected?.machine ?? currentRow?.machine ?? state.order[0];
  const contextProject = state.view?.thread?.projectId ?? currentRow?.projectId;

  /**
   * Moving the sidebar cursor shows what it is pointing at: a thread opens in
   * the transcript, a project or machine draws its summary (below). Only the
   * thread costs anything, so it is debounced — holding ↓ through a long list
   * should not fetch a snapshot per row. Focus stays where it is: this is
   * browsing, not opening.
   */
  const hoverMachine = currentRow?.kind === "thread" ? currentRow.machine : null;
  const hoverThread = currentRow?.kind === "thread" ? currentRow.thread!.id : null;
  const openMachine = state.selected?.machine ?? null;
  const openThread = state.selected?.threadId ?? null;
  useEffect(() => {
    if (!sidebarVisible || state.focus !== "sidebar" || !hoverMachine || !hoverThread) return;
    if (hoverMachine === openMachine && hoverThread === openThread) return;
    // A screen's worth, not the whole conversation: a preview can only paint
    // `transcriptH` lines, and the items it cannot paint still cost a fetch and
    // a full re-layout on every frame. The rest arrives if the reader stays.
    const t = setTimeout(() => void store.select({ machine: hoverMachine, threadId: hoverThread }, previewPage(transcriptH)), PREVIEW_MS);
    return () => clearTimeout(t);
  }, [sidebarVisible, state.focus, hoverMachine, hoverThread, openMachine, openThread, transcriptH, store]);

  /**
   * The main pane stands in for the conversation while the cursor is on a
   * project or a machine. The archived folder is a container, not a place, so
   * it keeps showing whatever conversation is open.
   */
  const summaryRow = sidebarVisible && state.focus === "sidebar" && currentRow && (currentRow.kind === "project" || currentRow.kind === "machine" || currentRow.kind === "empty") ? currentRow : null;

  /**
   * That page is sized in items but the pane is measured in lines, so a thread
   * of one-line items can come up short. Nobody should see a half-empty
   * transcript because of how we paged it: ask for another page until it covers
   * the pane, or there is nothing older left. Only while the transcript is the
   * pane on screen — filling one nobody is looking at is the work we just went
   * to the trouble of not doing.
   */
  const transcriptOnScreen = !state.overlay && !state.diffView && !summaryRow;
  const shortOfScreen = transcriptOnScreen && !!state.view && !state.view.loading && !state.view.loadingOlder && state.view.hasMore && layout.lines.length < transcriptH;
  useEffect(() => { if (shortOfScreen) void store.loadOlder(previewPage(transcriptH)); }, [shortOfScreen, transcriptH, store]);

  const addProject = (machine = contextMachine) => {
    if (!machine) return;
    const connected = state.order.filter((k) => state.machines.get(k)?.conn === "connected");
    const start = (mk: string) => {
      const home = state.machines.get(mk)?.info?.homeDir ?? "~";
      setOvCursor(0); setOvFilter("");
      void store.browse(mk, home, (path) => { store.setOverlay(null); void store.threadCommand({ type: "project.create", workspaceRoot: path }, mk); });
    };
    if (connected.length > 1 && !currentRow) openPick("Add project on which machine?", connected.map((k) => ({ id: k, label: state.machines.get(k)!.info!.name })), start);
    else start(machine);
  };

  /**
   * Make a folder in the directory being browsed, for a project that has no
   * directory yet. `store.mkdir` reopens the browser inside the new folder, so
   * the filter that named it has to go — it would hide everything there.
   */
  const makeFolder = (ov: Extract<Overlay, { kind: "browse" }>, name: string) => {
    setOvCursor(0); setOvFilter("");
    void store.mkdir(ov.machine, ov.path, name, ov.onPick);
  };

  /** Ask for a folder name; esc goes back to the directory it was asked from. */
  const askFolderName = (ov: Extract<Overlay, { kind: "browse" }>, initial: string) => {
    const back = () => { setOvCursor(0); setOvFilter(""); void store.browse(ov.machine, ov.path, ov.onPick); };
    openInput(`New folder in ${ov.path}`, (v) => (v ? makeFolder(ov, v) : back()), initial, "name", back);
  };

  const project = (machine?: string, projectId?: string) =>
    machine && projectId ? state.machines.get(machine)?.projects.get(projectId) : undefined;

  /**
   * New thread. In a git repo the first one in a project asks where it should
   * work — a worktree keeps parallel threads from fighting over one checkout —
   * and can remember the answer on the project. `mode` skips the question.
   */
  const newThread = async (machine = contextMachine, projectId = contextProject, mode?: WorkspaceMode) => {
    if (!machine || !projectId) { store.notify("select a project first", "error"); return; }
    const remembered = mode ?? project(machine, projectId)?.defaultWorkspaceMode ?? null;
    if (remembered) { await store.createThread(machine, projectId, { workspaceMode: remembered }); return; }
    const git = await store.projectGit(machine, projectId);
    // Not a repo, or a repo with nothing to branch from yet: no choice to make.
    if (!git?.isRepo || !git.hasCommits) { await store.createThread(machine, projectId, { workspaceMode: "checkout" }); return; }
    openPick(`New thread in ${project(machine, projectId)?.title ?? "project"} — work where?`, workspaceOptions(git), (id, remember) => {
      store.setOverlay(null);
      const picked = id as WorkspaceMode;
      if (remember) void store.setProjectWorkspaceMode(machine, projectId, picked);
      void store.createThread(machine, projectId, { workspaceMode: picked });
    }, "remember my choice for this project");
  };

  /** Change (or clear) the remembered answer without creating a thread. */
  const chooseDefaultWorkspace = async (machine = contextMachine, projectId = contextProject) => {
    if (!machine || !projectId) { store.notify("select a project first", "error"); return; }
    const git = await store.projectGit(machine, projectId);
    if (!git?.isRepo) { store.notify("not a git repository — threads run in the project directory"); return; }
    const rows: PickOption[] = [{ id: "ask", label: "Ask every time", hint: "default" }, ...workspaceOptions(git)];
    openPick(`New threads in ${project(machine, projectId)?.title ?? "project"}`, rows, (id) => {
      store.setOverlay(null);
      const mode = id === "ask" ? null : (id as WorkspaceMode);
      void store.setProjectWorkspaceMode(machine, projectId, mode);
      store.notify(`new threads: ${workspaceModeLabel(mode)}`);
    });
  };

  const moveThread = () => {
    const sel = currentRow?.kind === "thread" ? { machine: currentRow.machine, threadId: currentRow.thread!.id } : state.selected;
    if (!sel) return;
    const srcThread = state.machines.get(sel.machine)?.threads.get(sel.threadId);
    const srcProject = srcThread && state.machines.get(sel.machine)?.projects.get(srcThread.projectId);
    const targets = state.order.filter((k) => k !== sel.machine && state.machines.get(k)?.conn === "connected");
    if (targets.length === 0) { store.notify("no other connected machine to move to", "error"); return; }
    openPick("Move thread to machine", targets.map((k) => ({ id: k, label: state.machines.get(k)!.info!.name, hint: state.machines.get(k)!.info!.os })), (mk) => {
      const m = state.machines.get(mk)!;
      const projects = [...m.projects.values()];
      const same = srcProject?.repositoryIdentity ? projects.filter((p) => p.repositoryIdentity === srcProject.repositoryIdentity) : [];
      const opts: PickOption[] = [
        ...same.map((p) => ({ id: `p:${p.id}`, label: p.title, hint: "same repo ✓" })),
        ...projects.filter((p) => !same.includes(p)).map((p) => ({ id: `p:${p.id}`, label: p.title, hint: p.workspaceRoot })),
        { id: "browse", label: "Browse for a directory…", hint: "" },
      ];
      openPick(`Destination project on ${m.info!.name}`, opts, (pid) => {
        store.setOverlay(null);
        if (pid === "browse") void store.browse(mk, m.info?.homeDir ?? "~", (path) => { store.setOverlay(null); void store.moveThread(sel, { machine: mk, workspaceRoot: path }); });
        else void store.moveThread(sel, { machine: mk, projectId: pid.slice(2) });
      });
    });
  };

  const runningTurns = (machineKey: string) =>
    [...(state.machines.get(machineKey)?.threads.values() ?? [])].filter((t) => t.status === "running" || t.status === "starting").length;

  /**
   * Machine control panel — what used to need an ssh session: update the daemon
   * from git and restart it, and set the defaults every new thread on that
   * machine inherits. Opened with enter on a machine row.
   */
  const machinePanel = (machineKey = contextMachine) => {
    const m = machineKey ? state.machines.get(machineKey) : undefined;
    if (!m) return;
    if (m.conn !== "connected" || !m.info) { store.notify(`${m.saved.name} is ${m.conn}`, "error"); return; }
    const info = m.info;
    const settings = info.settings ?? { defaultModel: null, defaultPermissionMode: null };
    const busy = runningTurns(machineKey!);
    const modelLabel = settings.defaultModel
      ? (KNOWN_MODELS.find((k) => k.id === settings.defaultModel)?.label ?? settings.defaultModel)
      : "from Claude settings";
    const opts: PickOption[] = [
      { id: "update", label: "Update — pull, rebuild, restart", hint: busy ? "interrupts running turns" : "" },
      { id: "restart", label: "Restart the daemon", hint: busy ? `${busy} running` : "" },
      { id: "model", label: `Default model: ${modelLabel}`, hint: "new threads here" },
      { id: "mode", label: `Default mode: ${permissionModeLabel(settings.defaultPermissionMode)}`, hint: "new threads here" },
    ];
    if (m.update) opts.push({ id: "log", label: "Show the last update's log", hint: m.update.state });
    openPick(`${info.name} — ${info.os}/${info.arch} · daemon ${info.daemonVersion}${info.claudeCodeVersion ? ` · claude ${info.claudeCodeVersion}` : ""}`, opts, (id) => {
      switch (id) {
        case "update": return void confirmUpdate(machineKey!);
        case "restart": return confirmRestart(machineKey!);
        case "model": return openPick(`Default model on ${info.name}`, [
          { id: "", label: "From Claude settings", hint: settings.defaultModel ? "" : "current" },
          ...KNOWN_MODELS.map((k) => ({ id: k.id, label: k.label, hint: k.id === settings.defaultModel ? "current" : k.id })),
        ], (mid) => {
          store.setOverlay(null);
          void store.setMachineDefaults(machineKey!, { defaultModel: mid || null });
          store.notify(`${info.name}: new threads use ${mid ? (KNOWN_MODELS.find((k) => k.id === mid)?.label ?? mid) : "the model from Claude settings"}`);
        });
        case "mode": return openPick(`Default mode on ${info.name}`, MACHINE_MODES.map((o) => ({
          ...o, hint: (o.id === "" ? settings.defaultPermissionMode === null : o.id === settings.defaultPermissionMode) ? "current" : o.hint,
        })), (mid) => {
          store.setOverlay(null);
          const mode = (mid || null) as PermissionMode | null;
          void store.setMachineDefaults(machineKey!, { defaultPermissionMode: mode });
          store.notify(`${info.name}: new threads start in ${permissionModeLabel(mode)}`, mode === "bypassPermissions" ? "error" : "info");
        });
        case "log": { store.setOverlay({ kind: "update", machine: machineKey! }); return; }
      }
    });
  };

  /** The connected daemon that runs on this machine, if the TUI has one. */
  const localMachineKey = () => state.order.find((k) => isLoopbackUrl(k) && state.machines.get(k)?.conn === "connected");

  /**
   * Update covey itself. The client cannot rebuild the code it is running from
   * inside its own event loop, so it quits with a request the CLI carries out:
   * pull, rebuild, then start us again. The daemon on that same checkout is
   * just as stale, so restarting it is offered in the same breath — at the cost
   * of the turns it is running.
   */
  const updateClient = () => {
    const src = store.clientSource;
    if (!store.canRelaunch) { store.notify("start covey through the `covey` command to update it from inside", "error"); return; }
    if (!src?.canUpdate) { store.notify(`this client cannot update itself: ${src?.reason ?? "no git checkout"}`, "error"); return; }
    const localKey = localMachineKey();
    const busy = localKey ? runningTurns(localKey) : 0;
    const both: PickOption = { id: "both", label: "Update, restart the daemon and relaunch", hint: busy ? `ends ${busy} running turn${busy === 1 ? "" : "s"}` : "new code everywhere" };
    const clientOnly: PickOption = { id: "client", label: "Update and relaunch this client", hint: "daemon keeps the old build" };
    openPick(`Update covey? (${src.branch ?? "detached"} @ ${src.commit ?? "?"})`, [
      { id: "no", label: "Cancel", hint: src.root ?? "" },
      // When turns are running, the option that does not kill them comes first.
      ...(!localKey ? [{ id: "client", label: "Update and relaunch", hint: src.dirty ? "local changes may block the pull" : "" }]
        : busy ? [clientOnly, both] : [both, clientOnly]),
    ], (id) => {
      store.setOverlay(null);
      if (id === "no") return;
      store.requestRelaunch({ update: true, restartDaemon: id === "both" });
    });
  };

  /** Ask before an update: it pulls into the daemon's own checkout and restarts it. */
  const confirmUpdate = async (machineKey: string) => {
    const name = state.machines.get(machineKey)?.info?.name ?? "machine";
    const src = await store.machineSource(machineKey);
    if (!src) return;
    if (!src.canUpdate) { store.setOverlay(null); store.notify(`${name} cannot update itself: ${src.reason ?? "no git checkout"}`, "error"); return; }
    // Same machine, same checkout: updating it updates the code this client is
    // running too, so do the whole thing at once instead of building twice.
    const mine = store.clientSource;
    if (store.canRelaunch && mine?.root && mine.root === src.root && isLoopbackUrl(machineKey)) { store.setOverlay(null); updateClient(); return; }
    const busy = runningTurns(machineKey);
    const warn = [src.dirty ? "local changes may block the pull" : "", busy ? `${busy} running turn${busy === 1 ? "" : "s"} will be interrupted` : ""].filter(Boolean).join(" · ");
    openPick(`Update ${name}? (${src.branch ?? "detached"} @ ${src.commit ?? "?"})`, [
      { id: "no", label: "Cancel", hint: src.root ?? "" },
      { id: "yes", label: "Pull, rebuild and restart", hint: warn },
    ], (id) => {
      if (id !== "yes") { store.setOverlay(null); return; }
      void store.updateMachine(machineKey);
    });
  };

  const confirmRestart = (machineKey: string) => {
    const name = state.machines.get(machineKey)?.info?.name ?? "machine";
    const busy = runningTurns(machineKey);
    openPick(`Restart the daemon on ${name}?`, [
      { id: "no", label: "Cancel" },
      { id: "yes", label: "Restart now", hint: busy ? `${busy} running turn${busy === 1 ? "" : "s"} will be interrupted` : "threads keep their history" },
    ], (id) => {
      store.setOverlay(null);
      if (id === "yes") void store.restartMachine(machineKey);
    });
  };

  const palette = () => {
    const t = state.view?.thread;
    const opts: PickOption[] = [];
    if (t) {
      opts.push({ id: "move", label: "Move thread to another machine", hint: "m" });
      opts.push({ id: "rename", label: "Rename thread", hint: "r" });
      opts.push({ id: "model", label: `Model: ${t.model ?? "default"}` });
      opts.push({ id: "mode", label: `Permission mode: ${t.permissionMode}` });
      opts.push({ id: "diff", label: "Show changes from the last turn", hint: "d" });
      if (t.latestTurn?.state === "running") opts.push({ id: "background", label: "Background the running tool calls", hint: "ctrl+b" });
      opts.push({ id: "revert", label: "Revert to before a turn… (files + conversation)" });
      if (t.queuedTurns > 0) opts.push({ id: "clearqueue", label: `Cancel ${t.queuedTurns} queued message${t.queuedTurns === 1 ? "" : "s"}` });
      opts.push({ id: "archive", label: t.archivedAt ? "Unarchive thread" : "Archive thread", hint: "x" });
      opts.push({ id: "stop", label: "Stop session process" });
    }
    opts.push({ id: "new", label: "New thread", hint: "n" });
    opts.push({ id: "newwt", label: "New thread in git worktree", hint: "N" });
    if (contextProject) opts.push({ id: "startmode", label: `New threads here: ${workspaceModeLabel(project(contextMachine, contextProject)?.defaultWorkspaceMode)}` });
    opts.push({ id: "addproject", label: "Add project", hint: "a" });
    opts.push({ id: "usage", label: "Usage — tokens and estimated cost, per period", hint: "every machine" });
    opts.push({ id: "machine", label: "Machine control panel — update, restart, defaults", hint: "enter on a machine" });
    opts.push({ id: "updateclient", label: "Update covey — pull, rebuild, relaunch this client", hint: store.clientSource?.commit ?? "" });
    opts.push({ id: "addmachine", label: "Add machine (ws://host:port)" });
    opts.push({ id: "rmmachine", label: "Remove machine" });
    opts.push({ id: "tools", label: state.toolsExpanded ? "Fold old tool calls into >_ rows" : "Show every tool call", hint: "ctrl+o" });
    opts.push({ id: "help", label: "Keyboard help", hint: "?" });
    openPick("Commands", opts, (id) => {
      store.setOverlay(null);
      switch (id) {
        case "move": return moveThread();
        case "rename": return openInput("Rename thread", (v) => { store.setOverlay(null); void store.threadCommand({ type: "thread.rename", threadId: t!.id, title: v }); }, t!.title);
        case "model": return openPick("Model", [{ id: "", label: "Default (from Claude settings)" }, ...KNOWN_MODELS.map((m) => ({ id: m.id, label: m.label, hint: m.id }))], (mid) => { store.setOverlay(null); void store.threadCommand({ type: "thread.setModel", threadId: t!.id, model: mid || null }); });
        case "mode": return openPick("Permission mode", PERMISSION_CYCLE.map((m) => ({ id: m, label: m, hint: m === "bypassPermissions" ? "runs tools without asking" : m === t!.permissionMode ? "current" : "" })), (m) => { store.setOverlay(null); void store.setPermissionMode(t!.id, m as PermissionMode); });
        case "diff": return void store.toggleDiff();
        case "background": return void store.background();
        case "revert": {
          const turns = [...(state.view?.items.values() ?? [])].filter((i) => i.kind === "user" && i.turnId && !i.queued && !i.folded).sort((a, b) => b.seq - a.seq);
          if (turns.length === 0) return store.notify("no turns to revert", "error");
          return openPick("Revert to before which turn?", turns.map((u) => ({ id: u.turnId!, label: (u as any).text.split("\n")[0].slice(0, 70), hint: new Date(u.createdAt).toLocaleTimeString() })), (turnId) => {
            const u = turns.find((x) => x.turnId === turnId)!;
            openPick(`Revert files and conversation to before "${(u as any).text.slice(0, 40)}"?`, [{ id: "no", label: "Cancel" }, { id: "yes", label: "Revert — this turn and everything after it are discarded" }], (ans) => {
              store.setOverlay(null);
              if (ans === "yes") void store.threadCommand({ type: "turn.revert", threadId: t!.id, turnId }).then(() => store.notify("reverted", "success"));
            });
          });
        }
        case "clearqueue": { for (const it of [...(state.view?.items.values() ?? [])]) if (it.kind === "user" && it.queued) void store.cancelQueued(it.turnId!); return; }
        case "quiet": return;
        case "archive": return void store.threadCommand({ type: "thread.archive", threadId: t!.id, archived: !t!.archivedAt });
        case "stop": return void store.threadCommand({ type: "session.stop", threadId: t!.id });
        case "new": return void newThread();
        case "newwt": return void newThread(contextMachine, contextProject, "worktree-head");
        case "startmode": return void chooseDefaultWorkspace();
        case "addproject": return addProject();
        case "usage": return void store.loadUsage(0, "thread");
        case "machine": return machinePanel();
        case "updateclient": return updateClient();
        case "addmachine": return openInput("Machine URL", (v) => { store.setOverlay(null); const [url, token] = v.split(/\s+/); if (url) store.addMachine({ name: new URL(url).hostname, url, token }); }, "ws://", "ws://host.tailnet.ts.net:3790 [token]");
        case "rmmachine": return openPick("Remove machine", state.order.map((k) => ({ id: k, label: state.machines.get(k)!.saved.name, hint: k })), (k) => { store.setOverlay(null); store.removeMachine(k); });
        case "tools": return store.toggleAllTools();
        case "help": return store.setOverlay({ kind: "help" });
      }
    });
  };

  /**
   * What enter does on a sidebar row, and therefore what a click does too —
   * the point of routing both through here is that the mouse can never learn a
   * different vocabulary from the keyboard.
   */
  const activateRow = (row?: SidebarRow) => {
    if (!row) return;
    switch (row.kind) {
      case "thread": {
        // The preview has usually opened it already; re-selecting would throw
        // away the snapshot and fetch it again. What it does not have is
        // scrollback — it fetched only what it could paint — so opening the
        // thread for real pulls a page of that in behind the transcript.
        if (row.machine !== openMachine || row.thread!.id !== openThread) void store.select({ machine: row.machine, threadId: row.thread!.id });
        else void store.loadOlder();
        store.setFocus("composer");
        return;
      }
      case "project": return store.toggleExpanded(`${row.machine}:${row.projectId}`);
      case "archived": return store.toggleExpanded(archiveKey(row.machine, row.projectId!), false);
      case "machine": return machinePanel(row.machine);
      case "empty": return addProject(row.machine);
    }
  };

  // ---- mouse ----------------------------------------------------------------
  // Screen geometry, 1-based to match the terminal's own coordinates. Row 1 is
  // the header, row 2 the divider, then the transcript box.
  const TRANSCRIPT_TOP = 3;
  const mainX0 = sidebarVisible ? SIDEBAR_W : 0;

  /** Map a screen cell to a line index + column inside a line-based pane.
   *  `forcePane` clamps a drag to the pane it started in — that is what keeps a
   *  selection from leaking into the sidebar. */
  function hitTest(ev: MouseEvent, forcePane?: Selection["pane"]): { pane: Selection["pane"]; line: number; col: number; exact: boolean } | null {
    const pane: Selection["pane"] = forcePane ?? (state.diffView ? "diff" : "transcript");
    const rowInBox = ev.row - TRANSCRIPT_TOP;
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    if (pane === "diff") {
      if (!state.diffView || diffLines.length === 0) return null;
      const bodyH = Math.max(1, transcriptH - 2);
      const start = Math.min(state.diffView.scroll, Math.max(0, diffLines.length - bodyH));
      // DiffPanel has a 2-row header and paddingX={1}
      const line = clamp(start + (rowInBox - 2), 0, diffLines.length - 1);
      return { pane, line, col: Math.max(0, ev.col - 1 - mainX0 - 1), exact: true };
    }
    if (layout.lines.length === 0) return null;
    const end = Math.max(0, layout.lines.length - state.scrollFromBottom);
    const start = Math.max(0, end - transcriptH);
    const pad = Math.max(0, transcriptH - (end - start));
    const line = clamp(start + (rowInBox - pad), start, Math.max(start, end - 1));
    // A short transcript is painted flush to the bottom; rows above it are
    // empty padding, and clamping them onto the first line is fine for a drag
    // but must not count as having clicked that line.
    return { pane, line, col: Math.max(0, ev.col - 1 - mainX0), exact: rowInBox >= pad && start + (rowInBox - pad) < end };
  }

  function copySelection() {
    const sel = state.selection;
    if (!sel) return;
    const lines = sel.pane === "diff" ? diffLines : layout.lines;
    const { from, to } = selectionBounds(sel);
    const text = selectedText(lines, from, to);
    if (!text.trim()) return;
    copyToClipboard(text);
    const n = to.line - from.line + 1;
    store.notify(`copied ${n} line${n === 1 ? "" : "s"}`, "success");
  }

  /**
   * Scroll whatever is on screen: the diff panel when it is open, otherwise the
   * transcript. Positive moves towards the newest line; the huge steps g/G send
   * clamp to the ends. The transcript stores its scroll from the *bottom*, so
   * the sign flips there.
   */
  function scrollPane(lines: number) {
    if (state.diffView) {
      const max = Math.max(0, diffLines.length - Math.max(1, transcriptH - 2));
      store.setDiffScroll(Math.max(0, Math.min(max, state.diffView.scroll + lines)));
      return;
    }
    const max = Math.max(0, layout.lines.length - transcriptH);
    const next = Math.max(0, Math.min(max, state.scrollFromBottom - lines));
    store.setScroll(next);
    if (lines < 0 && next >= max && state.view?.hasMore) void store.loadOlder();
  }

  /** Fold or unfold the most recent tool call or thinking block. */
  function expandLastTool() {
    const items = [...(state.view?.items.values() ?? [])].filter((i) => i.kind === "tool" || i.kind === "thinking").sort((a, b) => b.seq - a.seq);
    if (items[0]) store.toggleItem(items[0].id);
  }

  function handleMouse(ev: MouseEvent) {
    if (state.overlay) return;
    const inSidebar = sidebarVisible && ev.col <= SIDEBAR_W;
    const inTranscript = ev.row >= TRANSCRIPT_TOP && ev.row < TRANSCRIPT_TOP + transcriptH && !inSidebar;

    if (ev.kind === "wheel") {
      const delta = ev.wheel === "up" ? 3 : -3;
      // Over the sidebar the wheel moves the cursor rather than scrolling a
      // viewport of its own: the cursor is what the window is centred on, and
      // one source of truth means the preview follows the wheel too.
      if (inSidebar) {
        store.setFocus("sidebar");
        moveCursor(-delta);
        return;
      }
      if (state.diffView) return store.setDiffScroll(state.diffView.scroll - delta);
      const max = Math.max(0, layout.lines.length - transcriptH);
      const next = Math.min(max, Math.max(0, state.scrollFromBottom + delta));
      store.setScroll(next);
      if (next >= max && state.view?.hasMore) void store.loadOlder();
      return;
    }

    if (ev.kind === "press") {
      store.clearSelection();
      pressedLine.current = null;
      if (inSidebar) {
        // Sidebar rows are chrome, not content: a click does what the keyboard
        // would — move the cursor there and activate the row — instead of
        // starting a text selection.
        store.setFocus("sidebar");
        const idx = rowAtScreenRow(cells, ev.row, SIDEBAR_TOP);
        if (idx == null) return;
        pointCursor(idx);
        activateRow(rows[idx]);
        return;
      }
      if (inTranscript) {
        store.setFocus("composer");
        const hit = hitTest(ev);
        pressedLine.current = hit?.exact ? hit.line : null;
        if (hit) store.beginSelection(hit.pane, hit.line, hit.col);
        return;
      }
      store.setFocus("composer");
      return;
    }

    if (ev.kind === "drag") {
      const sel = state.selection;
      if (!sel) return;
      const hit = hitTest(ev, sel.pane);
      if (hit) store.extendSelection(hit.line, hit.col);
      return;
    }

    if (ev.kind === "release") {
      const line = pressedLine.current;
      pressedLine.current = null;
      if (state.selection?.dragging && store.endSelection()) { copySelection(); return; }
      // Press and release on the same spot is a click, not a drag: on a row
      // that folds something — a `>_` group, a tool call, a thought — it does
      // what the keyboard would.
      if (line != null && !state.diffView) {
        const id = layout.toggles.get(line);
        if (id) store.toggleItem(id);
      }
    }
  }

  // ---- input --------------------------------------------------------------------
  useInput((rawInput, rawKey) => {
    // The kitty protocol reports press *and* release for every key; acting on
    // both would double each keystroke. Repeats are real input, so keep them.
    if (rawKey.eventType === "release") return;
    if (process.env.COVEY_KEYLOG) { try { appendFileSync(process.env.COVEY_KEYLOG, JSON.stringify({ input: rawInput, key: rawKey, focus: state.focus }) + "\n"); } catch { /* ignore */ } }
    // Mouse reports arrive through the same channel as keys; Ink leaves them
    // intact as an unrecognised CSI, so pick them off before anything can treat
    // them as typed text.
    const mouseEvents = parseMouse(rawInput);
    if (mouseEvents.length > 0) {
      for (const m of mouseEvents) handleMouse(m);
      return;
    }
    // Any real keystroke dismisses a selection.
    if (state.selection) store.clearSelection();
    // Ink batches rapid keystrokes (and pastes) into one string. In the
    // composer a multi-char chunk is a paste; elsewhere replay it key by key.
    const special = rawKey.upArrow || rawKey.downArrow || rawKey.leftArrow || rawKey.rightArrow || rawKey.return || rawKey.escape || rawKey.tab || rawKey.backspace || rawKey.delete || rawKey.pageUp || rawKey.pageDown || rawKey.ctrl || rawKey.meta || rawKey.super;
    const editing = state.focus === "composer" && !state.overlay && !pending;
    if (rawInput.length > 1 && !special && !(editing && !/^[\r\n]+$/.test(rawInput))) {
      for (const ch of rawInput) {
        if (ch === "\r" || ch === "\n") handleKey("", { ...rawKey, return: true });
        else if (ch === "\t") handleKey("", { ...rawKey, tab: true });
        else if (ch === "\x1b") handleKey("", { ...rawKey, escape: true });
        else handleKey(ch, rawKey);
      }
      return;
    }
    if (editing && rawInput.length > 1 && !special) {
      // A drag-and-drop arrives as a paste of the file's path. If the whole
      // chunk parses as dropped files, attach them; otherwise it is ordinary text.
      if (state.view) {
        const { attachments, errors } = readDroppedFiles(rawInput);
        for (const e of errors) store.notify(e, "error");
        if (attach(attachments)) return;
        if (errors.length > 0) return;
      }
      // paste: normalise line endings and tabs, then insert
      insert(Ed.normalisePaste(rawInput));
      return;
    }
    handleKey(rawInput, rawKey);
  });

  function handleKey(input: string, key: any) {
    // quit
    if (key.ctrl && input === "c") {
      if (state.overlay) { store.setOverlay(null); return; }
      if (state.focus === "composer" && draft.length > 0) { setDraft(""); setCaret(0); return; }
      if (quitArmed) { store.shutdown(); exit(); return; }
      setQuitArmed(true); store.notify("press ctrl+c again to quit");
      if (quitTimer.current) clearTimeout(quitTimer.current);
      quitTimer.current = setTimeout(() => setQuitArmed(false), 1500);
      return;
    }
    // overlays capture everything
    if (state.overlay) { handleOverlayKey(input, key); return; }
    // The conversation is never focused, so its controls hang off cmd (super)
    // and work from wherever you are — mid-sentence in the composer included.
    // shift makes a scroll a page. cmd needs the kitty protocol; pgup/pgdn
    // below is the fallback where it is unavailable.
    if (key.super && !key.ctrl && !key.meta) {
      const ch = input.toLowerCase();
      const step = key.shift ? Math.max(1, Math.floor(transcriptH / 2)) : 1;
      if (key.upArrow || ch === "k") return scrollPane(-step);
      if (key.downArrow || ch === "j") return scrollPane(step);
      if (ch === "g") return scrollPane(key.shift ? 1e9 : -1e9);
      if (ch === "d") return void store.toggleDiff();
      if (ch === "o") return expandLastTool();
    }
    if ((key.pageUp || key.pageDown) && (state.diffView || state.focus === "composer")) return scrollPane((key.pageUp ? -1 : 1) * Math.max(1, Math.floor(transcriptH / 2)));
    if (state.diffView) {
      if (key.escape || input === "d" || input === "q") return void store.toggleDiff();
      if (key.upArrow || input === "k") return scrollPane(-1);
      if (key.downArrow || input === "j") return scrollPane(1);
      if ((key.ctrl && input === "u")) return scrollPane(-Math.floor(transcriptH / 2));
      if ((key.ctrl && input === "d") || input === " ") return scrollPane(Math.floor(transcriptH / 2));
      if (input === "g") return scrollPane(-1e9);
      if (input === "G") return scrollPane(1e9);
      if (key.tab) { /* fall through to focus cycling */ } else return;
    }
    // shift+tab cycles permission mode, the Claude Code idiom. Ordered so
    // bypass is two presses from default.
    if (key.tab && key.shift) {
      const t = state.view?.thread;
      if (!t) { store.notify("open a thread first", "error"); return; }
      const i = PERMISSION_CYCLE.indexOf(t.permissionMode);
      const next = PERMISSION_CYCLE[(i + 1) % PERMISSION_CYCLE.length]!;
      void store.setPermissionMode(t.id, next);
      return;
    }
    if (key.ctrl && input === "k") return palette();
    if (key.ctrl && input === "t") return store.toggleSidebar();
    if (key.ctrl && input === "o") return store.toggleAllTools();
    // ctrl+b, as in the Claude Code CLI: stop waiting on a tool call that is
    // taking too long. It keeps running and reports back when it is done.
    if (key.ctrl && input === "b") { void store.background(); return; }
    if (key.ctrl && input === "n") { void newThread(); return; }
    if (key.tab) {
      store.setFocus(sidebarVisible && state.focus === "composer" ? "sidebar" : "composer");
      return;
    }
    if (state.focus === "sidebar") return handleSidebarKey(input, key);
    return handleComposerKey(input, key);
  }

  function handleOverlayKey(input: string, key: any) {
    const ov = state.overlay!;
    if (key.escape) { store.setOverlay(null); setOvFilter(""); if (ov.kind === "input") ov.onCancel?.(); return; }
    if (ov.kind === "help" || ov.kind === "update") return;
    if (ov.kind === "usage") {
      const last = USAGE_WINDOWS.length - 1;
      if (key.leftArrow || input === "h") return void store.loadUsage(Math.max(0, ov.window - 1), ov.groupBy);
      if (key.rightArrow || input === "l") return void store.loadUsage(Math.min(last, ov.window + 1), ov.groupBy);
      if (input === "g") {
        const next = USAGE_GROUPINGS[(USAGE_GROUPINGS.indexOf(ov.groupBy) + 1) % USAGE_GROUPINGS.length]!;
        return void store.loadUsage(ov.window, next);
      }
      return;
    }
    if (ov.kind === "input") {
      if (key.return) { ov.onSubmit(ovFilter.trim()); setOvFilter(""); return; }
      if (key.backspace || key.delete) { setOvFilter((f) => f.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setOvFilter((f) => f + input);
      return;
    }
    const list = ov.kind === "pick" ? filterOptions(ov.options, ovFilter) : [];
    const dirs = ov.kind === "browse" ? browseRows(ov.entries, ovFilter) : [];
    const len = ov.kind === "browse" ? dirs.length : list.length;
    if (key.upArrow) return setOvCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setOvCursor((c) => Math.min(len - 1, c + 1));
    if (key.tab && ov.kind === "pick" && ov.toggle) return setOvToggle((t) => !t);
    if (ov.kind === "browse") {
      if (input === " ") { ov.onPick(ov.path); return; }
      if (key.ctrl && input === "n") { askFolderName(ov, isFolderName(ovFilter.trim()) ? ovFilter.trim() : ""); return; }
      if (key.return) {
        const row = dirs[ovCursor];
        if (!row) return;
        if (row.kind === "new") { if (row.name) makeFolder(ov, row.name); else askFolderName(ov, ""); return; }
        const next = row.kind === "up" ? parentPath(ov.path) : joinPath(ov.path, row.name);
        setOvCursor(0); setOvFilter("");
        void store.browse(ov.machine, next, ov.onPick);
        return;
      }
    } else if (key.return) {
      const o = list[ovCursor] as PickOption | undefined;
      if (o && ov.kind === "pick") { setOvFilter(""); ov.onPick(o.id, ovToggle); }
      return;
    }
    if (key.backspace || key.delete) { setOvFilter((f) => f.slice(0, -1)); setOvCursor(0); return; }
    if (input && !key.ctrl && !key.meta) { setOvFilter((f) => f + input); setOvCursor(0); }
  }

  function handleSidebarKey(input: string, key: any) {
    const row = rows[cursor];
    if (key.upArrow || input === "k") return moveCursor(-1);
    if (key.downArrow || input === "j") return moveCursor(1);
    if (key.pageUp) return moveCursor(-10);
    if (key.pageDown) return moveCursor(10);
    if (input === "?") return store.setOverlay({ kind: "help" });
    if (!row) return;
    if (key.return || input === "l" || key.rightArrow) return activateRow(row);
    if (input === "h" || key.leftArrow) {
      // Inside the archived folder, left folds the folder rather than the
      // project the thread happens to belong to.
      if (row.archived) { const k = archiveKey(row.machine, row.projectId!); if (store.isExpanded(k, false)) store.toggleExpanded(k, false); return; }
      if (row.projectId) { const k = `${row.machine}:${row.projectId}`; if (store.isExpanded(k)) store.toggleExpanded(k); }
      return;
    }
    if (input === "n" || input === "N") { if (row.projectId) void newThread(row.machine, row.projectId, input === "N" ? "worktree-head" : undefined); return; }
    if (input === "a") return addProject(row.machine);
    if (input === "d" && state.view) return void store.toggleDiff();
    if (input === "m" && row.kind === "thread") return moveThread();
    if (input === "r" && row.kind === "thread") return openInput("Rename thread", (v) => { store.setOverlay(null); void store.threadCommand({ type: "thread.rename", threadId: row.thread!.id, title: v }, row.machine); }, row.thread!.title);
    if (input === "x" && row.kind === "thread") return void store.threadCommand({ type: "thread.archive", threadId: row.thread!.id, archived: !row.thread!.archivedAt }, row.machine);
    if (input === "D" && row.kind === "thread") return openPick(`Delete "${row.thread!.title}"?`, [{ id: "no", label: "Cancel" }, { id: "yes", label: "Delete thread and its transcript" }], (id) => { store.setOverlay(null); if (id === "yes") void store.threadCommand({ type: "thread.delete", threadId: row.thread!.id }, row.machine); });
    if (input === "D" && row.kind === "project") return openPick(`Remove project "${row.project!.title}"?`, [{ id: "no", label: "Cancel" }, { id: "yes", label: "Remove project and all its threads" }], (id) => { store.setOverlay(null); if (id === "yes") void store.threadCommand({ type: "project.delete", projectId: row.projectId! }, row.machine); });
  }

  function handleComposerKey(input: string, key: any) {
    const running = state.view?.thread?.latestTurn?.state === "running";
    if (key.escape) { if (running) void store.interrupt(); return; }
    if (pending) {
      if (pending.kind === "approval") {
        if (input === "y") return void store.respondApproval("allow");
        if (input === "a") return void store.respondApproval("allow", true);
        if (input === "n") return void store.respondApproval("deny");
        return;
      }
      if (pending.kind === "question") {
        // Answers use their own buffer, never the composer draft — otherwise
        // whatever you were part-way through typing is consumed as the answer
        // and lost. This branch returns unconditionally so `draft` survives.
        const opts = pending.options ?? [];
        const customRow = opts.length;
        // Functional updates throughout: a batched chunk is replayed character
        // by character here, so reading state from the closure would let each
        // replay clobber the last instead of accumulating.
        if (key.upArrow) { setQuestionCursor((c) => Math.max(0, c - 1)); return; }
        if (key.downArrow) { setQuestionCursor((c) => Math.min(customRow, c + 1)); return; }
        if (key.return) {
          if (questionCursor < opts.length) { void store.respondQuestion(opts[questionCursor]!.label); return; }
          const a = answerDraft.trim();
          if (a) { void store.respondQuestion(a); setAnswerDraft(""); }
          return;
        }
        if (answerDraft.length === 0 && /^[1-9]$/.test(input) && Number(input) <= opts.length) {
          void store.respondQuestion(opts[Number(input) - 1]!.label);
          return;
        }
        if (key.backspace || key.delete) { setAnswerDraft((d) => d.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta && !key.super) {
          setQuestionCursor(customRow);
          setAnswerDraft((d) => d + input);
        }
        return;
      }
      return;
    }
    // Enter sends; any modifier on Return means "newline" instead. Shift+Enter
    // only reaches us when the kitty keyboard protocol is active (see
    // index.tsx) — ctrl+j is the universal fallback.
    if (key.return && !key.shift && !key.ctrl && !key.meta && !key.super) {
      if (!state.view) { store.notify("open a thread first (tab → sidebar → enter)"); return; }
      const text = draft.trim();
      // An image on its own is a legitimate turn.
      if (!text && store.attachments(state.view.threadId).length === 0) return;
      void store.sendTurn(text);
      if (running) store.notify("sent — the agent picks it up at its next tool call");
      setDraft(""); setCaret(0);
      return;
    }
    if ((key.ctrl && input === "j") || (key.return && (key.shift || key.meta || key.super))) return insert("\n");
    if (key.backspace || key.delete) {
      // Backspace on an empty composer peels off the last attachment.
      if (key.backspace && draft.length === 0 && state.view && store.removeLastAttachment(state.view.threadId)) return;
      // cmd (super) = line-scoped, alt (meta) = word-scoped, bare = one char.
      const st = { value: draft, caret };
      const fwd = key.delete;
      if (key.super) return applyEdit(fwd ? Ed.deleteToLineEnd(st) : Ed.deleteToLineStart(st));
      if (key.meta) return applyEdit(fwd ? Ed.deleteWordForward(st) : Ed.deleteWordBack(st));
      return applyEdit(fwd ? Ed.deleteForward(st) : Ed.deleteBack(st));
    }
    if (key.leftArrow) return setCaret(key.meta ? Ed.wordStart(draft, caret) : key.super ? Ed.lineStart(draft, caret) : Math.max(0, caret - 1));
    if (key.rightArrow) return setCaret(key.meta ? Ed.wordEnd(draft, caret) : key.super ? Ed.lineEnd(draft, caret) : Math.min(draft.length, caret + 1));
    // Move by *visual* row so a wrapped paragraph steps line by line; at the
    // first and last row the caret parks at the start/end of the draft.
    if (key.upArrow || key.downArrow) return setCaret(Ed.moveVisualRow({ value: draft, caret }, editorRows, key.upArrow ? -1 : 1));
    // Terminals that don't send a modified arrow for alt+←/→ send the readline
    // escapes instead (macOS Terminal ships that mapping), so honour both.
    if (key.meta && input === "b") return setCaret(Ed.wordStart(draft, caret));
    if (key.meta && input === "f") return setCaret(Ed.wordEnd(draft, caret));
    if (key.ctrl && input === "a") return setCaret(Ed.lineStart(draft, caret));
    if (key.ctrl && input === "e") return setCaret(Ed.lineEnd(draft, caret));
    if (key.ctrl && input === "u") return applyEdit(Ed.deleteToLineStart({ value: draft, caret }));
    if (key.ctrl && input === "w") return applyEdit(Ed.deleteWordBack({ value: draft, caret }));
    // Terminals paste with cmd+v (macOS) or ctrl+shift+v (Linux) and send the
    // TUI nothing at all when the clipboard holds an image, so ctrl+v is free
    // for covey to read the clipboard itself.
    if (key.ctrl && input === "v") return pasteClipboardImage();
    if (input && !key.ctrl && !key.meta && !key.super) insert(input);
  }
  /** Hand new attachments to the store. Returns false when there were none. */
  function attach(attachments: Attachment[]): boolean {
    if (attachments.length === 0 || !state.view) return false;
    store.addAttachments(state.view.threadId, attachments);
    store.notify(`attached ${attachments.map((a) => a.name).join(", ")}`, "success");
    return true;
  }
  function pasteClipboardImage() {
    if (!state.view) { store.notify("open a thread first (tab → sidebar → enter)"); return; }
    const { attachment, error } = readClipboardImage();
    if (attachment) attach([attachment]);
    else if (error) store.notify(error, "error");
  }
  function applyEdit(next: Ed.EditState) { setDraft(next.value); setCaret(next.caret); }
  function insert(s: string) { applyEdit(Ed.insert({ value: draft, caret }, s)); }

  // ---- render ---------------------------------------------------------------------
  const notice = state.notice;
  // Overlays that belong to a machine (update progress, directory browsing)
  // read their live data from that machine's state, not from the overlay.
  const overlayMachine = state.overlay && (state.overlay.kind === "update" || state.overlay.kind === "browse") ? state.machines.get(state.overlay.machine) : undefined;
  const overlayUpdate = state.overlay?.kind === "update" ? overlayMachine?.update ?? null : null;
  const overlayMachineName = overlayMachine?.info?.name ?? overlayMachine?.saved.name;
  const header = state.view?.thread;
  const headerProject = header && state.machines.get(state.view!.machine)?.projects.get(header.projectId);
  // The title bar follows the pane: naming the open thread over a project
  // summary would describe something that is not on screen.
  const summaryMachine = summaryRow ? state.machines.get(summaryRow.machine) : undefined;
  const summaryTitle = summaryRow && (summaryRow.kind === "project" ? summaryRow.project!.title : (summaryMachine?.info?.name ?? summaryMachine?.saved.name ?? ""));
  const summarySub = summaryRow && (summaryRow.kind === "project" ? (summaryMachine?.info?.name ?? summaryMachine?.saved.name ?? "") : "machine");
  return (
    <Box width={size.cols} height={size.rows} flexDirection="row">
      {sidebarVisible && <Sidebar state={state} rows={rows} cells={cells} cursor={cursor} width={SIDEBAR_W} focused={state.focus === "sidebar"} />}
      <Box flexDirection="column" width={mainW}>
        <Box height={1} paddingX={2} justifyContent="space-between">
          <Box>
            {summaryRow ? (<><Text color={T.text} bold>{truncate(summaryTitle || "", Math.max(10, mainW - 40))}</Text><Text color={T.subtle}>  {summarySub}</Text></>)
              : header ? (<><Text color={T.text} bold>{header.title.slice(0, Math.max(10, mainW - 40))}</Text><Text color={T.subtle}>  {headerProject?.title}</Text>{header.movedTo && <Text color={T.warning}>  moved</Text>}</>)
              : <Text color={T.subtle}>covey — multi-agent TUI</Text>}
          </Box>
          <Text color={notice ? (notice.tone === "error" ? T.danger : notice.tone === "success" ? T.success : T.muted) : T.faint}>{notice?.text ?? (state.diffView ? "diff: j/k scroll · d close" : state.scrollFromBottom > 0 ? "scrolled · cmd+shift+g follows" : state.focus === "sidebar" ? "↑↓ browse · enter open · click works too" : "ctrl+k commands")}</Text>
        </Box>
        <Box height={1}><Text color={T.border}>{"─".repeat(Math.max(0, mainW))}</Text></Box>
        <Box height={transcriptH} flexDirection="column">
          {state.overlay
            ? <OverlayView overlay={state.overlay} cursor={ovCursor} filter={ovFilter} checked={ovToggle} width={mainW} height={transcriptH} update={overlayUpdate} machineName={overlayMachineName} tick={state.tick} />
            : state.diffView
              ? <DiffPanel view={state.diffView} width={mainW} height={transcriptH} lines={diffLines} selection={state.selection} />
              : summaryRow
                ? <Summary state={state} row={summaryRow} width={mainW} height={transcriptH} />
                : <Transcript view={state.view} layout={layout} height={transcriptH} scrollFromBottom={state.scrollFromBottom} width={mainW} selection={state.selection} />}
        </Box>
        <Composer thread={state.view?.thread ?? null} value={draft} cursor={caret} focused={state.focus === "composer"} width={mainW} pending={pending} machineName={machineName} rows={editorRows} maxRows={maxEditorRows} attachments={state.view ? store.attachments(state.view.threadId) : []} answerDraft={answerDraft} />
      </Box>
    </Box>
  );
}

function joinPath(a: string, b: string) {
  return a.endsWith("/") || a.endsWith("\\") ? a + b : a + (a.includes("\\") ? "\\" : "/") + b;
}
