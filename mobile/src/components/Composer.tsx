/**
 * The composer (issue #168).
 *
 * The draft lives here and not in the store. A render per keystroke is what the
 * frame budget cannot afford — the same reason the page's `setDraft` repaints
 * only when the number of chips changed — so the text is this component's state
 * and the store is written to without a notify.
 *
 * A chip is the word in the draft as well, and deleting either drops the file.
 * The cut is `tagSpanAt` and `cutTag` from `@covey/client`, which is where the
 * TUI's rule lives: a chip is one key to delete, not one key per character. The
 * strip exists because a thumb cannot put a caret inside `[shot.png]`.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { cutTag, spliceTags, tagSpanAt } from "@covey/client";
import { SIZE, T } from "../theme";
import { Spinner } from "../ui";
import { pickCamera, pickDocument, pickMedia, type DeviceFile } from "../attach";

const st = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border, backgroundColor: T.surface },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: T.surfaceAlt, borderRadius: 999, paddingLeft: 10, paddingRight: 6, paddingVertical: 4,
  },
  chipFailed: { borderWidth: StyleSheet.hairlineWidth, borderColor: T.danger },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  input: {
    flex: 1, color: T.text, fontSize: SIZE.body, backgroundColor: T.surfaceAlt,
    borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, maxHeight: 140,
  },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: T.surfaceAlt },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: T.accent },
  stop: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: T.danger },
});

export interface ComposerProps {
  machine: string;
  threadId: string;
  /** The draft as the store last saw it, read once when the thread opens. */
  initial: string;
  /** The tags of the files waiting to go, deduplicated and in order. */
  tags: { tag: string; name: string; failed?: boolean }[];
  /** What the composer says while it reads or sends files. */
  attaching: string | null;
  busy: boolean;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** Read the picked files and answer with the tags that are new. */
  onAttach: (files: DeviceFile[], draft: string) => Promise<string[] | null>;
}

export function Composer(p: ComposerProps) {
  const [text, setText] = useState(p.initial);
  /** Where the caret is, so a tag lands where the reader was typing. */
  const caret = useRef(p.initial.length);
  const [picking, setPicking] = useState(false);

  // A different thread is a different draft. Without this, opening a second
  // conversation would show the first one's half-written message.
  const key = `${p.machine}\n${p.threadId}`;
  const shown = useRef(key);
  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    setText(p.initial);
    caret.current = p.initial.length;
  }, [key, p.initial]);

  const change = (next: string) => {
    setText(next);
    p.onDraft(next);
  };

  const send = () => {
    const out = text.trim();
    if (!out) return;
    // Clear first: the send is a command over a socket and the reader should not
    // be left looking at a message that has already gone.
    setText("");
    caret.current = 0;
    p.onSend(out);
  };

  /** Drop the file a chip stands for, by cutting its word out of the draft. */
  const cutChip = (tag: string) => {
    const at = text.indexOf(tag);
    if (at < 0) return;
    const span = tagSpanAt(text, at + tag.length, [tag], true);
    if (!span) return;
    const cut = cutTag(text, span);
    caret.current = cut.caret;
    change(cut.value);
  };

  const attach = async (pick: () => Promise<DeviceFile[]>) => {
    setPicking(true);
    try {
      const files = await pick();
      if (!files.length) return;
      const tags = await p.onAttach(files, text);
      if (!tags?.length) return;
      // The caret belongs to this component, so the tags are put in here. The
      // store only works out what they must be unique against.
      const put = spliceTags(text, caret.current, tags);
      caret.current = put.caret;
      change(put.value);
    } finally {
      setPicking(false);
    }
  };

  return (
    <View style={st.wrap}>
      {p.attaching || p.tags.length ? (
        <View style={st.strip}>
          {p.attaching ? (
            <View style={[st.chip, { gap: 8 }]}>
              <Spinner />
              <Text style={{ color: T.muted, fontSize: SIZE.small }}>{p.attaching}</Text>
            </View>
          ) : null}
          {p.tags.map((t) => (
            <View key={t.tag} style={[st.chip, t.failed ? st.chipFailed : null]}>
              <Text style={{ color: t.failed ? T.danger : T.muted, fontSize: SIZE.small }} numberOfLines={1}>
                {t.tag.slice(1, -1)}
              </Text>
              <Pressable
                onPress={() => cutChip(t.tag)}
                accessibilityLabel={`Remove ${t.name}`}
                hitSlop={8}
                style={{ paddingHorizontal: 4 }}
              >
                <Text style={{ color: T.subtle, fontSize: 15 }}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={st.row}>
        <Pressable style={st.icon} onPress={() => void attach(pickMedia)} disabled={picking} accessibilityLabel="Attach a photo or a video">
          <Text style={{ color: T.muted, fontSize: 17 }}>🖼</Text>
        </Pressable>
        <Pressable style={st.icon} onPress={() => void attach(pickCamera)} disabled={picking} accessibilityLabel="Take a photo">
          <Text style={{ color: T.muted, fontSize: 17 }}>📷</Text>
        </Pressable>
        <Pressable style={st.icon} onPress={() => void attach(pickDocument)} disabled={picking} accessibilityLabel="Attach a file">
          <Text style={{ color: T.muted, fontSize: 17 }}>📎</Text>
        </Pressable>

        <TextInput
          style={st.input}
          value={text}
          onChangeText={change}
          onSelectionChange={(e) => { caret.current = e.nativeEvent.selection.end; }}
          placeholder="Message"
          placeholderTextColor={T.faint}
          multiline
          // Never `blurOnSubmit`: a newline inside a message is a newline, and
          // the send is a button. A phone keyboard's return key is not enter.
          returnKeyType="default"
        />

        {p.busy ? (
          <Pressable style={st.stop} onPress={p.onInterrupt} accessibilityLabel="Interrupt the turn">
            <Text style={{ color: "#ffffff", fontSize: 15 }}>■</Text>
          </Pressable>
        ) : (
          <Pressable style={[st.send, { opacity: text.trim() ? 1 : 0.4 }]} onPress={send} disabled={!text.trim()} accessibilityLabel="Send">
            <Text style={{ color: "#ffffff", fontSize: 17 }}>↑</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
