import React from "react";
import { Box, Text } from "ink";
import { threadOnLimit, threadOnTimer, type Thread, type TimelineItem } from "@covey/protocol";
import { limitLeftLabel, limitResetLabel, timerLeftLabel } from "@covey/client";
import { T } from "../theme.js";
import { LIMIT_MARK, TIMER_MARK } from "./Sidebar.js";
import { fmtMs } from "../lines.js";
import { caretToVisual, type VisualLine } from "../editor.js";
import { menuWindowStart, MENU_ROWS, type MenuView } from "../composerMenu.js";

export interface ComposerProps {
  thread: Thread | null;
  value: string;
  cursor: number;
  focused: boolean;
  width: number;
  pending: TimelineItem | null;
  machineName: string;
  /** The model the thread runs, from whichever choice decided it (`threadModel`). */
  model: string;
  /** Word-wrapped rows, computed in App so it can size the box to match. */
  rows: VisualLine[];
  maxRows: number;
  /** Free-text answer being typed for a pending question. */
  answerDraft: string;
  /** The prefix menu — `/` commands, `@` files — while one is open. */
  menu: MenuView | null;
}

/**
 * The finished turn's cost and duration, for the footer. Empty while the turn
 * runs, or when the daemon sent no figure.
 *
 * The `~` is not decoration. The figure is the SDK's own estimate at list
 * prices, and on a subscription plan no such money is charged, so a bare `$`
 * reads as a bill. It also belongs to this turn alone — the SDK reports a
 * running total for the session, which the daemon differences per turn.
 */
export function turnStats(turn: Thread["latestTurn"] | undefined): string {
  if (!turn || turn.state === "running" || turn.costUsd == null) return "";
  const ms = Date.parse(turn.completedAt ?? turn.startedAt) - Date.parse(turn.startedAt);
  return `~$${turn.costUsd.toFixed(3)} · ${fmtMs(ms)}`;
}

