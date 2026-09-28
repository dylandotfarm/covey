/**
 * One row of a transcript (issue #168).
 *
 * The fold is not decided here. `timelineRows` in `@covey/client` decides it —
 * pure, node-tested, and read by the TUI, the web client and this one — so a
 * chain starts and ends in the same place on a phone's browser and in a phone's
 * app (#149). This file paints what that function returned and nothing more.
 *
 * Two rules from the rest of covey are load-bearing here:
 *
 *  - **No two rows share a key.** A chain's key is `chain:<id>` and never its
 *    head item's own id, or one tap opens both. `TimelineRow.key` already
 *    carries the right one; never substitute `item.id`.
 *  - **A row is rebuilt only when it changed.** `rowSignature` is that test, and
 *    the memo below uses it. A paint runs on every frame of a turn, and a row
 *    rebuilt under a finger loses the tap.
 */
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { chainLabel, type TimelineRow } from "@covey/client";
import { attachmentKind, relTime, rowSignature } from "@covey/web";
import { questionAnswers, questionAsks, type ApprovalItem, type Attachment, type QuestionItem, type TimelineItem } from "@covey/protocol";
import { MONO, SIZE, T, TONE } from "../theme";
import { Markdown, type MarkdownContext } from "./Markdown";

/** What a row needs from the thread screen. */
export interface RowContext extends MarkdownContext {
  /** Open or shut a foldable row. The key is the row's own. */
  onToggle: (key: string) => void;
  onApproval: (item: ApprovalItem, behavior: "allow" | "deny", always: boolean) => void;
  onQuestion: (item: QuestionItem, answers: string[]) => void;
  /** A file in the thread's own store, as a URL this device can load. */
  fileSrc: (path: string) => string;
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: 14, paddingVertical: 5 },
  user: {
    alignSelf: "flex-end", maxWidth: "88%", backgroundColor: T.userBg,
    borderRadius: 14, borderBottomRightRadius: 4, paddingHorizontal: 12, paddingVertical: 9,
  },
  system: {
    alignSelf: "stretch", borderLeftWidth: 3, borderLeftColor: T.awaiting,
    paddingLeft: 10, paddingVertical: 4, backgroundColor: T.surface, borderRadius: 6,
  },
  fold: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: T.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
  },
  label: { color: T.muted, fontSize: SIZE.small, flex: 1 },
  tool: { backgroundColor: T.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 4 },
  toolName: { fontFamily: MONO, fontSize: 12.5, color: T.muted },
  output: { fontFamily: MONO, fontSize: 11.5, color: T.subtle, backgroundColor: T.surfaceAlt, borderRadius: 6, padding: 8 },
  note: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 6 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    backgroundColor: T.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
  },
  option: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.accent, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 9, marginTop: 6,
  },
  act: { flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" },
});

