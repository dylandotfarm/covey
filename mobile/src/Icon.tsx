/**
 * Every glyph in the app, as a vector (#172).
 *
 * The first cut drew its controls with text — `＋`, `↑`, `🎤`, `▸` — which is
 * quick and wrong. A character is whatever the device's font decides it is: the
 * microphone came out as a colour emoji in somebody else's drawing style, the
 * arrows are a different weight on every Android version, and none of them take
 * covey's palette. An icon font draws the same shape everywhere and takes a
 * colour like any other text.
 *
 * `@expo/vector-icons` is fonts and JavaScript over `expo-font`, whose native
 * half every build already carries — so this reaches an installed app over the
 * air and needs no new one.
 *
 * One name per idea, and the name says the idea rather than the picture:
 * `send`, not `arrow-upward`. A screen asking for `chevron` should not have to
 * know which family covey draws it from.
 */
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { T } from "./theme";

/** What covey draws, and the one place the family is chosen. */
const GLYPH = {
  attach: "add",
  close: "close",
  mic: "mic",
  micOff: "stop",
  stop: "stop",
  send: "arrow-upward",
  chevron: "chevron-right",
  back: "chevron-left",
  open: "expand-more",
  shut: "chevron-right",
  tick: "check",
  play: "play-arrow",
  file: "description",
  settings: "settings",
  add: "add",
} as const;

export type IconName = keyof typeof GLYPH;

export function Icon({ name, size = 20, colour = T.muted }: { name: IconName; size?: number; colour?: string }) {
  return <MaterialIcons name={GLYPH[name]} size={size} color={colour} />;
}
