import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { ToolCallItem } from "@covey/protocol";
import { selectionBounds, type Selection, type ThreadView } from "../store.js";
import { renderItem, renderToolGroupHead, highlightLine, colToIndex, lineText, type Line } from "../lines.js";
import { hyperlinksEnabled, osc8, type LinkContext } from "../links.js";
import { T } from "../theme.js";

/** Apply a pane-scoped selection to the visible slice of a line array. */
export function applySelection(slice: Line[], first: number, selection: Selection | null, pane: Selection["pane"]): Line[] {
  if (!selection || selection.pane !== pane) return slice;
  const { from, to } = selectionBounds(selection);
  return slice.map((l, i) => {
    const idx = first + i;
    if (idx < from.line || idx > to.line) return l;
    const a = idx === from.line ? colToIndex(l, from.col) : 0;
    const b = idx === to.line ? colToIndex(l, to.col) : lineText(l).length;
    return highlightLine(l, a, b, T.selection);
  });
}

export interface TranscriptLayout {
  lines: Line[];
  itemStarts: { id: string; start: number; end: number }[];
  /** Line index → the id a click on that line folds or unfolds. */
  toggles: Map<number, string>;
}

/** A turn with fewer than this many calls is shorter left alone than folded. */
const MIN_GROUP = 2;

/** The fold key for a turn's tool calls; shares the store's expandedItems set. */
export const toolGroupKey = (turnId: string) => `tools:${turnId}`;

/**
 * Lay the transcript out, folding away the tool calls of turns the
 * conversation has already moved past.
 *
 * The newest turn is left intact — that is the part being read, and watching
 * its calls is the point. Every turn before it keeps its prose and collapses
 * its calls into one `>_ N tool calls` row, placed where the first of them
 * was. `toolsExpanded` (ctrl+o) overrides the lot.
 *
 * `links` marks the paths and the URLs. It is the caller's job because whether
 * a path is openable depends on which machine the thread runs on.
 */
export function layoutTranscript(view: ThreadView | null, width: number, expanded: Set<string>, questionCursor = 0, toolsExpanded = false, links?: LinkContext): TranscriptLayout {
  const lines: Line[] = [];
  const itemStarts: TranscriptLayout["itemStarts"] = [];
  const toggles = new Map<number, string>();
  if (!view) return { lines, itemStarts, toggles };
  const items = [...view.items.values()].sort((a, b) => a.seq - b.seq);
  const opts = { width, expanded, questionCursor, links };

  const liveTurn = view.thread?.latestTurn?.turnId ?? null;
  const groups = new Map<string, ToolCallItem[]>();
  if (!toolsExpanded) {
    for (const it of items) {
      if (it.kind !== "tool" || !it.turnId || it.turnId === liveTurn) continue;
      const g = groups.get(it.turnId) ?? [];
      g.push(it);
      groups.set(it.turnId, g);
    }
    for (const [turnId, g] of groups) if (g.length < MIN_GROUP) groups.delete(turnId);
  }

  for (const it of items) {
    const group = it.kind === "tool" && it.turnId ? groups.get(it.turnId) : undefined;
    if (group) {
      const key = toolGroupKey(it.turnId!);
      const open = expanded.has(key);
      // One row per turn, drawn at its first call; the rest of the turn's
      // calls are already accounted for by it.
      if (group[0] !== it) {
        if (!open) continue;
        const start = lines.length;
        lines.push(...renderItem(it, opts));
        itemStarts.push({ id: it.id, start, end: lines.length });
        toggles.set(start, it.id);
        continue;
      }
      const start = lines.length;
      lines.push(...renderToolGroupHead(group, open, opts));
      toggles.set(start, key);
      itemStarts.push({ id: key, start, end: lines.length });
      if (open) {
        const from = lines.length;
        lines.push(...renderItem(it, opts));
        itemStarts.push({ id: it.id, start: from, end: lines.length });
        toggles.set(from, it.id);
      }
      continue;
    }
    const start = lines.length;
    lines.push(...renderItem(it, opts));
    itemStarts.push({ id: it.id, start, end: lines.length });
    if (it.kind === "tool" || it.kind === "thinking") toggles.set(start, it.id);
  }
  return { lines, itemStarts, toggles };
}

export function Transcript({ view, layout, height, scrollFromBottom, width, selection }: { view: ThreadView | null; layout: TranscriptLayout; height: number; scrollFromBottom: number; width: number; selection: Selection | null }) {
  const { lines } = layout;
  const visible = useMemo(() => {
    const end = Math.max(0, lines.length - scrollFromBottom);
    const start = Math.max(0, end - height);
    return { slice: lines.slice(start, end), start, end };
  }, [lines, height, scrollFromBottom]);
  const painted = useMemo(() => applySelection(visible.slice, visible.start, selection, "transcript"), [visible, selection]);

  if (!view) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text color={T.subtle}>Select a thread, or press </Text>
        <Text color={T.subtle}><Text color={T.accent}>n</Text> in the sidebar to start one</Text>
      </Box>
    );
  }
  if (view.loading && lines.length === 0) return <Box flexGrow={1} paddingX={2}><Text color={T.subtle}>loading…</Text></Box>;
  if (view.error) return <Box flexGrow={1} paddingX={2}><Text color={T.danger}>{view.error}</Text></Box>;
  if (lines.length === 0) {
    return <Box flexGrow={1} paddingX={2} paddingTop={1}><Text color={T.subtle} italic>Empty thread. Type a message below.</Text></Box>;
  }
  const pad = Math.max(0, height - visible.slice.length);
  return (
    <Box flexDirection="column" flexGrow={1} width={width} overflow="hidden">
      {pad > 0 && <Box height={pad} />}
      {painted.map((l, i) => <LineView key={visible.start + i} line={l} />)}
      {scrollFromBottom > 0 && (
        <Box position="absolute" marginTop={height - 1} marginLeft={Math.max(0, Math.floor(width / 2) - 10)}>
          <Text color={T.text} backgroundColor={T.surfaceAlt}> ↓ {scrollFromBottom} lines below  (G) </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Whether to write OSC 8 hyperlinks. Read once: it is an escape hatch for a
 * terminal that mangles them, not a setting that changes while running.
 */
const HYPERLINKS = hyperlinksEnabled();

const LineView = React.memo(function LineView({ line }: { line: Line }) {
  if (line.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        // The OSC 8 pair goes inside the <Text>, not around it. Ink measures
        // with `string-width`, which gives the sequence a width of zero, so the
        // layout is the same as it would be for the bare text. Verified
        // against ink 7.1.1.
        <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>{s.link && HYPERLINKS ? osc8(s.link, s.text) : s.text}</Text>
      ))}
    </Text>
  );
});
