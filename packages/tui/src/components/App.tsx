import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { KNOWN_MODELS, modelIsCurrent, modelLabel, modelVersion, runMemberStateLabel, secretKeyError, type Attachment, type PermissionMode, type Run, type RunMember, type RunMemberState, type RunTask, type UsageGroupBy } from "@covey/protocol";
import { projectPool } from "@covey/client";
import { repoOptions, branchOptions, DEFAULT_BASE } from "../repos.js";
import { Store, USAGE_WINDOWS, MACHINES_KEY, sidebarRows, archiveKey, runKey, threadGroupKey, groupOfProject, machineLabel, poolMachines, secretPanelKeys, selectionBounds, permissionModeLabel, isLoopbackUrl, previewPage, type PickOption, type Selection, type SidebarRow, type Overlay, type AppState } from "../store.js";
import { ItemLines, diffToLines, selectedText, activityLine, linkAt, truncate, wordRangeAt, wrappedRun, lineWidth } from "../lines.js";
import { hyperlinksEnabled, openCommand, openGesture, osc8, repoUrlOf, type LinkContext } from "../links.js";
import { anchorAt, resolveScroll } from "../scroll.js";

const HYPERLINKS = hyperlinksEnabled();
/** The words for the gesture that opens a link, read once like HYPERLINKS. */
const OPEN_GESTURE = openGesture(process.platform, HYPERLINKS);
import { parseMouse, wheelDelta, copyToClipboard, countClick, type ClickRun, type MouseEvent } from "../mouse.js";
import { sidebarCells, rowAtScreenRow, cursorIndex } from "../sidebar.js";
import { firstUnmet, parseTaskList, withIssueTitles } from "../run.js";
import { buildLine, buildSkew } from "../build.js";
import { Sidebar } from "./Sidebar.js";
import { Summary } from "./Summary.js";
import { Transcript, layoutTranscript } from "./Transcript.js";
import { currentAsk, takeAnswer } from "../question.js";
import { DiffPanel } from "./DiffPanel.js";
import { Composer } from "./Composer.js";
import { OverlayView, filterOptions } from "./Overlay.js";
import * as Ed from "../editor.js";
import { rewindAction } from "../rewind.js";
import { sentMessages, stepHistory, type HistoryWalk } from "../history.js";
import { LOCAL_COMMANDS, acceptCommand, commandMenu, commandRows, commandToken } from "../commands.js";
import { menuHeight, type MenuView } from "../composerMenu.js";
import { acceptMention, entryRows, filterEntries, mentionAt, mentionDir, mentionLeaf } from "../mentions.js";
import { readClipboard, readDroppedFiles, readSplitDrop, isDrop, isDirectoryDrop, applyDrop, cutTag, tagSpanAt, type DropResult, type FailedDrop } from "../attachments.js";
import { T } from "../theme.js";

/** The sidebar's width. Exported so `resize.test.ts` can hold the rail to it. */
export const SIDEBAR_W = 34;
/** Screen row (1-based) of the sidebar list's first line: below the title. */
const SIDEBAR_TOP = 2;
/**
 * How often a selection drag held past the edge of a pane scrolls one row.
 *
 * A terminal reports the mouse only while it moves. Hold the pointer still
 * below the bottom edge and no further event arrives, so the scroll has to
 * come from a timer rather than from the drag. 60 ms is about sixteen rows a
 * second: quick enough to cross a screen while the hand waits, slow enough to
 * stop where the reader means it to.
 */
export const DRAG_SCROLL_MS = 60;
/**
 * How long a pasted chunk waits for the rest of itself.
 *
 * A terminal may write one dropped path in two goes, and the halves come back
 * to back — a write apart, a paint apart, not a thought apart. A second is far
 * longer than that and still far shorter than the pause before a person pastes
 * a second, unrelated thing, so the seam covers the split without ever joining
 * two pastes a person meant to keep apart.
 */
export const PASTE_SEAM_MS = 1000;
/**
 * How long the sidebar cursor has to sit still before the thread under it is
 * opened. Long enough that holding ↓ through a list costs one subscription
 * rather than one per row, short enough that a deliberate move feels immediate.
 */
const PREVIEW_MS = 120;

/** shift+tab order. Bypass sits third so it is two presses from default. */
const PERMISSION_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

/** The machine-wide default mode, in plain words. "" clears it. */
/**
 * Where a daemon listens. Three of the four choices are words; the fourth,
 * one address, is typed at `covey daemon --bind <ip>` and shown as it is.
 */
const BIND_MODES: PickOption[] = [
  { id: "tailnet", label: "Tailnet only", hint: "the tailnet address, plus this machine" },
  { id: "all", label: "Tailnet and LAN", hint: "every address the machine has; the LAN needs the token" },
  { id: "loopback", label: "This machine only", hint: "nothing reaches it from outside" },
];
function bindLabel(bind: string): string {
  return BIND_MODES.find((o) => o.id === bind)?.label ?? bind;
}

const MACHINE_MODES: PickOption[] = [
  { id: "", label: "From Claude settings", hint: "permissions.defaultMode" },
  { id: "default", label: "Manual", hint: "approve every tool" },
  { id: "acceptEdits", label: "Auto", hint: "file edits go through, other tools ask" },
  { id: "bypassPermissions", label: "Bypass", hint: "never ask" },
];

/** The states the operator sets by hand in the run panel, in `t`'s order. */
const MEMBER_STATES: RunMemberState[] = ["working", "review", "blocked", "merged", "withdrawn", "dispatched", "planned"];