/** Renders the multi-line editor. Editing state lives in App (useInput). */
export function Composer({ thread, value, cursor, focused, width, pending, machineName, model, rows, maxRows, answerDraft, menu }: ComposerProps) {
  const running = thread?.latestTurn?.state === "running";
  const lines = editorLines(rows, value, cursor, focused, maxRows);
  const borderColor = pending ? T.warning : focused ? T.accentDim : T.border;
  const mode = thread?.permissionMode ?? "default";
  const bypass = mode === "bypassPermissions";
  const modeLabel = bypass ? "⏵⏵ bypass" : mode === "acceptEdits" ? "accept edits" : mode;
  const modeColor = bypass ? T.danger : mode === "plan" ? T.awaiting : T.subtle;
  const turn = thread?.latestTurn;
  const stats = turnStats(turn);
  const diff = turn?.diff && !turn.diff.unavailable && turn.diff.files.length > 0 ? turn.diff : null;
  const queued = thread?.queuedTurns ?? 0;
  // `threadOnTimer` and not `thread.timer`: a fired timer stays on the row, and
  // the row it stays on must not read as a thread still waiting. `Date.now()`
  // here is what `relTime` already does in the sidebar — the store ticks the
  // client at `CLOCK_MS`, which is what keeps both true.
  const timer = thread && threadOnTimer(thread) ? thread.timer! : null;
  // The same rule for the usage limit, and the two can never both be painted:
  // the one that is set last is the one the thread is waiting on.
  const limit = thread && threadOnLimit(thread) ? thread.usageLimit! : null;
  const now = Date.now();
  // When the limit resets, on this terminal's own clock. The daemon may be a
  // server in UTC and the reader is at a desk somewhere else, so the hour
  // Claude Code wrote is one they would have to translate. The span says how
  // long and this says when, which is the pair the page and the phone show.
  // `width` is this box and not the terminal — the sidebar has its share
  // already — so the guard is low: eight more columns, and the row truncates
  // from the right, where the machine's name is.
  const limitReset = limit && width > 70 ? limitResetLabel(limit, now) : null;
  return (
    /* `100%`, not `width`: see the root box in `App.tsx`. The width prop is
       still what the editor wraps to; this box has to be the width the terminal
       really is, because a frame is painted from it before React has caught up
       with a resize. */
    <Box flexDirection="column" width="100%">
      {menu && <PrefixMenu menu={menu} width={width} />}
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
        {pending ? (
          pending.kind === "approval"
            ? <Text color={T.warning}>{`⚠ approval needed: ${pending.toolName} — y allow · a always · n deny`}</Text>
            : <Text color={T.warning}>? answer above — ↑↓ choose · enter confirm{value.length > 0 ? <Text color={T.faint}>  (your draft is kept)</Text> : null}</Text>
        ) : null}
        {pending?.kind === "question" && answerDraft.length > 0 && (
          <Text>{answerDraft}<Text inverse> </Text></Text>
        )}
        {!pending && lines.map((l, i) => <Text key={i}>{l}</Text>)}
        {!pending && value.length === 0 && !focused ? null : null}
      </Box>
      <Box paddingX={2} height={1} justifyContent="space-between">
        {/* No `overflow` here. Ink takes the innermost clip on its stack rather
            than the intersection, so a clip on this box would answer for the
            status row at whatever width it had last — and the `wrap="truncate"`
            below already holds the text to this box. */}
        <Box flexShrink={1} marginRight={2}>
          <Text wrap="truncate">
            <Text color={T.subtle}>{thread ? model : ""}</Text>
            {thread && <Text color={modeColor} bold={bypass}>  {modeLabel}</Text>}
            {thread && !bypass && width > 90 && <Text color={T.faint}> (shift+tab)</Text>}
            {thread?.branch && <Text color={T.subtle}>  ⎇ {thread.branch}</Text>}
            {/* The timer, in the row the reader is already looking at while
                they read the conversation. It says what the sidebar's
                dim row says, for the one thread that is open: this is asleep
                until covey wakes it, and here is how long. The note is left to
                the sidebar and the status line — this row is the branch and
                the machine, and a sentence here would push both off it. */}
            {timer && <Text color={T.subtle}>  {TIMER_MARK} {timerLeftLabel(timer, now)}</Text>}
            {limit && <Text color={T.subtle}>  {LIMIT_MARK} limit {limitLeftLabel(limit, now)}{limitReset ? ` · resets ${limitReset}` : ""}</Text>}
            {thread && <Text color={T.faint}>  @{machineName}</Text>}
          </Text>
        </Box>
        <Box flexShrink={0}>
          {diff && !running && <Text><Text color={T.success}>+{diff.additions}</Text><Text color={T.danger}> −{diff.deletions}</Text><Text color={T.subtle}> · {diff.files.length} file{diff.files.length === 1 ? "" : "s"} · </Text><Text color={T.accent}>d</Text><Text color={T.subtle}> diff  </Text></Text>}
          {queued > 0 && <Text color={T.warning}>{queued} queued  </Text>}
          {running ? <Text color={T.working}>working… <Text color={T.subtle}>esc interrupt{width > 100 ? " · ctrl+b background" : ""} · enter joins in</Text></Text> : <Text color={T.faint}>{stats}</Text>}
          <Text color={T.faint}>{running ? "" : width > 110 ? "  enter send · shift+enter newline" : ""}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * The prefix menu, above the draft.
 *
 * Above, because Ink cannot paint under `position="absolute"`: a list that
 * overlaps the transcript is not available, so the composer grows upwards and
 * the transcript gives up the rows. The heavy full-view picker is the wrong
 * shape for something that re-filters on every keystroke.
 */
function PrefixMenu({ menu, width }: { menu: MenuView; width: number }) {
  const { rows, index } = menu;
  if (rows.length === 0) {
    return <Box paddingX={2}><Text color={T.subtle} wrap="truncate">{menu.empty}</Text></Box>;
  }
  const first = menuWindowStart(rows.length, index);
  const shown = rows.slice(first, first + MENU_ROWS);
  const labelW = Math.min(30, Math.max(...shown.map((r) => r.label.length)));
  const hintW = Math.max(0, width - 4 - labelW - 2);
  return (
    <Box flexDirection="column" paddingX={2}>
      {shown.map((r, i) => {
        const selected = first + i === index;
        return (
          <Text key={r.key} wrap="truncate">
            <Text color={T.accent} bold>{selected ? "\u276f " : "  "}</Text>
            <Text color={selected ? T.text : T.muted} bold={selected} backgroundColor={selected ? T.selection : undefined}>{r.label.padEnd(labelW).slice(0, labelW)}</Text>
            <Text color={T.subtle} backgroundColor={selected ? T.selection : undefined}>{"  " + r.hint.slice(0, hintW)}</Text>
          </Text>
        );
      })}
      <Box paddingX={2}>
        <Text color={T.faint} wrap="truncate">
          {`\u2191\u2193 choose \u00b7 tab or enter completes \u00b7 esc closes${rows.length > MENU_ROWS ? `  (${index + 1}/${rows.length})` : ""}`}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Paint the wrapped rows, scrolled so the caret's row stays visible. The rows
 * are already word-wrapped by `wrapEditorLines`; all this does is slice a
 * window and invert one cell for the caret.
 */
function editorLines(rows: VisualLine[], value: string, cursor: number, focused: boolean, maxRows: number): React.ReactNode[] {
  if (value.length === 0) {
    return [<Text key="ph">{focused ? <Text inverse> </Text> : null}<Text color={T.subtle}>{focused ? "Message Claude…" : " Message Claude…"}</Text></Text>];
  }
  const { row: caretRow, col: caretCol } = caretToVisual(rows, cursor);
  let first = Math.max(0, rows.length - maxRows);
  if (caretRow < first) first = caretRow;
  else if (caretRow >= first + maxRows) first = caretRow - maxRows + 1;
  return rows.slice(first, first + maxRows).map((l, i) => {
    const idx = first + i;
    if (focused && idx === caretRow) {
      return <Text key={idx}>{l.text.slice(0, caretCol)}<Text inverse>{l.text[caretCol] ?? " "}</Text>{l.text.slice(caretCol + 1)}</Text>;
    }
    return <Text key={idx}>{l.text.length > 0 ? l.text : " "}</Text>;
  });
}
