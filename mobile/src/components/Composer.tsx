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
import { useDictation } from "../dictation";
import { Icon } from "../Icon";

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
  menuRow: { paddingHorizontal: 16, paddingVertical: 14 },
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

  /**
   * What the draft was when dictation started.
   *
   * The recogniser revises the utterance as it hears more of it, so each result
   * *replaces* the last one rather than adding to it. Without this the reader
   * would watch their sentence written three times over.
   */
  const spokenFrom = useRef<string | null>(null);
  const dictation = useDictation((spoken, final) => {
    const base = spokenFrom.current ?? text;
    if (spokenFrom.current === null) spokenFrom.current = base;
    const joined = base && !base.endsWith(" ") ? `${base} ${spoken}` : `${base}${spoken}`;
    caret.current = joined.length;
    change(joined);
    // The next utterance starts from what this one left.
    if (final) spokenFrom.current = joined;
  });


  /**
   * The controls are bigger on a cover screen, not smaller.
   *
   * It is the screen most often used one-handed, at arm's length, on a device
   * being held shut — and the one where a missed tap costs the most, because
   * there is no room for a second try beside the first. The row of buttons
   * moved off the message box precisely so both could have the space.
   */
  const big = Boolean(p.compact);
  const control = big ? { width: 52, height: 52, borderRadius: 26 } : null;

  /**
   * Hold to talk, release to stop.
   *
   * A press that toggles is a microphone left on: the reader speaks, the phone
   * goes into a pocket, and nothing says it is still listening. Holding puts the
   * length of the recording into the gesture, which is what every other
   * push-to-talk does and what a thumb already expects.
   */
  const mic = (
    <Pressable
      style={[st.icon, control, dictation.listening ? { backgroundColor: T.danger } : null]}
      onPressIn={() => { spokenFrom.current = null; void dictation.start(); }}
      onPressOut={() => dictation.stop()}
      // The hold *is* the gesture, so Android must not also read it as a long press.
      delayLongPress={100000}
      accessibilityLabel="Hold to dictate a message"
      accessibilityHint="Hold this button and speak. Let go when you have finished."
    >
      <Icon name={dictation.listening ? "micOff" : "mic"} size={big ? 26 : 20} colour={dictation.listening ? "#ffffff" : T.muted} />
    </Pressable>
  );

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

  const stopButton = p.busy ? (
    <Pressable style={[st.stop, control]} onPress={p.onInterrupt} accessibilityLabel="Interrupt the turn">
      <Icon name="stop" size={big ? 24 : 18} colour="#ffffff" />
    </Pressable>
  ) : null;

  const sendButton = (
    <Pressable
      style={[st.send, control, { opacity: text.trim() ? 1 : 0.4 }]}
      onPress={send}
      disabled={!text.trim()}
      accessibilityLabel={p.busy ? "Send, and covey answers it after this turn" : "Send"}
    >
      <Icon name="send" size={big ? 26 : 20} colour="#ffffff" />
    </Pressable>
  );

  /**
   * On any screen but the cover one these keep their usual place, on the right.
   *
   * The microphone is among them. An open phone has a keyboard with a
   * microphone key of its own, but covey's is push-to-talk and one tap nearer —
   * and a reader who learns the gesture on the cover screen should find it on
   * the other one rather than discover it was a small-screen affordance.
   */
  const buttons = <>{dictation.available ? mic : null}{stopButton}{sendButton}</>;

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
                <Icon name="close" size={15} colour={T.subtle} />
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

      {dictation.error ? (
        <Pressable onPress={dictation.clearError} style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
          <Text style={{ color: T.danger, fontSize: SIZE.small }}>{dictation.error}</Text>
        </Pressable>
      ) : null}

      {p.compact ? (
        /*
          The cover screen, two rows.

          The message box wants the width of the screen, and three controls
          beside it leave it a third of one. So the box takes a row with the
          microphone — the one control that is worth reaching for when there is
          no room to type — and the rest go underneath, on the left, away from
          the lenses.
        */
        <View style={{ paddingLeft: 10 + (p.leftInset ?? 0), paddingRight: 10 + corner, paddingBottom: 14 + (p.bottomInset ?? 0), gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <TextInput
              // Three lines, because the controls left this row and the space
              // they took is space a message can use. A dictated sentence in
              // particular is longer than one typed on a screen this size.
              style={[st.input, { minHeight: 84, maxHeight: 132, borderRadius: 20 }]}
              value={text}
              onChangeText={change}
              onSelectionChange={(e) => { caret.current = e.nativeEvent.selection.end; }}
              placeholder={dictation.listening ? "Listening…" : "Message"}
              placeholderTextColor={T.faint}
              multiline
              returnKeyType="default"
            />
            {/*
              Speak or send, both beside the box they act on. They are the two
              things a reader reaches for having written something, so they sit
              together and at the end of the writing rather than under it.
            */}
            {dictation.available ? mic : null}
            {sendButton}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              style={[st.icon, control]}
              onPress={() => setMenu((open) => !open)}
              disabled={picking}
              accessibilityLabel={menu ? "Close the attach menu" : "Attach a photo, a picture or a file"}
            >
              <Icon name={menu ? "close" : "attach"} size={big ? 28 : 22} colour={menu ? T.accent : T.muted} />
            </Pressable>
            {/* Stop is not a writing control: it stays on the row below, and is
                there only while there is a turn to stop. */}
            {stopButton}
          </View>
        </View>
      ) : (
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
          <Icon name={menu ? "close" : "attach"} size={22} colour={menu ? T.accent : T.muted} />
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

        {/*
          Both, never one instead of the other.

          A running turn is not a reason to refuse a message: the daemon queues
          one, or hands it to the turn already running, which is what
          `Thread.queuedTurns` and `UserMessageItem.folded` are for. Swapping
          send for stop made the reader interrupt covey to say anything to it —
          and the web client has always shown both, hiding only the stop.
        */}
        {buttons}
      </View>
      )}
    </View>
  );
}
