import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { DEFAULT_LOD, type Lod, type TimelineItem } from "@covey/protocol";
import { timelineRows } from "@covey/client";
import { selectionBounds, type Selection, type ThreadView } from "../store.js";
import { ItemLines, renderItem, renderChainHead, renderSaidHead, highlightLine, colToIndex, lineText, type Line, type QuestionUi } from "../lines.js";
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
    return highlightLine(l, a, b, T.selectionBg, T.selectionText);
  });
}

export interface TranscriptLayout {
  lines: Line[];
  itemStarts: { id: string; start: number; end: number }[];
  /** Line index → the id a click on that line folds or unfolds. */
  toggles: Map<number, string>;
}

/** Nothing at all, for a layout with no thread open. */
const EMPTY_ITEMS: Map<string, TimelineItem> = new Map();

/**
 * Lay the transcript out at one level of detail (#149).
 *
 * `timelineRows` in `@covey/client` decides what folds into what; this turns
 * each row it gives back into painted lines. The web client reads the same
 * function, so a chain starts and ends in the same place on a phone.
 *
 * `toggled` holds the rows the reader changed from what the level gives them.
 * It is a toggle rather than a list of open rows, because at `full` a tap
 * shuts a row instead of opening one.
 *
 * `links` marks the paths and the URLs. It is the caller's job because whether
 * a path is openable depends on which machine the thread runs on.
 *
 * `cache` holds the lines of the items that did not change, which is all but
 * one of them whenever a reply is streaming. Leave it out and every item is
 * laid out afresh — which is what a test wants, and what the first layout of a
 * thread does anyway.
 */
export function layoutTranscript(view: ThreadView | null, width: number, toggled: Set<string>, question: QuestionUi = { cursor: 0, answered: [] }, lod: Lod = DEFAULT_LOD, links?: LinkContext, cache?: ItemLines): TranscriptLayout {
  const lines: Line[] = [];
  const itemStarts: TranscriptLayout["itemStarts"] = [];
  const toggles = new Map<number, string>();
  // Before the `!view` guard, not after it: a reader leaving a thread is the
  // case `prune` exists for, and `state.view` is null the moment they do.
  cache?.prune(view?.items ?? EMPTY_ITEMS);
  if (!view) return { lines, itemStarts, toggles };
  const items = [...view.items.values()].sort((a, b) => a.seq - b.seq);

  for (const row of timelineRows(items, { lod, toggled })) {
    const start = lines.length;
    if (row.kind === "chain") {
      lines.push(...renderChainHead(row, { width, links }));
      toggles.set(start, row.key);
      itemStarts.push({ id: row.key, start, end: lines.length });
      continue;
    }
    if (row.kind === "said") {
      lines.push(...renderSaidHead(row, { width }));
      toggles.set(start, row.key);
      itemStarts.push({ id: row.key, start, end: lines.length });
      continue;
    }
    // `expanded` carries one id and `renderItem` asks whether it holds this
    // one, so the fold above stays the only thing that decides what is open.
    const opts = { width, expanded: row.open ? new Set([row.item.id]) : EMPTY_EXPANDED, question, links };
    lines.push(...(cache ? cache.render(row.item, opts) : renderItem(row.item, opts)));
    itemStarts.push({ id: row.item.id, start, end: lines.length });
    if (row.item.kind === "tool" || row.item.kind === "thinking") toggles.set(start, row.item.id);
  }
  return { lines, itemStarts, toggles };
}

/** Shared by every folded row, so no set is built for one that is shut. */
const EMPTY_EXPANDED: Set<string> = new Set();

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
    /* `100%`, not `width`: this box clips, and a clip is the innermost one that
       wins. Sized off the prop it would go on clipping at the old width through
       a resize, over the top of the bound App's root box sets. */
    <Box flexDirection="column" flexGrow={1} width="100%" overflow="hidden">
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
