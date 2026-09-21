import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AppState, Selection } from "../store.js";
import { type Line } from "../lines.js";
import { applySelection } from "./Transcript.js";
import { T } from "../theme.js";

export function DiffPanel({ view, width, height, lines, selection }: { view: NonNullable<AppState["diffView"]>; width: number; height: number; lines: Line[]; selection: Selection | null }) {
  if (view.loading) return <Box paddingX={2}><Text color={T.subtle}>computing diff…</Text></Box>;
  if (!view.diff) return <Box paddingX={2} paddingTop={1}><Text color={T.subtle} italic>No diff for this thread yet. Diffs are captured per turn in git repositories.</Text></Box>;
  const bodyH = Math.max(1, height - 2);
  const maxScroll = Math.max(0, lines.length - bodyH);
  const start = Math.min(view.scroll, maxScroll);
  const d = view.diff;
  return (
    /* `100%`, not `width`: see the root box in `App.tsx`. */
    <Box flexDirection="column" width="100%" height={height} paddingX={1}>
      <Box height={1}>
        <Text color={T.text} bold>Changes </Text>
        <Text color={T.success}>+{d.additions} </Text>
        <Text color={T.danger}>−{d.deletions} </Text>
        <Text color={T.subtle}>in {d.files.length} file{d.files.length === 1 ? "" : "s"}</Text>
        {maxScroll > 0 && <Text color={T.faint}>   {start}/{maxScroll}</Text>}
      </Box>
      <Box height={1}><Text color={T.faint} wrap="truncate">{d.files.map((f) => `${f.status} ${f.path}`).join("   ")}</Text></Box>
      {applySelection(lines.slice(start, start + bodyH), start, selection, "diff").map((l, i) => (
        <Text key={start + i} wrap="truncate">{l.length === 0 ? " " : l.map((s, j) => <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold} italic={s.italic}>{s.text}</Text>)}</Text>
      ))}
    </Box>
  );
}
