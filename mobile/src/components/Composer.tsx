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
  menu: {
    alignSelf: "flex-start", backgroundColor: T.surfaceAlt, borderRadius: 10,
    marginTop: 8, marginBottom: 2, overflow: "hidden", minWidth: 180,
  },
  menuRow: { paddingHorizontal: 14, paddingVertical: 11 },
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
  /** What a display cutout takes at the sides. A camera punch is inside the
   *  drawable area on Android 15 and later — see `useContentInsets`. */
  leftInset?: number;
  rightInset?: number;
  /**
   * The cover screen of a closed foldable, where the camera is in the corner
   * and the device does not admit it.
   *
   * On a Motorola Razr the lenses sit in the bottom right of the cover display
   * and `WindowInsets` reports nothing about them: the panel declares its whole
   * rectangle usable, so `insets.right` and `insets.bottom` come back as zero
   * and a control laid out to that corner ends up under a lens. Insets are
   * still preferred when the device does report them — this only decides what
   * to do when it does not.
   *
   * So on this screen the controls move to the *left*, where nothing is, and
   * the row keeps a corner clear on the right.
   */
  compact?: boolean;
  /**
   * What the gesture bar takes at the bottom of the screen.
   *
   * An edge-to-edge app draws under the navigation bar, so without this the home
   * bar sits on top of the composer. The screen passes 0 while the keyboard is
   * up, because the keyboard covers the gesture bar and the padding would
   * otherwise be a gap.
   */
  bottomInset?: number;
}

export function Composer(p: ComposerProps) {
  const [text, setText] = useState(p.initial);
  /** Where the caret is, so a tag lands where the reader was typing. */
  const caret = useRef(p.initial.length);
  const [picking, setPicking] = useState(false);
  /** The attach menu, open only while the reader is choosing. */
  const [menu, setMenu] = useState(false);

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

  /**
   * The corner to keep clear at the bottom right, in points.
   *
   * The inset when the device reports one, and otherwise a square the size of a
   * control — which is the smallest reserve that can hold a button, and so the
   * smallest that makes the corner safe to lay out around. It is a guess about
   * *how big*, never about *where*: every foldable puts its cover camera in a
   * corner, and this reserves that corner rather than a column of the screen.
   */
  const corner = p.compact ? Math.max(p.rightInset ?? 0, 56) : (p.rightInset ?? 0);

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
    setMenu(false);
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

  // Built once and placed on whichever side this screen wants them.
  const buttons = (
    <>
      {p.busy ? (
        <Pressable style={st.stop} onPress={p.onInterrupt} accessibilityLabel="Interrupt the turn">
          <Text style={{ color: "#ffffff", fontSize: 15 }}>■</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={[st.send, { opacity: text.trim() ? 1 : 0.4 }]}
        onPress={send}
        disabled={!text.trim()}
        accessibilityLabel={p.busy ? "Send, and covey answers it after this turn" : "Send"}
      >
        <Text style={{ color: "#ffffff", fontSize: 17 }}>↑</Text>
      </Pressable>
    </>
  );

  return (
    <View style={st.wrap}>
      {p.attaching || p.tags.length ? (
        <View style={[st.strip, { paddingLeft: 12 + (p.leftInset ?? 0), paddingRight: 12 + (p.rightInset ?? 0) }]}>
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

      {menu ? (
        <View style={[st.menu, { marginLeft: 10 + (p.leftInset ?? 0) }]}>
          {([
            ["Photo or video", pickMedia],
            ["Camera", pickCamera],
            ["File", pickDocument],
          ] as const).map(([label, pick], i) => (
            <Pressable
              key={label}
              onPress={() => void attach(pick)}
              android_ripple={{ color: T.surfaceAlt }}
              style={[st.menuRow, i === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border }]}
            >
              <Text style={{ color: T.text, fontSize: SIZE.body }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={[st.row, {
        // On a cover screen the row lifts clear of the bottom edge as well:
        // the lenses take a corner, not a line, so height bought here is height
        // the text box is not in.
        paddingBottom: (p.compact ? 14 : 8) + (p.bottomInset ?? 0),
        paddingLeft: 10 + (p.leftInset ?? 0),
        paddingRight: 10 + corner,
      }]}>
        {/*
          One button, not three. Three lived on the composer of every
          conversation to offer a choice a reader makes rarely, and each of them
          cost width on the screen with least — the same trade the detail row
          lost. The choice moves into a menu that is only there while it is
          being made.
        */}
        <Pressable
          style={st.icon}
          onPress={() => setMenu((open) => !open)}
          disabled={picking}
          accessibilityLabel={menu ? "Close the attach menu" : "Attach a photo, a picture or a file"}
        >
          <Text style={{ color: menu ? T.accent : T.muted, fontSize: 21, lineHeight: 24 }}>{menu ? "×" : "＋"}</Text>
        </Pressable>
        {/* On a cover screen these sit on the left, away from the lenses. */}
        {p.compact ? buttons : null}

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

        {/*
          Both, never one instead of the other.

          A running turn is not a reason to refuse a message: the daemon queues
          one, or hands it to the turn already running, which is what
          `Thread.queuedTurns` and `UserMessageItem.folded` are for. Swapping
          send for stop made the reader interrupt covey to say anything to it —
          and the web client has always shown both, hiding only the stop.
        */}
        {p.compact ? null : buttons}
      </View>
    </View>
  );
}