/** A button inside a row: an approval, an answer. */
function Act({ label, onPress, tone }: { label: string; onPress: () => void; tone: "allow" | "deny" | "plain" }) {
  const colour = tone === "allow" ? T.success : tone === "deny" ? T.danger : T.surfaceAlt;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: T.surfaceAlt }}
      style={{ backgroundColor: colour, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
    >
      <Text style={{ color: tone === "plain" ? T.text : "#ffffff", fontSize: SIZE.small, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** The files on a message or a note, as chips and pictures. */
function Files({ files, ctx }: { files: Attachment[]; ctx: RowContext }) {
  return (
    <View style={{ gap: 6 }}>
      {files.map((f, i) => {
        const kind = attachmentKind(f);
        const src = ctx.fileSrc(f.name);
        if (kind === "image" || kind === "video") {
          // An agent showing its own work paints inline, the same way a reader's
          // own drop does (#160). A tap opens the route.
          return (
            <Pressable key={i} onPress={ctx.onMedia ? () => ctx.onMedia!(src, f.name) : undefined}>
              <Image source={{ uri: src }} style={{ width: "100%", height: 200, borderRadius: 8, backgroundColor: T.surfaceAlt }} contentFit="contain" />
              <Text style={{ color: T.subtle, fontSize: 11, marginTop: 2 }}>{f.name}{kind === "video" ? " · tap to play" : ""}</Text>
            </Pressable>
          );
        }
        return (
          <View key={i} style={st.chip}>
            <Text style={{ color: T.muted, fontSize: SIZE.small }}>📄 {f.name}</Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * One to four questions, and the answers to them.
 *
 * The web client's own rules, kept exactly: a single question with options is
 * answered by the tap, and anything else — several questions, or one with no
 * options — waits for the send, because a half-answered set must not go.
 *
 * The answers live in this component and not in the store. They are not state a
 * daemon has any business in until they are sent, and a keystroke here must not
 * cost a frame anywhere else.
 */
function QuestionCard({ item, ctx }: { item: QuestionItem; ctx: RowContext }) {
  const asks = questionAsks(item);
  const given = questionAnswers(item);
  const pending = item.status === "pending";
  const [answers, setAnswers] = useState<string[]>(() => asks.map((_, i) => given[i] ?? ""));

  const put = (i: number, value: string) => setAnswers((prev) => {
    const next = [...prev];
    next[i] = value;
    return next;
  });

  const send = (all: string[]) => { if (all.every(Boolean)) ctx.onQuestion(item, all); };

  return (
    <View style={[st.tool, { borderWidth: StyleSheet.hairlineWidth, borderColor: pending ? T.accent : T.border }]}>
      {asks.map((ask, i) => (
        <View key={i} style={{ gap: 4, marginBottom: 6 }}>
          {ask.header ? <Text style={{ color: T.accent, fontSize: 10 }}>{ask.header}</Text> : null}
          {/* Verbatim. The CLI keys the answer by this exact string. */}
          <Text style={{ color: T.text, fontSize: SIZE.body }}>{ask.question}</Text>
          {!pending ? (
            <Text style={{ color: T.muted, fontSize: SIZE.small }}>{given[i] ?? "—"}</Text>
          ) : (
            <>
              {(ask.options ?? []).map((o, j) => {
                const chosen = answers[i] === o.label;
                return (
                  <Pressable
                    key={j}
                    style={[st.option, chosen ? { backgroundColor: T.accentDim } : null]}
                    onPress={() => {
                      const next = [...answers];
                      next[i] = o.label;
                      setAnswers(next);
                      // One question with options answers on the tap. More than
                      // one waits for the send.
                      if (asks.length === 1) send(next);
                    }}
                  >
                    <Text style={{ color: T.text, fontSize: SIZE.body }}>{o.label}</Text>
                    {o.description ? <Text style={{ color: T.subtle, fontSize: SIZE.small }}>{o.description}</Text> : null}
                  </Pressable>
                );
              })}
              <TextInput
                placeholder={ask.options ? "Or type an answer" : "Your answer"}
                placeholderTextColor={T.faint}
                value={answers[i] ?? ""}
                onChangeText={(t) => put(i, t)}
                style={{ color: T.text, fontSize: SIZE.body, backgroundColor: T.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 4 }}
              />
            </>
          )}
        </View>
      ))}
      {pending && (asks.length > 1 || asks.every((x) => !x.options)) ? (
        <View style={st.act}>
          <Act label="Answer" tone="allow" onPress={() => send(answers)} />
        </View>
      ) : null}
    </View>
  );
}

function ItemView({ item, open, ctx, onToggle, rowKey }: {
  item: TimelineItem; open: boolean; ctx: RowContext; onToggle: () => void; rowKey: string;
}) {
  switch (item.kind) {
    case "user":
      // A message covey wrote itself is its own kind of block, with a rail, on
      // the left; the reader's own go to the right edge. The same split the TUI
      // makes, for the same reason: a reader must tell the two apart at a glance.
      return item.system ? (
        <View style={st.system}>
          <Text style={{ color: T.awaiting, fontSize: 10, marginBottom: 2 }}>covey</Text>
          <Markdown text={item.text} ctx={ctx} />
        </View>
      ) : (
        <View style={st.user}>
          <Text style={{ color: T.text, fontSize: SIZE.body }}>{item.text}</Text>
          {item.attachments?.length ? <View style={{ marginTop: 6 }}><Files files={item.attachments} ctx={ctx} /></View> : null}
          {item.queued ? <Text style={{ color: T.subtle, fontSize: 10, marginTop: 3 }}>queued</Text> : null}
        </View>
      );

    case "assistant":
      return <Markdown text={item.text} ctx={ctx} />;

    case "thinking":
      // A thought folds away and its text is never sent to the summariser, but
      // a reader who opened the row asked to read it.
      return (
        <Pressable onPress={onToggle} style={st.fold}>
          <Text style={{ color: T.subtle, fontSize: SIZE.small, flex: 1, fontStyle: "italic" }} numberOfLines={open ? undefined : 1}>
            {open ? item.text : "thought"}
          </Text>
        </Pressable>
      );

    case "tool":
      return (
        <Pressable onPress={onToggle} style={st.tool}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: item.status === "error" || item.isError ? T.danger : item.status === "running" ? T.working : T.faint }} />
            <Text style={[st.toolName, { flex: 1 }]} numberOfLines={open ? undefined : 1}>{item.summary || item.toolName}</Text>
            {item.durationMs !== null ? <Text style={{ color: T.faint, fontSize: 10 }}>{Math.round(item.durationMs / 100) / 10}s</Text> : null}
          </View>
          {item.background?.state === "running" ? <Text style={{ color: T.working, fontSize: 10 }}>running in the background</Text> : null}
          {open ? (
            <>
              <Text style={st.output} selectable>{JSON.stringify(item.input, null, 1)}</Text>
              {item.output ? <Text style={st.output} selectable numberOfLines={40}>{item.output}</Text> : null}
            </>
          ) : null}
        </Pressable>
      );

    case "approval":
      return (
        <View style={[st.tool, { borderWidth: StyleSheet.hairlineWidth, borderColor: T.awaiting }]}>
          <Text style={{ color: T.awaiting, fontSize: SIZE.small, fontWeight: "600" }}>{item.toolName} wants permission</Text>
          <Text style={st.toolName} numberOfLines={6}>{item.summary ?? JSON.stringify(item.input)}</Text>
          <View style={st.act}>
            <Act label="Allow" tone="allow" onPress={() => ctx.onApproval(item, "allow", false)} />
            {item.suggestions?.length ? <Act label="Always allow" tone="allow" onPress={() => ctx.onApproval(item, "allow", true)} /> : null}
            <Act label="Deny" tone="deny" onPress={() => ctx.onApproval(item, "deny", false)} />
          </View>
        </View>
      );

    case "question":
      return <QuestionCard item={item} ctx={ctx} />;

    case "note":
      // A note carries no chain, so a picture never folds away into a chain row.
      return (
        <View style={[st.note, { backgroundColor: item.tone === "warning" ? "#2a2113" : T.surface }]}>
          <Text style={{ color: item.tone === "warning" ? T.warning : T.muted, fontSize: SIZE.small }}>{item.text}</Text>
          {item.files?.length ? <Files files={item.files} ctx={ctx} /> : null}
        </View>
      );

    case "error":
      return (
        <View style={[st.note, { borderWidth: StyleSheet.hairlineWidth, borderColor: T.danger }]}>
          <Text style={{ color: T.danger, fontSize: SIZE.small }} selectable>{item.text}</Text>
        </View>
      );
  }
}

function RowBody({ row, ctx }: { row: TimelineRow; ctx: RowContext }) {
  if (row.kind === "chain") {
    // Until the model's sentence lands, and for good when it is off, the client
    // counts the calls rather than reading them.
    const label = row.label || chainLabel(row.items);
    return (
      <View style={{ gap: 4 }}>
        <Pressable onPress={() => ctx.onToggle(row.key)} style={st.fold}>
          <Text style={{ color: T.faint, fontSize: 11 }}>{row.open ? "▾" : "▸"}</Text>
          <Text style={st.label} numberOfLines={row.open ? undefined : 2}>{label}</Text>
          {row.failed > 0 ? <Text style={{ color: T.danger, fontSize: 10 }}>{row.failed} failed</Text> : null}
          {row.running > 0 ? <Text style={{ color: T.working, fontSize: 10 }}>{row.running} running</Text> : null}
          {row.durationMs !== null ? <Text style={{ color: T.faint, fontSize: 10 }}>{Math.round(row.durationMs / 1000)}s</Text> : null}
        </Pressable>
        {row.open ? (
          <View style={{ gap: 4, paddingLeft: 10 }}>
            {row.items.map((it) => (
              <ItemView key={it.id} item={it} open={false} ctx={ctx} rowKey={row.key} onToggle={() => ctx.onToggle(row.key)} />
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  if (row.kind === "said") {
    return (
      <View style={{ gap: 4 }}>
        <Pressable onPress={() => ctx.onToggle(row.key)} style={st.fold}>
          <Text style={{ color: T.faint, fontSize: 11 }}>{row.open ? "▾" : "▸"}</Text>
          <Text style={st.label}>{row.open ? "said" : `said ${row.items.length} more thing${row.items.length === 1 ? "" : "s"}`}</Text>
        </Pressable>
        {row.open ? (
          <View style={{ gap: 6, paddingLeft: 10 }}>
            {row.items.map((it) => <ItemView key={it.id} item={it} open ctx={ctx} rowKey={row.key} onToggle={() => ctx.onToggle(row.key)} />)}
          </View>
        ) : null}
      </View>
    );
  }
  return <ItemView item={row.item} open={row.open} ctx={ctx} rowKey={row.key} onToggle={() => ctx.onToggle(row.key)} />;
}

/**
 * One row, rebuilt only when it changed.
 *
 * `rowSignature` is the same test the web client's renderer uses, and it cannot
 * be item identity: a chain row says how many calls ran, how long they took and
 * how many failed, so it changes when any item under it does.
 */
export const TimelineRowView = memo(
  function TimelineRowView({ row, ctx }: { row: TimelineRow; ctx: RowContext }) {
    return <View style={st.wrap}><RowBody row={row} ctx={ctx} /></View>;
  },
  (a, b) => a.ctx === b.ctx && rowSignature(a.row) === rowSignature(b.row),
);

/** The time under the last row of a turn, refreshed by the clock and nothing else. */
export function RowTime({ iso }: { iso: string }) {
  return <Text style={{ color: T.faint, fontSize: 10, paddingHorizontal: 16, paddingBottom: 4 }}>{relTime(iso)}</Text>;
}
