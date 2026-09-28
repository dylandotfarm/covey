/**
 * The pieces every screen uses (issue #168).
 *
 * The web client's equivalent is its style sheet. This is the same set of
 * decisions in React Native's terms, reading its colours from `theme.ts`.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { MONO, SIZE, T } from "./theme";

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: T.bg },
  bar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.border, backgroundColor: T.surface,
  },
  barTitle: { color: T.text, fontSize: SIZE.title, fontWeight: "600", flexShrink: 1 },
  card: { backgroundColor: T.surface, borderRadius: 12, marginHorizontal: 12, marginTop: 10, overflow: "hidden" },
  row: { paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border },
  title: { color: T.text, fontSize: SIZE.body },
  muted: { color: T.muted, fontSize: SIZE.small },
  subtle: { color: T.subtle, fontSize: SIZE.small },
  mono: { fontFamily: MONO, fontSize: 13, color: T.text },
  grow: { flex: 1 },
});

/** A line of text that is the whole of an empty screen. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
      <Text style={{ color: T.muted, fontSize: SIZE.body, textAlign: "center" }}>{title}</Text>
      {hint ? <Text style={{ color: T.subtle, fontSize: SIZE.small, textAlign: "center" }}>{hint}</Text> : null}
    </View>
  );
}

/**
 * What went wrong, over whatever is on screen.
 *
 * It goes on its own on purpose: the page puts a failure in the same place
 * however it happened — a command that was refused, a file that would not
 * read, a machine that went away — and a reader who has learned where to look
 * should not have to learn twice.
 */
export function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Pressable
      onPress={onDismiss}
      style={{ backgroundColor: T.danger, paddingHorizontal: 14, paddingVertical: 10 }}
      accessibilityRole="alert"
    >
      <Text style={{ color: "#ffffff", fontSize: SIZE.small }}>{text}</Text>
    </Pressable>
  );
}

/** A tappable row. `onLongPress` is the phone's way into a settings sheet (#115). */
export function Row({
  children, onPress, onLongPress, style, first,
}: {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  first?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      // A whole row is one target. A thumb aimed at a row used to hit a chip
      // inside it, which is why the chips in the list are text (#115).
      android_ripple={{ color: T.surfaceAlt }}
      style={[S.row, first ? null : S.rowDivider, style]}
    >
      {children}
    </Pressable>
  );
}

/** A small round label: a count, a state, a branch. */
export function Pill({ text, colour = T.subtle, style }: { text: string; colour?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      style={[{
        color: colour, fontSize: 11, borderColor: colour, borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, overflow: "hidden",
      }, style]}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}

/** A dot in a thread's colour, which is what says at a glance what it is doing. */
export function Dot({ colour }: { colour: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />;
}

export function Spinner({ colour = T.accent }: { colour?: string }) {
  return <ActivityIndicator size="small" color={colour} />;
}

/** A button that reads as one: the primary act of a screen. */
export function Button({
  label, onPress, tone = "normal", disabled, busy,
}: {
  label: string;
  onPress: () => void;
  tone?: "normal" | "primary" | "danger";
  disabled?: boolean;
  busy?: boolean;
}) {
  const colour = tone === "primary" ? T.accent : tone === "danger" ? T.danger : T.surfaceAlt;
  const text = tone === "normal" ? T.text : "#ffffff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      android_ripple={{ color: T.surfaceAlt }}
      style={{
        backgroundColor: colour, opacity: disabled ? 0.4 : 1,
        paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
        flexDirection: "row", alignItems: "center", gap: 8,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={text} /> : null}
      <Text style={{ color: text, fontSize: SIZE.body, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A heading over a group of rows. */
export function SectionTitle({ text }: { text: string }) {
  return (
    <Text style={{ color: T.subtle, fontSize: SIZE.small, textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: 26, paddingTop: 18, paddingBottom: 6 }}>
      {text}
    </Text>
  );
}
