import React from "react";
import { Box, Text } from "ink";
import type { AppState, Selection } from "../store.js";
import { type Line } from "../lines.js";
import { applySelection } from "./Transcript.js";
import { exitLabel, promptLead, shellPrompt } from "../shell.js";
import { T } from "../theme.js";

/**
 * The thread's shell, in place of the transcript (#10).
 *
 * In place of, not over: Ink cannot paint under `position="absolute"`, so every
 * pane here replaces the one beside it. `DiffPanel` is the precedent and this
 * follows its shape — a header row, a scrolled body, the same escape key.
 *
 * The one thing it has that the diff does not is a prompt row, because this
 * pane takes typing. The prompt is covey's own: a shell driven through pipes
 * prints none (`shell.ts`).
 */
export function TerminalPanel({ view, width, height, lines, selection }: { view: NonNullable<AppState["terminal"]>; width: number; height: number; lines: Line[]; selection: Selection | null }) {
  // One row of header, one of prompt. The rest is output, and never less than
  // one row: a pane two rows tall is a resize mid-drag, not a reader's screen.
  const bodyH = Math.max(1, height - 2);
  const maxScroll = Math.max(0, lines.length - bodyH);
  const from = Math.max(0, Math.min(maxScroll, maxScroll - view.scroll));
  const slice = applySelection(lines.slice(from, from + bodyH), from, selection, "terminal");
  const status = exitLabel(view.exitCode);
  const prompt = `${promptLead(view.cwd)} $ `;
  // The caret is a cell of the draft under an inverted colour, so it sits on
  // the character it is before rather than between two of them. At the end of
  // the line there is no character, so it is painted on a space.
  const before = view.draft.slice(0, view.caret);
  const at = view.draft.slice(view.caret, view.caret + 1) || " ";
  const after = view.draft.slice(view.caret + 1);
  return (
    /* `100%`, not `width`: see the root box in `App.tsx`. */
    <Box flexDirection="column" width="100%" height={height} paddingX={1}>
      <Box height={1}>
        <Text color={T.text} bold>Shell </Text>
        <Text color={T.subtle} wrap="truncate">{shellPrompt(view.cwd)}</Text>
        {view.busy && <Text color={T.awaiting}>  running</Text>}
        {view.ended && <Text color={T.warning}>  ended</Text>}
        {!view.busy && !view.ended && status && <Text color={status.bad ? T.danger : T.subtle}>  {status.text}</Text>}
        {view.scroll > 0 && <Text color={T.faint}>   {maxScroll - view.scroll}/{maxScroll}</Text>}
      </Box>
      {/* The rows a short log does not fill go *above* it, so the newest line
          is always the one just over the prompt and the reader's eye does not
          have to travel. The transcript is painted flush to its bottom for the
          same reason, and `hitTest` in `App.tsx` measures this same padding —
          change one and the other points at the wrong row. */}
      {Array.from({ length: Math.max(0, bodyH - slice.length) }, (_, i) => <Text key={`pad${i}`}> </Text>)}
      {slice.map((l, i) => (
        <Text key={from + i} wrap="truncate">{l.length === 0 ? " " : l.map((s, j) => <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>{s.text}</Text>)}</Text>
      ))}
      <Box height={1}>
        {view.ended
          ? <Text color={T.subtle} wrap="truncate">the shell ended · ctrl+` opens a new one</Text>
          : view.busy
            ? <Text color={T.subtle} wrap="truncate">{`> ${before}`}<Text inverse>{at}</Text>{after}</Text>
            : <><Text color={T.success}>{prompt}</Text><Text color={T.text} wrap="truncate">{before}<Text inverse>{at}</Text>{after}</Text></>}
      </Box>
    </Box>
  );
}