const MEMBER_STATE_HINT: Record<RunMemberState, string> = {
  planned: "placed, not started",
  dispatched: "the brief was sent",
  working: "its thread is at work",
  review: "there is a change to read",
  merged: "landed on main",
  blocked: "waiting on something else — not an error",
  withdrawn: "the task was cancelled; the work still counted",
};

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
  const [ovFilter, paintFilter] = useState("");
  /**
   * What the overlay's field holds *now*, which is not always what the last
   * paint showed (#128).
   *
   * Ink gives `useInput` a whole paste in one call, and App replays it
   * character by character, so every character queues a state update against
   * one render. A handler that ran inside that batch and read `ovFilter` read
   * the text the paste started from — usually the empty string — and a paste
   * that submitted dropped what the reader pasted without a word.
   *
   * So: write both, read this one to decide and the state to paint.
   */
  const ovFilterRef = useRef("");
  const setOvFilter = (next: string | ((f: string) => string)) => {
    ovFilterRef.current = typeof next === "function" ? next(ovFilterRef.current) : next;
    paintFilter(ovFilterRef.current);
  };
  const [ovToggle, setOvToggle] = useState(false);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  // Where the last pasted chunk left the draft, and when. A terminal can write
  // one drop in two goes, and `pasteText` joins the halves back up while the
  // seam is open — see `readSplitDrop`.
  const pasteSeam = useRef<{ at: number; value: string; caret: number } | null>(null);
  // Answering a question uses its own buffer and cursor so the composer draft
  // is preserved across the interruption.
  const [answerDraft, setAnswerDraft] = useState("");
  const [questionCursor, setQuestionCursor] = useState(0);
  // An AskUserQuestion call carries up to four questions, stepped through one
  // at a time. The answers collect here and go to the daemon in one command.
  const [answersGiven, setAnswersGiven] = useState<string[]>([]);
  // The prefix menu: which row is under the cursor, and whether esc has shut
  // it for the name being typed.
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimer = useRef<NodeJS.Timeout | null>(null);
  /** When esc last interrupted a turn, and when it last armed the rewind chord. */
  const interruptedAt = useRef(0);
  const armedAt = useRef(0);
  /**
   * The walk back through the messages this thread has sent. Null whenever the
   * draft is the person's own text — see `history.ts`.
   */
  const [walk, setWalk] = useState<HistoryWalk | null>(null);
  /** Transcript line the mouse went down on, so a click can fold what it hit. */
  const pressedLine = useRef<number | null>(null);
  /** The last press, so the next one can tell a double click from a click. */
  const clickRun = useRef<ClickRun | null>(null);
  /**
   * The repeating scroll of a selection drag held past a pane's edge, with the
   * direction it runs in: -1 towards the older lines, +1 towards the newest.
   * Clearing it on release is not tidying — a timer left running scrolls the
   * transcript for ever.
   */
  const dragScroll = useRef<{ dir: number; timer: ReturnType<typeof setInterval> } | null>(null);
  /** The latest step, so the timer never calls a stale render's closure. */
  const dragStep = useRef<(dir: number) => void>(() => {});

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
  // A prefix menu is a property of the draft, not a mode: it is open whenever
  // the draft is part way through a command name or a file mention, and esc
  // has not shut it. `/` wins, because a draft cannot be both.
  // Not while the diff panel is up: it takes the keys, so a draft left over
  // from before must not hold a menu open or take tab off the focus.
  const composerActive = state.focus === "composer" && !state.overlay && !state.diffView && !pending && !!state.view;
  const token = composerActive ? commandToken(draft) : null;
  const mention = composerActive && token === null ? mentionAt(draft, caret) : null;
  // The directory being completed. The daemon reads it once; the leaf filters
  // it here, so a word costs one request rather than one per keystroke.
  const mentionDirPath = mention ? mentionDir(mention.text) : null;
  const listing = mentionDirPath !== null ? state.view?.dirs.get(mentionDirPath) : undefined;
  const commandItems = useMemo(
    () => (token === null ? [] : commandMenu(state.view?.commands ?? null, LOCAL_COMMANDS, token)),
    [token, state.view?.commands],
  );
  const mentionItems = useMemo(
    () => (mention === null ? [] : filterEntries(listing?.entries ?? [], mentionLeaf(mention.text))),
    [mention?.text, listing],
  );
  const menuKind = menuClosed ? null : token !== null ? "command" : mention !== null ? "mention" : null;
  const menuItems: unknown[] = menuKind === "command" ? commandItems : menuKind === "mention" ? mentionItems : [];
  const menu: MenuView | null = menuKind === null ? null : {
    rows: menuKind === "command" ? commandRows(commandItems) : entryRows(mentionItems),
    index: Math.min(menuIndex, Math.max(0, menuItems.length - 1)),
    empty: menuKind === "command"
      ? (state.view?.commands == null ? "the commands arrive when this thread starts its first turn" : "no command matches")
      : listing?.loading ? "reading the directory…" : listing?.error ? listing.error : "no file matches",
  };
  const composerRows = (pending
    ? 3 + (pending.kind === "question" && answerDraft.length > 0 ? 1 : 0)
    : Math.min(maxEditorRows, Math.max(1, editorRows.length)) + 2)
    + (menu ? menuHeight(menu) : 0);
  const transcriptH = Math.max(3, size.rows - composerRows - 2 - 1);
  const questionUi = useMemo(() => ({ cursor: questionCursor, answered: answersGiven }), [questionCursor, answersGiven]);
  // A path in the transcript belongs to the daemon's host, and the file
  // manager belongs to this one. So paths are only openable when the thread's
  // machine is the loopback one; a URL is openable from any machine.
  const viewMachine = state.view?.machine ?? null;
  const viewHome = viewMachine ? (state.machines.get(viewMachine)?.info?.homeDir ?? undefined) : undefined;
  // A `#N` links to the project's repository on GitHub (#108), which is the
  // same from every machine.
  const viewProjectId = state.view?.thread?.projectId ?? null;
  const viewRepoUrl = viewMachine && viewProjectId ? repoUrlOf(state.machines.get(viewMachine)?.projects.get(viewProjectId)?.repositoryIdentity) : undefined;
  const linkCtx = useMemo<LinkContext>(() => ({ localFiles: !!viewMachine && isLoopbackUrl(viewMachine), homeDir: viewHome, repoUrl: viewRepoUrl }), [viewMachine, viewHome, viewRepoUrl]);
  // The lines of every item that did not change. A streamed reply replaces one
  // item and leaves the rest alone, so without this the client lays out the
  // whole transcript sixteen times a second to follow a single paragraph.
  // Lazily: `useRef`'s argument is evaluated on every render and all but the
  // first are thrown away, which in a file about per-render cost would be a Map
  // and a wrapper allocated thousands of times a session for no effect.
  const itemLines = useRef<ItemLines>(undefined);
  itemLines.current ??= new ItemLines();
  const baseLayout = useMemo(() => layoutTranscript(state.view, mainW - 2, state.expandedItems, questionUi, state.toolsExpanded, linkCtx, itemLines.current), [state.view, mainW, state.expandedItems, questionUi, state.toolsExpanded, linkCtx]);
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
  // The scroll the screen shows. The store's count is measured from the bottom
  // and the transcript grows there while a reply streams, so a paint resolves
  // the reader's anchor against the layout it draws (`scroll.ts`). The
  // handlers below measure from `liveScroll`, never from the store's count.
  const scrollFromBottom = useMemo(() => resolveScroll(layout, state.scrollFromBottom, state.scrollAnchor, transcriptH), [layout, state.scrollFromBottom, state.scrollAnchor, transcriptH]);
  /** The reader's place against the layout on screen, read from the live store. */
  const liveScroll = (live: AppState) => resolveScroll(layout, live.scrollFromBottom, live.scrollAnchor, transcriptH);
  /** Scroll to `n` lines from the bottom, and anchor on the line that lands under the top row. */
  const scrollTo = (n: number) => store.setScroll(n, anchorAt(layout, n, transcriptH));
  const machineName = state.view ? (state.machines.get(state.view.machine)?.info?.name ?? "") : "";

  useEffect(() => { lastCursor.current = cursor; }, [cursor]);
  // The key has to name a row that exists. When the row it named has gone,
  // `cursorIndex` has already fallen back to the nearest surviving one; write
  // that row's key back, or the cursor is an index again until the next move.
  //
  // An empty key names no row, so it is never written back: it falls to row
  // 0, which is the first project as soon as there is one. And a key from
  // above the machines section is not written onto that section: at start,
  // and whenever the projects go with their machine, the section is all
  // there is, and a cursor seated there would sit below the projects once
  // they came back. It goes back to empty instead, and falls to row 0.
  useEffect(() => {
    if (cursorKey === "" || rows.length === 0 || rows.some((r) => r.key === cursorKey)) return;
    const to = rows[cursor]!;
    const fleet = (k: string) => k === "machines" || k.startsWith("m:");
    if (fleet(to.key) && !fleet(cursorKey)) { setCursorKey(""); return; }
    setCursorKey(to.key);
  }, [rows, cursorKey, cursor]);
  // Reset the answer buffer when a different request comes up, so a stale
  // half-typed answer never carries into the next question.
  const pendingId = pending && (pending.kind === "approval" || pending.kind === "question") ? pending.requestId : null;
  useEffect(() => { setAnswerDraft(""); setQuestionCursor(0); setAnswersGiven([]); }, [pendingId]);
  // A relaunch is the CLI's job (it rebuilds and re-execs); all we do is
  // unmount cleanly so the terminal is handed back in one piece.
  useEffect(() => { if (state.relaunch) { store.shutdown(); exit(); } }, [state.relaunch, store, exit]);
  // per-thread drafts
  const threadKey = state.selected?.threadId ?? "";
  // A walk belongs to the thread it started in, thus a different thread ends it.
  useEffect(() => { setDraft(store.draft(threadKey)); setCaret(store.draft(threadKey).length); setWalk(null); }, [threadKey, store]);
  useEffect(() => { store.setDraft(threadKey, draft); }, [draft, threadKey, store]);
  // A different name is a different question, so the cursor goes back to the
  // top and a menu the reader shut comes back.
  const menuKey = token !== null ? `/${token}` : mention ? `@${mention.text}` : null;
  useEffect(() => { setMenuIndex(0); setMenuClosed(false); }, [menuKey]);
  // The daemon holds the files, so the directory behind an `@` has to be
  // fetched. `loadDir` reads each one once.
  useEffect(() => { if (mentionDirPath !== null) void store.loadDir(mentionDirPath); }, [mentionDirPath, threadKey, store]);

  const openPick = (title: string, options: PickOption[], onPick: (id: string, checked: boolean) => void, toggle?: string, onCancel?: () => void, many?: { marked: Set<string>; onMany: (ids: string[]) => void }) => { setOvCursor(0); setOvFilter(""); setOvToggle(false); store.setOverlay({ kind: "pick", title, options, onPick, toggle, onCancel, many }); };
  /** A pick of many: space marks, enter hands over the marked ids. */
  const openPickMany = (title: string, options: PickOption[], marked: string[], onMany: (ids: string[]) => void) => openPick(title, options, () => {}, undefined, undefined, { marked: new Set(marked), onMany });
  const openInput = (title: string, onSubmit: (v: string) => void, initial = "", placeholder?: string, onCancel?: () => void) => { setOvFilter(initial); store.setOverlay({ kind: "input", title, onSubmit, initial, placeholder, onCancel }); };
  /** The same prompt with the characters hidden: a secret's value (#126). */
  const openSecretInput = (title: string, onSubmit: (v: string) => void, placeholder?: string, onCancel?: () => void) => { setOvFilter(""); store.setOverlay({ kind: "input", title, onSubmit, mask: true, placeholder, onCancel }); };

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
  // The machine and project an action on the current row acts on. A project
  // row stands for a pool, and the row's own `machine` is the pool's first
  // member in sidebar order, which may be offline; the action goes to a
  // connected member instead. A run started here, the issues it reads, and
  // the machine panel all follow this. `||`, not `??`: the machines header
  // names no machine, and its empty string must fall through.
  const rowContext = (row?: SidebarRow): { machine?: string; projectId?: string } => {
    if (row?.kind === "project" && row.pool) {
      const live = row.pool.find((x) => state.machines.get(x.machine)?.conn === "connected") ?? row.pool[0]!;
      return { machine: live.machine, projectId: live.projectId };
    }
    return { machine: row?.machine || undefined, projectId: row?.projectId };
  };
  const rowCtx = rowContext(currentRow);
  const contextMachine = state.selected?.machine || rowCtx.machine || state.order[0];
  const contextProject = state.view?.thread?.projectId ?? rowCtx.projectId;

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
  const summaryRow = sidebarVisible && state.focus === "sidebar" && currentRow && (currentRow.kind === "project" || currentRow.kind === "machine" || currentRow.kind === "machines" || currentRow.kind === "empty") ? currentRow : null;

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

  /**
   * A row per saved machine for a pool pick: name, state, and where the clone
   * goes. Read from the store, not from this render's `state`: the pick
   * opens after a network wait, and a machine may have connected meanwhile.
   */
  const machineOptions = (except: string[] = []): PickOption[] => {
    const live = store.getState();
    return live.order.filter((k) => !except.includes(k)).map((k) => {
      const m = live.machines.get(k)!;
      const hint = m.conn === "connected" ? (m.info?.projectsDir ?? m.info?.os ?? "") : m.conn === "offline" ? "offline · clones when it answers" : m.conn;
      return { id: k, label: machineLabel(live, k), hint };
    });
  };

  /**
   * New project: the repository, then the machines that hold it. The pick
   * offers every machine, connected or not. An offline machine clones when it
   * next answers. The connected ones start marked, because a pool is usually
   * the whole fleet.
   */
  /** The last step of a new project: which machines clone `url`. */
  const chooseMachines = (url: string, baseBranch?: string) => {
    const live = store.getState();
    const connected = live.order.filter((k) => live.machines.get(k)?.conn === "connected");
    const from = baseBranch ? ` from ${baseBranch}` : "";
    openPickMany(`Clone ${url}${from} on which machines?`, machineOptions(), connected, (ids) => {
      store.setOverlay(null);
      if (ids.length === 0) { store.notify("no machine picked; nothing cloned", "error"); return; }
      void store.createProjectOn(ids, url, undefined, baseBranch);
    });
  };

  /**
   * The branch a new project works from: the remote's default branch, or one
   * of its others. Every thread then branches from it, and every pull request
   * targets it, so a feature branch can be built over many threads. The pick
   * stays open while `git ls-remote` runs on `asker`; a remote that cannot be
   * read goes straight to the machines with the default branch as the base.
   */
  const chooseBranch = (url: string, asker: string | null) => {
    openPick(`Base branch of ${url}`, [{ id: "wait", label: "reading its branches…", hint: "" }], (id) => { if (id === "wait") chooseMachines(url); });
    const opened = store.getState().overlay;
    void store.listBranches(url, asker).then((r) => {
      if (store.getState().overlay !== opened) return;
      if (r.error) { store.notify(r.error, "error"); chooseMachines(url); return; }
      openPick(`Base branch of ${url}`, branchOptions(r), (id) => chooseMachines(url, id === DEFAULT_BASE ? undefined : id));
    });
  };

  /** A repository by URL, for one `gh` cannot list: another host, or no `gh`. */
  const askUrl = () => openInput("Repository to clone", (v) => {
    const url = v.trim();
    if (!url) { store.setOverlay(null); return; }
    chooseBranch(url, null);
  }, "", "git@github.com:org/repo.git or https://…");

  /**
   * A new repository on GitHub: its name, then private or public. `gh` on
   * `asker` makes it, and the clone goes to the machines picked next.
   */
  const newRepo = (asker: string) => openInput("New repository: name, or owner/name", (name) => {
    const n = name.trim();
    if (!n) { store.setOverlay(null); return; }
    openPick(`Make ${n}`, [
      { id: "private", label: "Private", hint: "only you and those you invite" },
      { id: "public", label: "Public", hint: "anyone can read it" },
    ], (vis) => {
      store.setOverlay(null);
      store.notify(`covey makes ${n} on GitHub through ${machineLabel(state, asker)}…`);
      void store.createRepo(asker, { name: n, visibility: vis === "public" ? "public" : "private" }).then((made) => {
        if (!made) return;
        store.notify(`made ${made.nameWithOwner}`, "success");
        chooseMachines(made.cloneUrl);
      });
    });
  }, "", "my-repo, or acme/my-repo");

  /**
   * New project. The pick opens at once with its two fixed rows, and the
   * repositories the user can reach join it when the first machine with a
   * logged-in `gh` answers, newest push first. The reader filters the list by
   * what they type. The two fixed rows make a new repository, or take a URL
   * for one `gh` cannot list. Without a `gh` to ask, the URL is the whole of it.
   *
   * The pick is open for the whole wait, so no key falls through to the
   * sidebar, and an answer that arrives after the reader left the pick is
   * dropped rather than painted over whatever they opened next.
   */
  const addProject = () => {
    if (state.order.length === 0) { store.notify("add a machine first", "error"); return; }
    if (store.ghMachines().length === 0) { askUrl(); return; }
    const fixed: PickOption[] = [
      { id: "new", label: "New repository…", hint: "gh repo create" },
      { id: "url", label: "A URL…", hint: "any host" },
    ];
    // A clone URL always has a `:` or a `/`, so it can never read as a fixed row's id.
    const onPick = (id: string, asker: string | null) => {
      if (id === "new") return asker ? newRepo(asker) : askUrl();
      if (id === "url") return askUrl();
      chooseBranch(id, asker);
    };
    openPick("Repository", [...fixed, { id: "wait", label: "reading your repositories…", hint: "" }], (id) => onPick(id === "wait" ? "url" : id, null));
    const opened = store.getState().overlay;
    void store.listRepos().then(({ repos, error, machine }) => {
      if (store.getState().overlay !== opened) return;
      if (error) store.notify(error, "error");
      const rows = [...fixed, ...repoOptions(repos)];
      store.setOverlay({ kind: "pick", title: "Repository", options: rows, onPick: (id) => onPick(id, machine) });
    });
  };

  /**
   * Add a machine to a project's pool: clone the repository there. The
   * project under the cursor when the cursor is on one, since that is the
   * project the summary beside it names; else the open thread's.
   */
  const addToPool = () => {
    const at = currentRow?.kind === "project" ? rowCtx : { machine: contextMachine, projectId: contextProject };
    const g = at.machine && at.projectId ? groupOfProject(state, at.machine, at.projectId) : null;
    const url = g?.members.map((x) => x.project.remoteUrl).find(Boolean);
    if (!g || !url) { store.notify("select a project that covey cloned from a URL", "error"); return; }
    // The new clone works from the branch the pool does, so the pool agrees.
    const baseBranch = g.members.map((x) => x.project.baseBranch).find(Boolean);
    // Machines that hold a clone of it on this base, and machines that will
    // once they answer. A machine with only a checkout from before is
    // offered: the clone goes in beside it. So is a machine that holds the
    // repository on another base — that is another project.
    const inPool = [...g.members.filter((x) => x.project.kind === "clone").map((x) => x.machine), ...store.pendingFor(url, baseBranch)];
    const options = machineOptions(inPool);
    if (options.length === 0) { store.notify("every machine already has this project"); return; }
    openPickMany(`Add ${g.title} to which machines?`, options, [], (ids) => {
      store.setOverlay(null);
      if (ids.length) void store.createProjectOn(ids, url, g.title, baseBranch);
    });
  };

  /**
   * Change the branch a project works from. The branches come from the
   * remote, read on the first machine of the pool that is connected, and
   * the pick marks the base the project has now.
   */
  const changeBase = (row: SidebarRow) => {
    const pool = row.pool ?? [];
    const url = pool.map((x) => x.project.remoteUrl).find(Boolean);
    if (!url) { store.notify("select a project that covey cloned from a URL", "error"); return; }
    const current = pool.map((x) => x.project.baseBranch).find(Boolean) ?? null;
    const live = store.getState();
    const asker = pool.map((x) => x.machine).find((k) => live.machines.get(k)?.conn === "connected") ?? null;
    openPick(`Base branch of ${row.project!.title}`, [{ id: "wait", label: "reading its branches…", hint: "" }], () => {});
    const opened = store.getState().overlay;
    void store.listBranches(url, asker).then((r) => {
      if (store.getState().overlay !== opened) return;
      if (r.error) { store.notify(r.error, "error"); store.setOverlay(null); return; }
      openPick(`Base branch of ${row.project!.title}`, branchOptions(r, current), (id) => {
        store.setOverlay(null);
        const next = id === DEFAULT_BASE ? null : id;
        if (next !== current) void store.setProjectBase(pool, next);
      });
    });
  };

  const project = (machine?: string, projectId?: string) =>
    machine && projectId ? state.machines.get(machine)?.projects.get(projectId) : undefined;

  /**
   * New thread: its own worktree, branched from the remote's default branch,
   * on a machine of the project's pool. One connected machine needs no
   * question; more than one asks, with the machine that has the most room
   * first, which is the rule a run places by.
   */
  const newThread = async (machine = contextMachine, projectId = contextProject) => {
    if (!machine || !projectId) { store.notify("select a project first", "error"); return; }
    const p = project(machine, projectId);
    const pool = p ? projectPool(p) : null;
    // A project with no remote is on one machine only; a pooled one is ranked
    // the way a run's tasks are placed, fastest with room first. A project of
    // the same repository on another base branch is another pool: a thread
    // must start from the base its own project names.
    if (!pool) {
      if (state.machines.get(machine)?.conn !== "connected") { store.notify("that machine is not connected", "error"); return; }
      await store.createThread(machine, projectId);
      return;
    }
    const ready = store.rankedPool(pool).filter((m) => m.projectId !== null);
    if (ready.length === 0) { store.notify("no connected machine has this project", "error"); return; }
    if (ready.length === 1) { await store.createThread(ready[0]!.key, ready[0]!.projectId!); return; }
    const load = store.machineLoad();
    openPick("New thread on which machine?", ready.map((m) => {
      const free = Math.max(0, m.concurrency - (load.get(m.machineId) ?? 0));
      return { id: m.key, label: machineLabel(state, m.key), hint: `${free} free · ${m.os}` };
    }), (mk) => {
      store.setOverlay(null);
      const m = ready.find((y) => y.key === mk)!;
      void store.createThread(m.key, m.projectId!);
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
      // The destination pool first: the same repository on the same base, so
      // the thread keeps the branch it started from. A project of the same
      // repository on another base comes next, with that base named, because
      // a move there changes what the thread's pull request targets.
      const srcPool = srcProject ? projectPool(srcProject) : null;
      const same = srcPool ? projects.filter((p) => projectPool(p) === srcPool) : [];
      const kin = srcProject?.repositoryIdentity ? projects.filter((p) => !same.includes(p) && p.repositoryIdentity === srcProject.repositoryIdentity) : [];
      const opts: PickOption[] = [
        ...same.map((p) => ({ id: `p:${p.id}`, label: p.title, hint: "same repo ✓" })),
        ...kin.map((p) => ({ id: `p:${p.id}`, label: p.title, hint: `same repo · from ${p.baseBranch ?? "the default branch"}` })),
        ...projects.filter((p) => !same.includes(p) && !kin.includes(p)).map((p) => ({ id: `p:${p.id}`, label: p.title, hint: p.workspaceRoot })),
        ...(same.length === 0 && srcProject?.repositoryIdentity ? [{ id: "clone", label: `Clone ${srcProject.repositoryIdentity} there`, hint: m.info?.projectsDir ?? "" }] : []),
      ];
      openPick(`Destination project on ${m.info!.name}`, opts, (pid) => {
        store.setOverlay(null);
        if (pid === "clone") void store.moveThread(sel, { machine: mk });
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
    // The panel needs what only a connected daemon sends. On a machine the
    // client has given up on there is exactly one thing worth doing, so enter
    // does it rather than reporting the state back at the reader (issue #68).
    if (m.conn !== "connected" || !m.info) { store.retryMachine(machineKey!); return; }
    const info = m.info;
    const settings = info.settings ?? { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null };
    const busy = runningTurns(machineKey!);
    // What this machine's Claude Code offers, not what covey was built
    // knowing: a machine on a newer Claude Code offers newer models. The
    // built-in list stands in for a daemon too old to send one.
    const models = info.models ?? KNOWN_MODELS;
    const defaultLabel = settings.defaultModel
      ? modelLabel(settings.defaultModel, models)
      : "from Claude settings";
    // "behind" is the reason most updates get run, so say it where the finger
    // already is instead of only in the summary behind it.
    const skew = buildSkew(state.clientBuild, info.build);
    const opts: PickOption[] = [
      { id: "update", label: "Update — pull, rebuild, restart", hint: skew === "behind" ? "older build than your client" : busy ? "interrupts running turns" : "" },
      { id: "restart", label: "Restart the daemon", hint: busy ? `${busy} running` : "" },
      { id: "model", label: `Default model: ${defaultLabel}`, hint: "new threads here" },
      { id: "mode", label: `Default mode: ${permissionModeLabel(settings.defaultPermissionMode)}`, hint: "new threads here" },
      { id: "streaming", label: `Default streaming: ${settings.defaultStreaming ? "on" : "off"}`, hint: "new threads here" },
      { id: "web", label: `Web server: ${settings.webEnabled ? "on" : "off"}`, hint: settings.webEnabled ? (info.webAddresses?.find((a) => a.reachable)?.url ?? "serving the phone client") : "serve the phone client from this machine" },
      ...(settings.bind ? [{ id: "bind", label: `Reachable on: ${bindLabel(settings.bind)}`, hint: "where the daemon listens; changes at once" }] : []),
    ];
    if (m.update) opts.push({ id: "log", label: "Show the last update's log", hint: m.update.state });
    openPick(`${info.name} — ${info.os}/${info.arch} · build ${buildLine(info.build)}${info.claudeCodeVersion ? ` · claude ${info.claudeCodeVersion}` : ""}`, opts, (id) => {
      switch (id) {
        case "update": return void confirmUpdate(machineKey!);
        case "restart": return confirmRestart(machineKey!);
        case "model": return openPick(`Default model on ${info.name}`, [
          // The "no model set" row says what Claude Code's own default
          // resolves to there, so the reader can tell which Opus they get.
          { id: "", label: "From Claude settings", hint: settings.defaultModel ? modelVersion(info.claudeDefaultModel) : "current" },
          ...models.map((k) => ({ id: k.id, label: k.label, hint: modelIsCurrent(k, settings.defaultModel) ? "current" : (modelVersion(k) || k.id) })),
        ], (mid) => {
          store.setOverlay(null);
          void store.setMachineDefaults(machineKey!, { defaultModel: mid || null });
          store.notify(`${info.name}: new threads use ${mid ? modelLabel(mid, models) : "the model from Claude settings"}`);
        });
        case "mode": return openPick(`Default mode on ${info.name}`, MACHINE_MODES.map((o) => ({
          ...o, hint: (o.id === "" ? settings.defaultPermissionMode === null : o.id === settings.defaultPermissionMode) ? "current" : o.hint,
        })), (mid) => {
          store.setOverlay(null);
          const mode = (mid || null) as PermissionMode | null;
          void store.setMachineDefaults(machineKey!, { defaultPermissionMode: mode });
          store.notify(`${info.name}: new threads start in ${permissionModeLabel(mode)}`, mode === "bypassPermissions" ? "error" : "info");
        });
        case "streaming": {
          store.setOverlay(null);
          const on = !settings.defaultStreaming;
          void store.setMachineDefaults(machineKey!, { defaultStreaming: on });
          store.notify(`${info.name}: new threads ${on ? "show text as it arrives" : "show each reply whole"}`);
          return;
        }
        case "web": {
          store.setOverlay(null);
          void store.setWebServer(machineKey!, !settings.webEnabled);
          return;
        }
        case "bind": return openPick(`Where ${info.name} listens`, BIND_MODES.map((o) => ({ ...o, hint: o.id === settings.bind ? "current" : o.hint })), (bid) => {
          store.setOverlay(null);
          if (bid === settings.bind) return;
          void store.setMachineDefaults(machineKey!, { bind: bid }).then(
            () => store.notify(`${info.name} now listens on ${bindLabel(bid)}`, "success"),
            (e: Error) => store.notify(`${info.name}: ${e.message}`, "error"),
          );
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

  // ---- runs -----------------------------------------------------------------

  /** The run the panel is showing. Read fresh: a member changes under it. */
  const overlayRun = state.overlay?.kind === "run" ? store.run(state.overlay.machine, state.overlay.runId) : null;

  /**
   * Start a run: one request from the operator becomes many threads, one task
   * each, across the machines that can do the work.
   *
   * Nothing is dispatched here. The run is placed and shown, and the operator
   * reads the placement and may move a member before any agent starts.
   */
  const startRun = () => {
    const machine = contextMachine;
    const projectId = contextProject;
    const p = project(machine, projectId);
    if (!machine || !projectId || !p) { store.notify("select a project first — a run works in one repository", "error"); return; }
    openInput(`Tasks for a run in ${p.title}`, (v) => {
      const tasks = parseTaskList(v);
      if (tasks.length === 0) { store.notify("no tasks — give issue numbers, or one task each separated by ;", "error"); return; }
      openInput("What is this run for?", (goal) => {
        store.setOverlay(null);
        void beginRun(machine, projectId, goal.trim() || `${tasks.length} tasks in ${p.title}`, tasks);
      }, "", `the goal all ${tasks.length} members share`);
    }, "", "44 45 46 — or: Fix the wheel os=darwin; Write the docs");
  };

  /** Read the issue titles, then place the tasks and write the record. */
  const beginRun = async (machine: string, projectId: string, goal: string, tasks: RunTask[]) => {
    const p = project(machine, projectId);
    const numbers = tasks.map((t) => t.issue).filter((n): n is number => n !== null);
    let full = tasks;
    if (numbers.length > 0) {
      store.notify(`reading ${numbers.length} issue${numbers.length === 1 ? "" : "s"}…`);
      const { issues, error } = await store.runIssues(machine, projectId, numbers);
      full = withIssueTitles(tasks, issues);
      if (error) store.notify(error, "error");
    }
    setOvCursor(0);
    await store.createRun({ machine, name: truncate(goal, 48), goal, tasks: full, pool: p ? projectPool(p) : null });
  };

  /** Come back to the run panel after a pick, with the cursor where it was. */
  const backToRun = (ov: Extract<Overlay, { kind: "run" }>, at: number) => { store.setOverlay(ov); setOvFilter(""); setOvCursor(at); };
  const backToSecrets = (ov: Extract<Overlay, { kind: "secrets" }>, at: number) => { store.setOverlay(ov); setOvFilter(""); setOvCursor(at); };

  /**
   * The environment a project's threads work in, or one thread's own — `e` on
   * a sidebar row (#126).
   *
   * A project's panel writes to every machine of its pool, so the same
   * repository works the same wherever a thread of it runs.
   */
  function openSecrets(row: SidebarRow) {
    setOvCursor(0);
    if (row.kind === "project" && row.project) {
      const pool = row.pool?.length ? row.pool : [{ machine: row.machine, projectId: row.project.id }];
      return store.setOverlay({
        kind: "secrets", scope: "project", title: `Secrets — ${row.project.title}`,
        targets: pool.map((x) => ({ machine: x.machine, ownerId: x.projectId })),
      });
    }
    if (row.kind === "thread" && row.thread) {
      store.setOverlay({
        kind: "secrets", scope: "thread", title: `Secrets — ${row.thread.title}`,
        targets: [{ machine: row.machine, ownerId: row.thread.id }],
      });
    }
  }

  /**
   * The secrets panel's keys. The list is the names the renderer paints, in
   * the same order, so the row under the cursor is the row a key acts on —
   * the rule the run panel and the sidebar both follow.
   *
   * A value is never read back, because covey keeps no way to read one: enter
   * writes a new value over the old, it does not edit it.
   */
  function handleSecretsKey(ov: Extract<Overlay, { kind: "secrets" }>, input: string, key: any) {
    const keys = secretPanelKeys(state, ov);
    const at = Math.min(ovCursor, Math.max(0, keys.length - 1));
    const name = keys[at];
    const write = (k: string, value: string | null, cursor: number) => {
      backToSecrets(ov, cursor);
      void store.setSecrets(ov.scope, ov.targets, [{ key: k, value }]);
    };
    const askValue = (k: string, title: string) => openSecretInput(
      title,
      (v) => {
        if (!v) { backToSecrets(ov, at); return store.notify(`${k} is unchanged: a secret needs a value`, "error"); }
        write(k, v, Math.max(0, keys.includes(k) ? keys.indexOf(k) : keys.filter((x) => x < k).length));
      },
      "paste it whole — the characters stay hidden, newlines and all",
      () => backToSecrets(ov, at),
    );
    if (key.upArrow || input === "k") return setOvCursor(() => Math.max(0, at - 1));
    if (key.downArrow || input === "j") return setOvCursor(() => Math.min(keys.length - 1, at + 1));
    if (input === "a") {
      return openInput("New secret: the name", (k) => {
        const bad = secretKeyError(k.trim());
        if (bad) { backToSecrets(ov, at); return store.notify(bad, "error"); }
        askValue(k.trim(), `Value for ${k.trim()}`);
      }, "", "STRIPE_KEY", () => backToSecrets(ov, at));
    }
    if (!name) return;
    if (key.return) return askValue(name, `New value for ${name}`);
    if (input === "D") {
      return openPick(`Remove ${name}?`, [
        { id: "no", label: "Cancel" },
        { id: "yes", label: ov.scope === "project" ? `Remove ${name} from this project on ${ov.targets.length} machine${ov.targets.length === 1 ? "" : "s"}` : `Remove ${name} from this thread` },
      ], (id) => {
        if (id === "yes") write(name, null, Math.max(0, at - 1));
        else backToSecrets(ov, at);
      }, undefined, () => backToSecrets(ov, at));
    }
  }

  /**
   * The run panel's keys. The list is the run's members in order, so the row
   * under the cursor and the row a key acts on are the same array — the same
   * rule the sidebar and the browser follow.
   */
  function handleRunKey(ov: Extract<Overlay, { kind: "run" }>, input: string, key: any) {
    const run = store.run(ov.machine, ov.runId);
    if (!run) { store.setOverlay(null); return; }
    const at = Math.max(0, Math.min(run.members.length - 1, ovCursor));
    const m = run.members[at];
    if (key.upArrow || input === "k") return setOvCursor(() => Math.max(0, at - 1));
    if (key.downArrow || input === "j") return setOvCursor(() => Math.min(run.members.length - 1, at + 1));
    if (input === " ") {
      if (!m) return;
      const marked = new Set(ov.marked);
      if (marked.has(m.id)) marked.delete(m.id); else marked.add(m.id);
      return store.setOverlay({ ...ov, marked });
    }
    if (key.return) {
      if (!m?.threadId) { store.notify("that member has no thread yet — press d to dispatch the run", "error"); return; }
      const mk = store.machineKeyOf(m.machineId);
      if (!mk) { store.notify(`${store.machineNameOf(m.machineId)} is not connected`, "error"); return; }
      store.setOverlay(null);
      void store.select({ machine: mk, threadId: m.threadId });
      store.setFocus("composer");
      return;
    }
    if (input === "d") return dispatchRun(ov, run);
    if (input === "s") return sendToRun(ov, run, at);
    if (input === "p") return void store.refreshPullRequests(ov.machine, ov.runId);
    if (input === "m" && m) return moveMember(ov, run, m, at);
    if (input === "t" && m) return setMemberState(ov, run, m, at);
    if (input === "a") return addTaskToRun(ov, run, at);
    if (input === "D" && m && !m.threadId) {
      // A member that never started can simply go. One that did is withdrawn,
      // because its thread did work that the record should keep.
      return openPick(`Drop ${m.task.key} from the run?`, [
        { id: "no", label: "Cancel" },
        { id: "yes", label: "Drop it — it was never dispatched" },
      ], (id) => { backToRun(ov, at); if (id === "yes") void store.threadCommand({ type: "run.member.remove", runId: run.id, memberId: m.id }, ov.machine); }, undefined, () => backToRun(ov, at));
    }
    if (input === "r") return openInput("Rename run", (v) => { backToRun(ov, at); if (v.trim()) void store.threadCommand({ type: "run.update", runId: run.id, name: v.trim() }, ov.machine); }, run.name, undefined, () => backToRun(ov, at));
  }

  /**
   * Dispatch, behind a confirmation. This starts real Claude sessions and real
   * git worktrees on other people's machines, so it says how many and where
   * before it does.
   */
  const dispatchRun = (ov: Extract<Overlay, { kind: "run" }>, run: Run) => {
    const todo = run.members.filter((m) => m.state === "planned" && !m.threadId);
    if (todo.length === 0) { store.notify("every member is already dispatched", "error"); return; }
    const byMachine = new Map<string, number>();
    for (const m of todo) { const n = store.machineNameOf(m.machineId); byMachine.set(n, (byMachine.get(n) ?? 0) + 1); }
    const where = [...byMachine].map(([n, c]) => `${c} on ${n}`).join(" · ");
    openPick(`Dispatch ${todo.length} member${todo.length === 1 ? "" : "s"}?`, [
      { id: "no", label: "Cancel", hint: "m moves a member first" },
      { id: "yes", label: `Start ${todo.length} thread${todo.length === 1 ? "" : "s"}, one worktree each`, hint: where },
    ], (id) => {
      backToRun(ov, 0);
      if (id === "yes") void store.dispatchRun(ov.machine, ov.runId);
    }, undefined, () => backToRun(ov, 0));
  };

  /**
   * Send the same message to every member, to the marked ones, or to one.
   *
   * The operator of 2026-09-16 sent the same correction to fifteen threads four
   * separate times, each one a hand-written loop over thread ids.
   */
  const sendToRun = (ov: Extract<Overlay, { kind: "run" }>, run: Run, at: number) => {
    const live = run.members.filter((m) => m.threadId && m.state !== "withdrawn");
    const marked = run.members.filter((m) => ov.marked.has(m.id) && m.threadId);
    const one = run.members[at];
    const opts: PickOption[] = [];
    if (live.length > 0) opts.push({ id: "all", label: `Every member (${live.length})`, hint: "the whole run" });
    if (marked.length > 0) opts.push({ id: "marked", label: `The ${marked.length} marked`, hint: marked.map((m) => m.task.key).join(" ") });
    if (one?.threadId) opts.push({ id: "one", label: `Only ${one.task.key}`, hint: truncate(one.task.title, 40) });
    if (opts.length === 0) { store.notify("no member has a thread yet", "error"); return; }
    openPick("Send a message to…", opts, (id) => {
      const to = id === "all" ? live : id === "marked" ? marked : one ? [one] : [];
      openInput(`Message to ${to.length} member${to.length === 1 ? "" : "s"}`, (text) => {
        backToRun(ov, at);
        if (text.trim()) void store.sendToRun(ov.machine, ov.runId, to.map((m) => m.id), text);
      }, "", "they all get this, verbatim", () => backToRun(ov, at));
    }, undefined, () => backToRun(ov, at));
  };

  /** Move a member to another machine, before it has a thread. */
  const moveMember = (ov: Extract<Overlay, { kind: "run" }>, run: Run, m: RunMember, at: number) => {
    if (m.threadId) { store.notify("this member already has a thread — withdraw it instead of moving it", "error"); return; }
    const machines = store.placementMachines(runRepository(run));
    if (machines.length < 2) { store.notify("no other machine has a checkout of this project", "error"); return; }
    openPick(`Move ${m.task.key} to…`, machines.map((x) => ({
      id: x.machineId,
      label: x.name,
      // The requirement it fails is why the rule did not put the task here, so
      // it is what the operator needs to see before overriding the rule.
      hint: [x.machineId === m.machineId ? "here now" : "", `${x.cpuCount} cores`, firstUnmet(x, m.task) ? `misses ${firstUnmet(x, m.task)!.value}` : ""].filter(Boolean).join(" · "),
    })), (id) => {
      backToRun(ov, at);
      void store.moveMember(ov.machine, run.id, m.id, id);
    }, undefined, () => backToRun(ov, at));
  };

  /** The states an operator sets by hand. `blocked` is not an error. */
  const setMemberState = (ov: Extract<Overlay, { kind: "run" }>, run: Run, m: RunMember, at: number) => {
    const opts: PickOption[] = MEMBER_STATES.map((s) => ({ id: s, label: runMemberStateLabel(s), hint: s === m.state ? "current" : MEMBER_STATE_HINT[s] }));
    openPick(`${m.task.key} — state`, opts, (id) => {
      const next = id as RunMemberState;
      // A blocked member is blocked *on* something, and a withdrawn one was
      // withdrawn *for* a reason. Both are worth a sentence; neither is an error.
      if (next === "blocked" || next === "withdrawn") {
        openInput(next === "blocked" ? `${m.task.key} — blocked on what?` : `${m.task.key} — withdrawn why?`, (note) => {
          backToRun(ov, at);
          void store.patchMember(ov.machine, run.id, m.id, { state: next, note: note.trim() || null });
        }, m.note ?? "", "one sentence", () => backToRun(ov, at));
        return;
      }
      backToRun(ov, at);
      void store.patchMember(ov.machine, run.id, m.id, { state: next });
    }, undefined, () => backToRun(ov, at));
  };

  /** Add a task to a run in flight, without tearing the run down. */
  const addTaskToRun = (ov: Extract<Overlay, { kind: "run" }>, run: Run, at: number) => {
    openInput("Add a task", (v) => {
      const tasks = parseTaskList(v);
      if (tasks.length === 0) { backToRun(ov, at); return; }
      backToRun(ov, at);
      void store.addTasks(ov.machine, run.id, tasks);
    }, "", "an issue number, or a line of text", () => backToRun(ov, at));
  };

  /** The pool a run works in, from the project its first member is in. */
  const runRepository = (run: Run): string | null => {
    for (const m of run.members) {
      const mk = store.machineKeyOf(m.machineId);
      const p = mk && m.projectId ? state.machines.get(mk)?.projects.get(m.projectId) : null;
      if (p) return projectPool(p);
    }
    return null;
  };

  const palette = () => {
    const t = state.view?.thread;
    // The models of the machine the open thread runs on. A thread on a Pi and
    // a thread on a laptop may be offered different lists, because the two
    // machines may run different Claude Codes.
    const tm = state.view ? state.machines.get(state.view.machine) : null;
    const threadModels = tm?.info?.models ?? KNOWN_MODELS;
    // What a thread with no model of its own ends up running: the project's
    // default, else the machine's, else whatever Claude Code itself picks.
    const inherited = (t && tm?.projects.get(t.projectId)?.defaultModel) || tm?.info?.settings?.defaultModel || null;
    const inheritedHint = inherited ? modelLabel(inherited, threadModels) : modelVersion(tm?.info?.claudeDefaultModel);
    const opts: PickOption[] = [];
    if (t) {
      opts.push({ id: "move", label: "Move thread to another machine", hint: "m" });
      opts.push({ id: "rename", label: "Rename thread", hint: "r" });
      opts.push({ id: "model", label: `Model: ${t.model ? modelLabel(t.model, threadModels) : "default"}`, hint: t.model ? "" : inheritedHint });
      opts.push({ id: "mode", label: `Permission mode: ${t.permissionMode}` });
      opts.push({ id: "streaming", label: t.streaming ? "Streaming: on — text arrives token by token" : "Streaming: off — each reply lands whole", hint: "this thread" });
      opts.push({ id: "diff", label: "Show changes from the last turn", hint: "d" });
      if (t.latestTurn?.state === "running") opts.push({ id: "background", label: "Background the running tool calls", hint: "ctrl+b" });
      opts.push({ id: "revert", label: "Revert to before a turn… (files + conversation)" });
      if (t.queuedTurns > 0) opts.push({ id: "clearqueue", label: `Cancel ${t.queuedTurns} queued message${t.queuedTurns === 1 ? "" : "s"}` });
      opts.push({ id: "archive", label: t.archivedAt ? "Unarchive thread" : "Archive thread", hint: "x" });
      // Who merges the thread's pull request. Offered only while a watch runs:
      // there is nothing to merge before one, and nothing left after.
      if (t.watch?.state === "watching") opts.push({ id: "merge", label: t.watch.merge === "auto" ? `Merge policy: auto — covey merges #${t.watch.number} when it is green` : `Merge policy: manual — a person merges #${t.watch.number}`, hint: "M" });
      // The issue and the pull request open in the browser (#108): the web
      // client has the view in the page; the terminal has the link.
      if (t.issue) opts.push({ id: "openissue", label: `Open issue #${t.issue.number} on GitHub${t.issue.title ? ` — ${truncate(t.issue.title, 50)}` : ""}`, hint: "browser" });
      if (t.pullRequest) opts.push({ id: "openpr", label: `Open pull request #${t.pullRequest.number} on GitHub — into ${t.pullRequest.base}`, hint: "browser" });
      opts.push({ id: "stop", label: "Stop session process" });
    }
    opts.push({ id: "new", label: "New thread — in its own worktree", hint: "n" });
    opts.push({ id: "addproject", label: "Add project — pick a repository, make one, or give a URL; then the machines", hint: "a" });
    if (contextProject) opts.push({ id: "pooladd", label: "Add a machine to this project — clone it there too" });
    opts.push({ id: "run", label: "Start a run — one task each, across machines", hint: contextProject ? "this project" : "select a project first" });
    opts.push({ id: "usage", label: "Usage — tokens and estimated cost, per period", hint: "every machine" });
    opts.push({ id: "machine", label: "Machine control panel — update, restart, defaults", hint: "enter on a machine" });
    // Only offered when there is something to retry, so the list does not grow
    // a row that does nothing on a fleet that is all up.
    const offline = state.order.filter((k) => state.machines.get(k)?.conn === "offline");
    if (offline.length) opts.push({ id: "retry", label: `Retry ${offline.length === 1 ? state.machines.get(offline[0]!)!.saved.name : `${offline.length} offline machines`}`, hint: "the client stopped dialling" });
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
        case "model": return openPick("Model", [
          { id: "", label: "Default", hint: inheritedHint },
          ...threadModels.map((m) => ({ id: m.id, label: m.label, hint: modelIsCurrent(m, t!.model) ? "current" : (modelVersion(m) || m.id) })),
        ], (mid) => { store.setOverlay(null); void store.threadCommand({ type: "thread.setModel", threadId: t!.id, model: mid || null }); });
        case "mode": return openPick("Permission mode", PERMISSION_CYCLE.map((m) => ({ id: m, label: m, hint: m === "bypassPermissions" ? "runs tools without asking" : m === t!.permissionMode ? "current" : "" })), (m) => { store.setOverlay(null); void store.setPermissionMode(t!.id, m as PermissionMode); });
        case "streaming": return void store.setStreaming(t!.id, !t!.streaming);
        case "diff": return void store.toggleDiff();
        case "background": return void store.background();
        case "revert": return openRewind();
        case "clearqueue": { for (const it of [...(state.view?.items.values() ?? [])]) if (it.kind === "user" && it.queued) void store.cancelQueued(it.turnId!); return; }
        case "quiet": return;
        case "archive": return void store.threadCommand({ type: "thread.archive", threadId: t!.id, archived: !t!.archivedAt });
        case "merge": return void store.threadCommand({ type: "thread.setMerge", threadId: t!.id, merge: t!.watch?.merge === "auto" ? "manual" : "auto" });
        case "openissue": {
          // The daemon records the URL when `gh` could read the issue; else it is the repository's issues route.
          const url = t!.issue!.url ?? `${repoUrlOf(state.machines.get(state.view!.machine)?.projects.get(t!.projectId)?.repositoryIdentity) ?? ""}/issues/${t!.issue!.number}`;
          return url.startsWith("http") ? openLink(url) : store.notify("no URL for that issue", "error");
        }
        case "openpr": return openLink(t!.pullRequest!.url);
        case "stop": return void store.threadCommand({ type: "session.stop", threadId: t!.id });
        case "new": return void newThread();
        case "addproject": return addProject();
        case "pooladd": return addToPool();
        case "run": return startRun();
        case "usage": return void store.loadUsage(0, "thread");
        case "machine": return machinePanel();
        case "retry": { for (const k of offline) store.retryMachine(k); return; }
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
      case "project": return store.toggleExpanded(row.groupKey!);
      case "machines": return store.toggleExpanded(MACHINES_KEY, false);
      case "run": {
        setOvCursor(0);
        return store.setOverlay({ kind: "run", machine: row.machine, runId: row.run!.id, marked: new Set(), busy: null });
      }
      case "member": {
        // A member with a thread opens it, wherever that thread lives; one
        // without opens the run, which is where dispatch is.
        const m = row.member!;
        const mk = m.threadId ? store.machineKeyOf(m.machineId) : null;
        if (mk && m.threadId) { void store.select({ machine: mk, threadId: m.threadId }); store.setFocus("composer"); return; }
        setOvCursor(row.run!.members.indexOf(m));
        return store.setOverlay({ kind: "run", machine: row.machine, runId: row.run!.id, marked: new Set(), busy: null });
      }
      case "archived": return store.toggleExpanded(archiveKey(row.groupKey!), false);
      case "machine": return machinePanel(row.machine);
      case "empty": return addProject();
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
    const end = Math.max(0, layout.lines.length - scrollFromBottom);
    const start = Math.max(0, end - transcriptH);
    const pad = Math.max(0, transcriptH - (end - start));
    const line = clamp(start + (rowInBox - pad), start, Math.max(start, end - 1));
    // A short transcript is painted flush to the bottom; rows above it are
    // empty padding, and clamping them onto the first line is fine for a drag
    // but must not count as having clicked that line.
    return { pane, line, col: Math.max(0, ev.col - 1 - mainX0), exact: rowInBox >= pad && start + (rowInBox - pad) < end };
  }

  // ---- a drag held past the edge --------------------------------------------

  function stopDragScroll() {
    if (!dragScroll.current) return;
    clearInterval(dragScroll.current.timer);
    dragScroll.current = null;
  }

  /**
   * One row of drag scrolling, with the selection following the edge that the
   * scroll uncovers.
   *
   * Reads the store rather than `state`: the timer outlives the render that
   * started it, and `state` is that render's snapshot. `Selection` is anchored
   * to line indices rather than screen rows, so the part already selected does
   * not move while the rows under it do.
   */
  function dragScrollStep(dir: number) {
    const live = store.getState();
    const sel = live.selection;
    if (!sel?.dragging) { stopDragScroll(); return; }
    if (sel.pane === "diff") {
      const bodyH = Math.max(1, transcriptH - 2);
      const max = Math.max(0, diffLines.length - bodyH);
      const next = Math.max(0, Math.min(max, (live.diffView?.scroll ?? 0) + dir));
      store.setDiffScroll(next);
      const line = dir < 0 ? next : Math.min(Math.max(0, diffLines.length - 1), next + bodyH - 1);
      store.extendSelection(line, dir < 0 ? 0 : lineWidth(diffLines[line] ?? []));
      return;
    }
    // The transcript stores its scroll from the *bottom*, so the sign flips.
    const max = Math.max(0, layout.lines.length - transcriptH);
    const next = Math.max(0, Math.min(max, liveScroll(live) - dir));
    scrollTo(next);
    const end = Math.max(0, layout.lines.length - next);
    const start = Math.max(0, end - transcriptH);
    const line = dir < 0 ? start : Math.max(start, end - 1);
    store.extendSelection(line, dir < 0 ? 0 : lineWidth(layout.lines[line] ?? []));
    if (dir < 0 && next >= max && live.view?.hasMore) void store.loadOlder();
  }
  dragStep.current = dragScrollStep;

  function startDragScroll(dir: number) {
    if (dragScroll.current?.dir === dir) return;
    stopDragScroll();
    // Move at once. The event that carried the pointer past the edge should
    // not wait a whole tick for its first row.
    dragScrollStep(dir);
    dragScroll.current = { dir, timer: setInterval(() => dragStep.current(dir), DRAG_SCROLL_MS) };
  }

  // The button can come up outside the pane, outside the terminal, or never at
  // all if the app is torn down mid-drag. Stop the timer in every case.
  useEffect(() => () => stopDragScroll(), []);

  /**
   * Open what the pointer is on: reveal a file in the file manager, or send a
   * URL to the browser.
   *
   * alt+click and ctrl+click, because an SGR mouse report has a bit for each
   * of those and none for cmd, and shift is the escape hatch that gives the
   * terminal its own selection back. The reader's gesture is cmd+click, which
   * the terminal answers over OSC 8 and covey never sees; this is the route
   * for a terminal that knows no OSC 8.
   */
  function openLink(uri: string) {
    const cmd = openCommand(uri, process.platform);
    try {
      // No shell: the URI comes out of the transcript, so it must never be
      // read as a command line.
      const child = spawn(cmd.cmd, cmd.args, { detached: true, stdio: "ignore" });
      child.on("error", () => store.notify(`could not run ${cmd.cmd}`, "error"));
      child.unref();
      store.notify(uri.startsWith("file://") ? `revealed ${truncate(decodeURIComponent(uri.slice(7)), 60)}` : `opened ${truncate(uri, 60)}`, "success");
    } catch {
      store.notify(`could not run ${cmd.cmd}`, "error");
    }
  }

  /** Copy a selection. The caller passes the one it just made, because
   *  `state` is the last render's snapshot and does not hold it yet. */
  function copySelection(selection: Selection | null = state.selection) {
    const sel = selection;
    if (!sel) return;
    const lines = sel.pane === "diff" ? diffLines : layout.lines;
    const { from, to } = selectionBounds(sel);
    const text = selectedText(lines, from, to);
    if (!text.trim()) return;
    // The app's own stream, not `process.stdout`: it is the one ink owns, and
    // in a test it is the one the harness can read.
    copyToClipboard(text, stdout);
    const n = text.split("\n").length;
    store.notify(`copied ${n} line${n === 1 ? "" : "s"}`, "success");
  }

  /**
   * What a double or a triple click takes.
   *
   * Double takes the word under the pointer, where a "word" includes a path:
   * `packages/tui/src/lines.ts:439` is the thing a reader wants, and a
   * boundary that stopped at `/` or `.` would make the gesture useless for the
   * case it is most wanted.
   *
   * Triple takes the whole wrapped run rather than the row under the pointer.
   * A row is a property of the pane width — the same sentence is three rows in
   * a narrow pane and one in a wide one — so the row would be the wrong unit
   * for the same reason the copy used to be wrong.
   */
  function selectByClickCount(hit: { pane: Selection["pane"]; line: number; col: number }, count: number) {
    const lines = hit.pane === "diff" ? diffLines : layout.lines;
    const line = lines[hit.line];
    if (!line) return;
    let anchor: Selection["anchor"];
    let head: Selection["head"];
    if (count === 2) {
      const word = wordRangeAt(line, hit.col);
      if (word.to <= word.from) return;
      anchor = { line: hit.line, col: word.from };
      head = { line: hit.line, col: word.to };
    } else {
      const run = wrappedRun(lines, hit.line);
      anchor = { line: run.from, col: 0 };
      head = { line: run.to, col: lineWidth(lines[run.to]!) };
    }
    store.setSelection(hit.pane, anchor, head);
    copySelection({ pane: hit.pane, anchor, head, dragging: false });
  }

  /**
   * Scroll whatever is on screen: the diff panel when it is open, otherwise the
   * transcript. Positive moves towards the newest line; the huge steps g/G send
   * clamp to the ends. The transcript stores its scroll from the *bottom*, so
   * the sign flips there.
   */
  function scrollPane(lines: number) {
    // The live state, not the render snapshot: a held key arrives as one
    // batched chunk and is replayed key by key, so each repeat has to measure
    // from the one before it. `store.set` writes and notifies synchronously,
    // so `getState()` is already the result of the last repeat.
    const live = store.getState();
    if (live.diffView) {
      const max = Math.max(0, diffLines.length - Math.max(1, transcriptH - 2));
      store.setDiffScroll(Math.max(0, Math.min(max, live.diffView.scroll + lines)));
      return;
    }
    const max = Math.max(0, layout.lines.length - transcriptH);
    const next = Math.max(0, Math.min(max, liveScroll(live) - lines));
    scrollTo(next);
    if (lines < 0 && next >= max && live.view?.hasMore) void store.loadOlder();
  }

  /** Fold or unfold the most recent tool call or thinking block. */
  function expandLastTool() {
    const items = [...(state.view?.items.values() ?? [])].filter((i) => i.kind === "tool" || i.kind === "thinking").sort((a, b) => b.seq - a.seq);
    if (items[0]) store.toggleItem(items[0].id);
  }

  /**
   * A wheel notch over an overlay moves that list, and only that list.
   *
   * The list is windowed on its own cursor, so moving the cursor is what
   * scrolling means here. Nothing is opened by it: an overlay row is picked
   * with enter, never by arriving on it.
   */
  function scrollOverlay(ev: MouseEvent) {
    const ov = state.overlay;
    if (!ov) return;
    const rows = ov.kind === "pick" ? filterOptions(ov.options, ovFilter).length
      : ov.kind === "secrets" ? secretPanelKeys(state, ov).length : 0;
    if (rows === 0) return;
    const delta = wheelDelta(ev, Math.floor(transcriptH / 2));
    if (delta === 0) return;
    // A notch up goes towards the first row, which is the lower index.
    setOvCursor((c) => Math.max(0, Math.min(rows - 1, c - delta)));
  }

  function handleMouse(ev: MouseEvent) {
    // An overlay covers the screen, so the conversation behind it is not what
    // the pointer is on. The wheel still means something there; nothing else
    // does.
    if (state.overlay) { if (ev.kind === "wheel") scrollOverlay(ev); return; }
    const inSidebar = sidebarVisible && ev.col <= SIDEBAR_W;
    const inTranscript = ev.row >= TRANSCRIPT_TOP && ev.row < TRANSCRIPT_TOP + transcriptH && !inSidebar;

    if (ev.kind === "wheel") {
      // One row a notch, alt for half a page. 0 is a sideways notch, which
      // nothing here scrolls; it must not load older lines either, so leave
      // before any of that.
      const delta = wheelDelta(ev, Math.floor(transcriptH / 2));
      if (delta === 0) return;
      // Where the pointer is does not choose the target: a scroll anywhere in
      // the terminal scrolls the conversation that is open. Scrolling is how
      // you move inside what you are reading, and it must never move you
      // between things to read.
      //
      // The sidebar used to take the notch and move its cursor, and the
      // cursor opens the thread it lands on — so a notch over the sidebar
      // opened a conversation nobody asked for. The sidebar has no viewport
      // of its own to scroll instead; the cursor *is* the window. Giving it
      // one is a larger change than this defect needs, so for now the sidebar
      // does not answer the wheel at all, and the notch goes to the
      // transcript like every other notch.
      //
      // A notch also does not call `setFocus`. Scrolling is not a click.
      //
      // Same rule as `scrollPane`: a chunk holds several notches and is
      // replayed one at a time, so every notch measures from the store rather
      // than from `state`, which is the last render's snapshot and does not
      // move inside the loop. Read the snapshot and five notches move one row.
      const live = store.getState();
      if (live.diffView) return store.setDiffScroll(live.diffView.scroll - delta);
      const max = Math.max(0, layout.lines.length - transcriptH);
      const next = Math.min(max, Math.max(0, liveScroll(live) + delta));
      scrollTo(next);
      if (next >= max && live.view?.hasMore) void store.loadOlder();
      return;
    }

    if (ev.kind === "press") {
      stopDragScroll();
      store.clearSelection();
      pressedLine.current = null;
      const run = countClick(clickRun.current, ev, Date.now());
      clickRun.current = run;
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
        if (hit?.exact && (ev.alt || ev.ctrl) && !state.diffView) {
          const uri = linkAt(layout.lines[hit.line] ?? [], hit.col);
          // A modified click that lands on no link starts no selection
          // either: it asked to open something, and nothing was there.
          if (uri) openLink(uri);
          else store.notify(`no link here — ${OPEN_GESTURE} a path or a URL`);
          return;
        }
        // A plain click selects, and says what the reader had to hold. The
        // terminal keeps cmd for itself, so a reader who clicks a #N and
        // sees nothing happen has no other way to learn the gesture.
        //
        // The words, not the target: the notice shares its row with the title
        // bar, which already crowds it below about 94 columns (#87), and the
        // reader is pointing at the target as they read this.
        if (hit?.exact && run.count === 1 && !state.diffView) {
          const uri = linkAt(layout.lines[hit.line] ?? [], hit.col);
          if (uri) store.notify(`${OPEN_GESTURE} to ${uri.startsWith("file://") ? "reveal this file" : "open this link"}`);
        }
        // A second or a third press selects instead of starting a drag, and
        // must not fold what the first press already toggled underneath it.
        if (hit?.exact && run.count >= 2) return selectByClickCount(hit, run.count);
        pressedLine.current = hit?.exact ? hit.line : null;
        if (hit) store.beginSelection(hit.pane, hit.line, hit.col);
        return;
      }
      store.setFocus("composer");
      return;
    }

    if (ev.kind === "drag") {
      // The store, not `state`: a press and the drag after it can arrive in
      // one chunk, and `state` is the snapshot from before either of them.
      const sel = store.getState().selection;
      if (!sel) { stopDragScroll(); return; }
      // Past the top or the bottom edge the drag scrolls instead of pointing.
      // A selection that could not leave the screen was most of the reason
      // selecting anything longer than a paragraph was not worth trying.
      const above = ev.row < TRANSCRIPT_TOP;
      const below = ev.row >= TRANSCRIPT_TOP + transcriptH;
      if (above || below) return startDragScroll(above ? -1 : 1);
      stopDragScroll();
      const hit = hitTest(ev, sel.pane);
      if (hit) store.extendSelection(hit.line, hit.col);
      return;
    }

    if (ev.kind === "release") {
      // The button is up, so nothing is dragging any more. This is the leak:
      // a release outside the pane used to leave the timer running.
      stopDragScroll();
      const line = pressedLine.current;
      pressedLine.current = null;
      // Same rule again. A quick click arrives as one chunk, so at this point
      // `state.selection` is still null and the selection the press just made
      // would never be ended — leaving an empty one behind for ever.
      const sel = store.getState().selection;
      if (sel?.dragging && store.endSelection()) { copySelection(sel); return; }
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
    // Any real keystroke dismisses a selection, and with it any drag still
    // scrolling past an edge.
    if (state.selection) { stopDragScroll(); store.clearSelection(); }
    // Ink batches rapid keystrokes (and pastes) into one string. In the
    // composer a multi-char chunk is a paste; elsewhere replay it key by key.
    const special = rawKey.upArrow || rawKey.downArrow || rawKey.leftArrow || rawKey.rightArrow || rawKey.return || rawKey.escape || rawKey.tab || rawKey.backspace || rawKey.delete || rawKey.pageUp || rawKey.pageDown || rawKey.ctrl || rawKey.meta || rawKey.super;
    const editing = state.focus === "composer" && !state.overlay && !pending;
    if (rawInput.length > 1 && !special && !(editing && !/^[\r\n]+$/.test(rawInput))) {
      // `pasted` marks a key with more of its chunk behind it. The last
      // character of a chunk is never marked: whatever ends a chunk is the
      // last thing the reader did, whether they pasted it or typed it, and a
      // rule that dropped it would eat the enter of a fast typist. Only the
      // one-line prompts read this (#128).
      const chars = [...rawInput];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]!;
        const k = { ...rawKey, pasted: i < chars.length - 1 };
        if (ch === "\r" || ch === "\n") handleKey("", { ...k, return: true });
        else if (ch === "\t") handleKey("", { ...k, tab: true });
        else if (ch === "\x1b") handleKey("", { ...k, escape: true });
        else handleKey(ch, k);
      }
      return;
    }
    if (editing && rawInput.length > 1 && !special) {
      pasteText(rawInput);
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
    // Tab completes the highlighted command before it cycles the focus. The
    // menu is only ever open with the composer focused and a command name in
    // the draft, so this costs the focus key nothing anywhere else.
    if (key.tab && !key.shift && menu && menu.rows.length > 0) { acceptMenu(); return; }
    if (key.tab) {
      store.setFocus(sidebarVisible && state.focus === "composer" ? "sidebar" : "composer");
      return;
    }
    if (state.focus === "sidebar") return handleSidebarKey(input, key);
    return handleComposerKey(input, key);
  }

  function handleOverlayKey(input: string, key: any) {
    const ov = state.overlay!;
    if (key.escape) {
      store.setOverlay(null);
      setOvFilter("");
      // A pick opened from the run panel goes back to it, rather than closing
      // the panel the reader was working in.
      if (ov.kind === "input" || ov.kind === "pick") ov.onCancel?.();
      return;
    }
    if (ov.kind === "help" || ov.kind === "update") return;
    if (ov.kind === "run") return handleRunKey(ov, input, key);
    if (ov.kind === "secrets") return handleSecretsKey(ov, input, key);
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
      // One rule, and it is the whole of #128: a newline with more of its
      // chunk behind it does not confirm. The newline that *ends* a chunk
      // does, so a paste with a trailing newline still confirms, and so does
      // the enter of a typist quick enough to share a chunk with their text.
      //
      // In a masked field the newline is content — a private key is a real
      // secret and has to paste whole. In a one-line field it is dropped, the
      // way a browser drops it, so the paste lands in the field entire instead
      // of submitting at its first line and again at its second.
      if (key.return && key.pasted) {
        if (ov.mask) setOvFilter((f) => f + "\n");
        return;
      }
      // Read the ref, not the state: inside a paste the state is a render old.
      // Trimmed, masked or not: a value pasted from a password manager often
      // carries a newline, and no credential wants the space around it.
      if (key.return) { ov.onSubmit(ovFilterRef.current.trim()); setOvFilter(""); return; }
      if (key.backspace || key.delete) { setOvFilter((f) => f.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setOvFilter((f) => f + input);
      return;
    }
    // The ref again, and for the same reason: a paste that ends in a newline
    // would otherwise pick a row out of a list filtered by a render-old string.
    const list = ov.kind === "pick" ? filterOptions(ov.options, ovFilterRef.current) : [];
    const len = list.length;
    if (key.upArrow) return setOvCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setOvCursor((c) => Math.min(len - 1, c + 1));
    if (key.tab && ov.kind === "pick" && ov.toggle) return setOvToggle((t) => !t);
    if (ov.kind === "pick" && ov.many) {
      // Space marks the row under the cursor; enter hands over every mark.
      if (input === " ") {
        const o = list[ovCursor] as PickOption | undefined;
        if (!o) return;
        const marked = new Set(ov.many.marked);
        if (marked.has(o.id)) marked.delete(o.id); else marked.add(o.id);
        store.setOverlay({ ...ov, many: { ...ov.many, marked } });
        return;
      }
      if (key.return) { setOvFilter(""); ov.many.onMany([...ov.many.marked]); return; }
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
    // The group a row heads, when it heads one, and whether that kind of group
    // is open before anyone touches it (#69). A run is open by default and a
    // thread group furled, so the default travels with the key — reading one
    // without the other answers "is it furled?" wrongly for half the tree.
    const groupOf = (r: SidebarRow): { key: string; dflt: boolean } | null =>
      r.kind === "thread" && r.group ? { key: threadGroupKey(r.machine, r.thread!.id), dflt: false }
      : r.kind === "run" ? { key: runKey(r.machine, r.run!.id), dflt: true }
      : null;
    if (key.return || input === "l" || key.rightArrow) {
      // → unfurls a furled group, the way it unfurls a project. enter always
      // opens the row — the thread, or the run's panel — and so does a click:
      // a click on a thread row has always meant "open this conversation", and
      // the row that most wants clicking is the one that dispatched everything
      // below it (#69). A run had only the second half of this rule: ← furled
      // it and → opened its panel, so a run the operator closed could not be
      // opened again from the sidebar at all.
      const g = !key.return ? groupOf(row) : null;
      if (g && !store.isExpanded(g.key, g.dflt)) return store.toggleExpanded(g.key, g.dflt);
      return activateRow(row);
    }
    if (input === "h" || key.leftArrow) {
      // Inside the archived folder, left folds the folder rather than the
      // project the thread happens to belong to.
      if (row.archived) { const k = archiveKey(row.groupKey!); if (store.isExpanded(k, false)) store.toggleExpanded(k, false); return; }
      if (row.kind === "machine") { if (store.isExpanded(MACHINES_KEY, false)) store.toggleExpanded(MACHINES_KEY, false); return; }
      // A member row carries its run too, so the kinds are told apart here: a
      // member's parent is the run it is in, and a run's is the thread that
      // asked for it. One ← that walked a member all the way out to the thread
      // would skip the run row painted directly above it.
      if (row.kind === "member") {
        const k = runKey(row.machine, row.run!.id);
        if (store.isExpanded(k)) { store.toggleExpanded(k); return; }
        // Furled, and this member is painted because it needs a person: the
        // cursor moves to the run, which is where the fold lives.
        const at = rows.findIndex((r) => r.kind === "run" && r.machine === row.machine && r.run!.id === row.run!.id);
        if (at >= 0) setCursorKey(rows[at]!.key);
        return;
      }
      if (row.kind === "run") {
        const k = runKey(row.machine, row.run!.id);
        if (store.isExpanded(k)) { store.toggleExpanded(k); return; }
        // A furled run under the thread that asked for it: left moves to that
        // thread, the way it moves from a child thread to its parent, so ←←
        // is the way out of a run from any row inside it.
        //
        // Only to the thread it is really painted under. A run whose parent is
        // archived, or in another project, sits under its project instead, and
        // the thread it names may still have a row somewhere else on the
        // machine — inside the Archived folder, or in another project's
        // subtree. ← must not jump the cursor out of the subtree it is in.
        const parent = row.run!.parentThreadId;
        const at = parent ? rows.findIndex((r) => r.kind === "thread" && r.machine === row.machine
          && r.projectId === row.projectId && !r.archived && r.depth < row.depth && r.thread!.id === parent) : -1;
        if (at >= 0) setCursorKey(rows[at]!.key);
        return;
      }
      if (row.kind === "thread") {
        // An unfurled group furls. A child has no group of its own, so left
        // moves to its parent — which is where the group's furl lives, so a
        // second left furls the group you were just inside. That is the tree
        // idiom, and it makes ←← the way out of a group from any row in it.
        const g = groupOf(row);
        if (g && store.isExpanded(g.key, g.dflt)) { store.toggleExpanded(g.key, g.dflt); return; }
        const parent = row.thread!.origin?.parentThreadId;
        const at = parent ? rows.findIndex((r) => r.kind === "thread" && r.machine === row.machine && r.thread!.id === parent) : -1;
        if (at >= 0) { setCursorKey(rows[at]!.key); return; }
      }
      if (row.groupKey) { if (store.isExpanded(row.groupKey)) store.toggleExpanded(row.groupKey); }
      return;
    }
    if (input === "n") { if (row.projectId) void newThread(row.machine, row.projectId); return; }
    if (input === "a") return addProject();
    if (input === "d" && state.view) return void store.toggleDiff();
    if (input === "m" && row.kind === "thread") return moveThread();
    if (input === "r" && row.kind === "thread") return openInput("Rename thread", (v) => { store.setOverlay(null); void store.threadCommand({ type: "thread.rename", threadId: row.thread!.id, title: v }, row.machine); }, row.thread!.title);
    // A project's name starts as the repository's and is the reader's to
    // change. Each machine of the pool holds its own row, so the name goes to
    // every one of them.
    if (input === "r" && row.kind === "project") return openInput("Rename project", (v) => { store.setOverlay(null); if (v.trim()) void store.renameProject(row.pool ?? [], v.trim()); }, row.project!.title);
    // The branch the project's threads start from and its pull requests target.
    if (input === "b" && row.kind === "project") return changeBase(row);
    // The environment the threads of a project work in, or one thread's own.
    // The values go to the daemon and never come back (#126).
    if (input === "e" && (row.kind === "project" || row.kind === "thread")) return openSecrets(row);
    if (input === "x" && row.kind === "thread") return void store.threadCommand({ type: "thread.archive", threadId: row.thread!.id, archived: !row.thread!.archivedAt }, row.machine);
    // Flip who merges the thread's pull request. A person who has looked at
    // the change and wants it landed presses this once.
    if (input === "M" && row.kind === "thread" && row.thread!.watch?.state === "watching") return void store.threadCommand({ type: "thread.setMerge", threadId: row.thread!.id, merge: row.thread!.watch!.merge === "auto" ? "manual" : "auto" }, row.machine);
    if (input === "D" && row.kind === "thread") return openPick(`Delete "${row.thread!.title}"?`, [{ id: "no", label: "Cancel" }, { id: "yes", label: "Delete thread and its transcript" }], (id) => { store.setOverlay(null); if (id === "yes") void store.threadCommand({ type: "thread.delete", threadId: row.thread!.id }, row.machine); });
    if (input === "D" && row.kind === "project") {
      // From one machine of the pool, or from all of them. The clone stays on
      // disk either way; the rows and the threads go.
      const pool = row.pool ?? [];
      const name = (k: string) => machineLabel(state, k);
      // A machine key is a URL, so it can never read as `no` or `all`.
      const opts: PickOption[] = [
        { id: "no", label: "Cancel" },
        ...(pool.length > 1 ? [{ id: "all", label: `Remove from every machine (${poolMachines(pool)}) and delete its threads` }] : []),
        // A machine that holds the repository twice, as a clone and as a
        // checkout from before, gets a row for each, named by kind.
        ...pool.map((x) => {
          const twice = pool.filter((y) => y.machine === x.machine).length > 1;
          const what = twice ? ` (${x.project.kind === "clone" ? "the clone" : "your checkout"})` : "";
          return { id: `${x.machine}\n${x.projectId}`, label: pool.length > 1 ? `Remove from ${name(x.machine)}${what} and delete its threads there` : "Remove project and all its threads", hint: name(x.machine) };
        }),
      ];
      return openPick(`Remove project "${row.project!.title}"?`, opts, (id) => {
        store.setOverlay(null);
        if (id === "no") return;
        const targets = id === "all" ? pool : pool.filter((x) => `${x.machine}\n${x.projectId}` === id);
        for (const x of targets) void store.removeFromPool(x.machine, x.projectId);
      });
    }
  }

  /**
   * esc in the composer, which is the last of its five jobs: the overlay, the
   * diff pane and the `/` menu have all passed on the key before this runs.
   * The draft is never written here — ctrl+c is the only key that empties it.
   */
  function handleEscape() {
    const running = state.view?.thread?.latestTurn?.state === "running";
    switch (rewindAction({
      running,
      pending: !!pending,
      sinceInterruptMs: Date.now() - interruptedAt.current,
      sinceArmMs: Date.now() - armedAt.current,
    })) {
      case "interrupt":
        interruptedAt.current = Date.now();
        armedAt.current = 0; // stopping work is not half of a chord
        return void store.interrupt();
      case "arm":
        armedAt.current = Date.now();
        return store.notify("press esc again to rewind");
      case "open":
        armedAt.current = 0;
        return openRewind();
      case "none":
        return;
    }
  }

  /**
   * Which turn to rewind to, then a confirmation, then the daemon does the
   * work. ctrl+k and esc esc both come here: two routes, one action. A rewind
   * discards work and rewrites the working tree, so the confirmation stays
   * whichever route opened it.
   */
  function openRewind() {
    const t = state.view?.thread;
    const turns = [...(state.view?.items.values() ?? [])].filter((i) => i.kind === "user" && i.turnId && !i.queued && !i.folded).sort((a, b) => b.seq - a.seq);
    if (!t || turns.length === 0) return store.notify("no turns to revert", "error");
    return openPick("Revert to before which turn?", turns.map((u) => ({ id: u.turnId!, label: (u as any).text.split("\n")[0].slice(0, 70), hint: new Date(u.createdAt).toLocaleTimeString() })), (turnId) => {
      const u = turns.find((x) => x.turnId === turnId)!;
      openPick(`Revert files and conversation to before "${(u as any).text.slice(0, 40)}"?`, [{ id: "no", label: "Cancel" }, { id: "yes", label: "Revert — this turn and everything after it are discarded" }], (ans) => {
        store.setOverlay(null);
        if (ans === "yes") void store.revertTurn(t.id, turnId);
      });
    });
  }

  function handleComposerKey(input: string, key: any) {
    const running = state.view?.thread?.latestTurn?.state === "running";
    // While the `/` menu is open it takes the keys that mean "choose", and
    // nothing else: every other key edits the draft, and editing the draft is
    // what filters the list.
    if (menu) {
      if (key.escape) { setMenuClosed(true); return; }
      if (menu.rows.length > 0) {
        if (key.upArrow) { setMenuIndex(Math.max(0, menu.index - 1)); return; }
        if (key.downArrow) { setMenuIndex(Math.min(menu.rows.length - 1, menu.index + 1)); return; }
        if (key.return && !key.shift && !key.ctrl && !key.meta && !key.super) { acceptMenu(); return; }
      }
    }
    if (key.escape) { handleEscape(); return; }
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
        // One question at a time: the keys below always act on the question the
        // user has reached, and only the last answer sends the set.
        const opts = currentAsk(pending, answersGiven)?.options ?? [];
        const customRow = opts.length;
        const take = (a: string) => {
          const { answered, send } = takeAnswer(pending, answersGiven, a);
          setAnswersGiven(answered);
          setAnswerDraft("");
          setQuestionCursor(0);
          if (send) void store.respondQuestion(send);
        };
        // Functional updates throughout: a batched chunk is replayed character
        // by character here, so reading state from the closure would let each
        // replay clobber the last instead of accumulating.
        if (key.upArrow) { setQuestionCursor((c) => Math.max(0, c - 1)); return; }
        if (key.downArrow) { setQuestionCursor((c) => Math.min(customRow, c + 1)); return; }
        if (key.return) {
          if (questionCursor < opts.length) { take(opts[questionCursor]!.label); return; }
          const a = answerDraft.trim();
          if (a) take(a);
          return;
        }
        if (answerDraft.length === 0 && /^[1-9]$/.test(input) && Number(input) <= opts.length) {
          take(opts[Number(input) - 1]!.label);
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
      // An image on its own is a legitimate turn: its tag is the whole text.
      if (!text) return;
      void store.sendTurn(text);
      if (running) store.notify("sent — the agent picks it up at its next tool call");
      setDraft(""); setCaret(0);
      return;
    }
    if ((key.ctrl && input === "j") || (key.return && (key.shift || key.meta || key.super))) return insert("\n");
    if (key.backspace || key.delete) {
      // An attachment has no key of its own: delete its tag out of the draft.
      // cmd (super) = line-scoped, alt (meta) = word-scoped, bare = one char.
      const st = { value: draft, caret };
      const fwd = key.delete;
      if (key.super) return applyEdit(fwd ? Ed.deleteToLineEnd(st) : Ed.deleteToLineStart(st));
      if (key.meta) return applyEdit(fwd ? Ed.deleteWordForward(st) : Ed.deleteWordBack(st));
      // A chip is one thing on the screen, so it is one key to delete. Without
      // this the reader spells `[Screenshot 2026-09-22 at 8.48.31 PM.png]` out
      // backwards, and a chip half deleted is a file silently dropped.
      const span = tagSpanAt(draft, caret, chipTags(), !fwd);
      if (span) return applyEdit(cutTag(draft, span));
      return applyEdit(fwd ? Ed.deleteForward(st) : Ed.deleteBack(st));
    }
    if (key.leftArrow) return setCaret(key.meta ? Ed.wordStart(draft, caret) : key.super ? Ed.lineStart(draft, caret) : Math.max(0, caret - 1));
    if (key.rightArrow) return setCaret(key.meta ? Ed.wordEnd(draft, caret) : key.super ? Ed.lineEnd(draft, caret) : Math.min(draft.length, caret + 1));
    // Move by *visual* row so a wrapped paragraph steps line by line. Only
    // from the first row up, or the last row down, do the keys leave the draft
    // and walk the messages this thread has sent. That walk fills the draft
    // and does nothing else — it is not a rewind (`history.ts`).
    if (key.upArrow || key.downArrow) {
      const dir: -1 | 1 = key.upArrow ? -1 : 1;
      const step = stepHistory(sentMessages(state.view?.items.values() ?? []), walk, draft, caret, editorRows, dir);
      if (step.kind === "recall") { setDraft(step.draft); setCaret(step.caret); setWalk(step.walk); return; }
      return setCaret(Ed.moveVisualRow({ value: draft, caret }, editorRows, dir));
    }
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
    //
    // cmd+v does the same wherever the terminal hands it over. Most macOS
    // terminals keep it for their own paste and covey never sees it, but the
    // ones that speak the kitty keyboard protocol send it — the same route
    // cmd+backspace already arrives by — and on a Mac cmd+v is the key a
    // person reaches for. Taking it costs nothing where it never arrives, and
    // covey's own read is the better answer where it does: the terminal's
    // paste can only ever deliver text.
    if ((key.ctrl || key.super) && input === "v") return pasteClipboard();
    if (input && !key.ctrl && !key.meta && !key.super) insert(input);
  }
  /**
   * Take the highlighted row. A command replaces the whole draft, because the
   * menu is only open while the draft is the command name; a file replaces the
   * `@word` the caret is in, wherever in the sentence that is.
   */
  function acceptMenu() {
    if (!menu) return;
    if (menuKind === "command") {
      const c = commandItems[menu.index];
      if (c) applyEdit(acceptCommand(c));
      return;
    }
    const e = mentionItems[menu.index];
    if (e && mention) applyEdit(acceptMention(draft, mention, e));
  }
  /**
   * Put the files into the sentence as tags, at the caret. Both ways in — a
   * drop and a clipboard paste — come through here, so both read the same.
   * `unreadable` names the dropped files that did not attach; each gets a chip
   * of its own, so the drop never leaves a path on the screen (#85).
   *
   * @returns false when the drop held nothing at all.
   */
  /** The tags standing in the draft for a drop, attached or not. */
  function chipTags(): string[] {
    return state.view ? [...new Set(store.attachments(state.view.threadId).map((a) => a.tag))] : [];
  }
  function attach(attachments: Attachment[], failed: FailedDrop[] = [], base: Ed.EditState = { value: draft, caret }): boolean {
    if ((attachments.length === 0 && failed.length === 0) || !state.view) return false;
    const drop = applyDrop(base.value, base.caret, attachments, store.attachments(state.view.threadId), failed);
    store.setAttachments(state.view.threadId, drop.attachments);
    applyEdit({ value: drop.value, caret: drop.caret });
    pasteSeam.current = null;
    return true;
  }
  /**
   * Put a pasted chunk into the draft. A drag-and-drop arrives as a paste of
   * the file's path, so a chunk that names files becomes attachments; anything
   * else is ordinary text.
   *
   * A chunk that is not a drop may still be the *rest* of one: a terminal is
   * free to write one dropped path in two goes, and the first go is already in
   * the draft as text. So the chunk is tried again against that text while the
   * seam is open, and a join that names a file takes the text back out of the
   * draft (#130). The seam is open only for the moment after a paste that
   * nothing has edited since, so a path a person typed an hour ago cannot eat
   * the next paste.
   */
  function pasteText(raw: string) {
    if (state.view) {
      const whole = readDroppedFiles(raw);
      const seam = openSeam();
      const split = seam ? readSplitDrop(seam.value.slice(0, seam.caret), raw) : null;
      // A directory that exists is also what the front half of a cut path
      // leaves behind, so a join that names a file beats it (#130). Anything
      // else the chunk reads as on its own is what the reader dropped.
      if (isDrop(whole) && !(split && isDirectoryDrop(whole))) {
        report(whole);
        if (attach(whole.attachments, whole.failed)) return;
      }
      if (split) {
        report(split.drop);
        const cut = { value: seam!.value.slice(0, split.start) + seam!.value.slice(seam!.caret), caret: split.start };
        if (attach(split.drop.attachments, split.drop.failed, cut)) return;
      }
    }
    // Normalise line endings and tabs, then insert.
    const next = Ed.insert({ value: draft, caret }, Ed.normalisePaste(raw));
    applyEdit(next);
    pasteSeam.current = { at: Date.now(), ...next };
  }
  /**
   * Say what a drop could not attach. The chip in the draft carries the reason
   * in a few words; this carries the path and the way out (#132).
   */
  function report(drop: DropResult) {
    for (const f of drop.failed) store.notify(f.message, "error");
    for (const w of drop.warnings) store.notify(w, "warning");
  }
  /**
   * The draft a split drop may join onto: the state the last pasted chunk left,
   * when it is still what the composer holds. Any key, any other edit and any
   * wait closes the seam, so the join can only ever finish a paste that is still
   * arriving.
   */
  function openSeam(): { value: string; caret: number } | null {
    const seam = pasteSeam.current;
    if (!seam || Date.now() - seam.at > PASTE_SEAM_MS) return null;
    return seam.value === draft && seam.caret === caret ? seam : null;
  }
  /**
   * ctrl+v: attach whatever the clipboard holds (#124). A file and an image
   * attach; text goes back through the paste path, so a copied path becomes
   * the file it names rather than a path in the sentence.
   */
  function pasteClipboard() {
    if (!state.view) { store.notify("open a thread first (tab → sidebar → enter)"); return; }
    const { attachments, failed, warnings, errors, text } = readClipboard();
    for (const e of errors) store.notify(e, "error");
    for (const f of failed) store.notify(f.message, "error");
    for (const w of warnings) store.notify(w, "warning");
    if (attach(attachments, failed)) return;
    if (text) pasteText(text);
  }
  function applyEdit(next: Ed.EditState) { setDraft(next.value); setCaret(next.caret); }
  function insert(s: string) { applyEdit(Ed.insert({ value: draft, caret }, s)); }

  // ---- render ---------------------------------------------------------------------
  const notice = state.notice;
  // Overlays that belong to a machine (update progress, directory browsing)
  // read their live data from that machine's state, not from the overlay.
  const overlayMachine = state.overlay && state.overlay.kind === "update" ? state.machines.get(state.overlay.machine) : undefined;
  const overlayUpdate = state.overlay?.kind === "update" ? overlayMachine?.update ?? null : null;
  const overlayMachineName = overlayMachine?.info?.name ?? overlayMachine?.saved.name;
  const header = state.view?.thread;
  const headerProject = header && state.machines.get(state.view!.machine)?.projects.get(header.projectId);
  // The title bar follows the pane: naming the open thread over a project
  // summary would describe something that is not on screen.
  const summaryMachine = summaryRow ? state.machines.get(summaryRow.machine) : undefined;
  const summaryTitle = summaryRow && (summaryRow.kind === "project" ? summaryRow.project!.title : summaryRow.kind === "machines" ? "machines" : (summaryMachine?.info?.name ?? summaryMachine?.saved.name ?? ""));
  // A project's subtitle names its pool; a machine's says what it is.
  const summarySub = summaryRow && (summaryRow.kind === "project" ? (summaryRow.pool ?? []).map((x) => machineLabel(state, x.machine)).join(" · ") : summaryRow.kind === "machines" ? `${state.order.length}` : "machine");
  return (
    /* One invariant holds this screen together: nothing covey paints may be
       wider than the terminal it is painted into. Ink's incremental renderer
       writes one screen row per line of its frame and finds the next frame with
       `cursorUp(lines - 1)`; a line the terminal itself has to wrap costs a
       second row Ink never counted, and from there every frame lands a row too
       high — for good, because the lines that would paint over the mess are the
       ones the diff calls unchanged.

       A resize is where that used to happen. Ink registers its own handler for
       the signal inside `render()` and repaints on the spot, from the tree React
       last committed — measured for the terminal that has just gone away — and
       React cannot beat it there: even a synchronous-lane update commits a
       microtask later, after Ink has already written the frame.

       So that frame has to be *right*, not merely cut down to size. This box is
       `100%` of the yoga root, which Ink resizes before it repaints; the pane
       beside the sidebar takes the remainder; and the three panes that set a
       width of their own inside it — `Composer`, `DiffPanel`, `OverlayView` —
       take theirs from their parent. `size` is still what every layout sum
       reads, and stays so. It is the *boxes* that may not trust it, because a
       box is what the stale frame is measured with.

       A clip here would do the same job in one line, and the first draft of this
       had one. Measured at this size on this project's Pi, it costs 3–4 ms of a
       34 ms paint — around a tenth of the budget #78 spent four commits buying —
       because a clip on the stack puts an uncached `sliceAnsi` through every
       write of every frame, for ever, to bound the one frame a resize paints.
       Correct widths measure the same as no fix at all. `resize.test.ts` holds
       the invariant, a case per pane. */
    <Box width="100%" height={size.rows} flexDirection="row">
      {sidebarVisible && <Sidebar state={state} rows={rows} cells={cells} cursor={cursor} width={SIDEBAR_W} focused={state.focus === "sidebar"} />}
      {/* The remainder, whatever the sidebar took — `mainW` is the same number
          in a frame whose `size` is current, and the right one in a frame whose
          `size` is a terminal ago. */}
      <Box flexDirection="column" flexGrow={1}>
        <Box height={1} paddingX={2} justifyContent="space-between">
          <Box>
            {summaryRow ? (<><Text color={T.text} bold>{truncate(summaryTitle || "", Math.max(10, mainW - 40))}</Text><Text color={T.subtle}>  {summarySub}</Text></>)
              : header ? (<><Text color={T.text} bold>{header.title.slice(0, Math.max(10, mainW - 40))}</Text><Text color={T.subtle}>  {headerProject?.title}</Text>{header.pullRequest && <Text color={T.awaiting}>  {HYPERLINKS ? osc8(header.pullRequest.url, `PR #${header.pullRequest.number}`) : `PR #${header.pullRequest.number}`}</Text>}{header.movedTo && <Text color={T.warning}>  moved</Text>}</>)
              : <Text color={T.subtle}>covey — multi-agent TUI</Text>}
          </Box>
          <Text color={notice ? (notice.tone === "error" ? T.danger : notice.tone === "warning" ? T.warning : notice.tone === "success" ? T.success : T.muted) : T.faint}>{notice?.text ?? (state.diffView ? "diff: j/k scroll · d close" : scrollFromBottom > 0 ? "scrolled · cmd+shift+g follows" : state.focus === "sidebar" ? "↑↓ browse · enter open · click works too" : state.view?.thread?.latestTurn?.state === "running" ? "esc interrupt · ctrl+k commands" : "esc esc rewind · ↑ recall · ctrl+k")}</Text>
        </Box>
        {/* Truncated because this is a length, not a box: laid out with a
            `mainW` from the terminal before last it would wrap onto a second row
            and make the frame taller than the screen it is going to. */}
        <Box height={1}><Text color={T.border} wrap="truncate">{"─".repeat(Math.max(0, mainW))}</Text></Box>
        <Box height={transcriptH} flexDirection="column">
          {state.overlay
            ? <OverlayView overlay={state.overlay} cursor={ovCursor} filter={ovFilter} checked={ovToggle} width={mainW} height={transcriptH} update={overlayUpdate} machineName={overlayMachineName} tick={state.tick} run={overlayRun} machineNameOf={(id) => store.machineNameOf(id)} secretKeys={state.overlay.kind === "secrets" ? secretPanelKeys(state, state.overlay) : undefined} />
            : state.diffView
              ? <DiffPanel view={state.diffView} width={mainW} height={transcriptH} lines={diffLines} selection={state.selection} />
              : summaryRow
                ? <Summary state={state} row={summaryRow} width={mainW} height={transcriptH} />
                : <Transcript view={state.view} layout={layout} height={transcriptH} scrollFromBottom={scrollFromBottom} width={mainW} selection={state.selection} />}
        </Box>
        <Composer thread={state.view?.thread ?? null} value={draft} cursor={caret} focused={state.focus === "composer"} width={mainW} pending={pending} machineName={machineName} rows={editorRows} maxRows={maxEditorRows} answerDraft={answerDraft} menu={menu} />
      </Box>
    </Box>
  );
}

