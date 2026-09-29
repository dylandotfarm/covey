/**
 * Every glyph in the app, as a vector — and never as nothing (#172).
 *
 * Drawing controls with text characters is quick and wrong: a character is
 * whatever the device's font decides it is, so the microphone arrived as a
 * colour emoji in somebody else's drawing style and the arrows take a different
 * weight on every Android version. An icon font draws the same shape everywhere
 * and takes a colour like any other text.
 *
 * **But an icon font can fail to load, and `@expo/vector-icons` renders an empty
 * `<Text/>` while it has not.** That shipped: every control in the app came out
 * as a blank circle, which is worse than an ugly glyph by a long way — a button
 * a reader cannot see is a button they cannot use. The font here is downloaded
 * with the bundle rather than built into the app, which is one more way for it
 * to be missing.
 *
 * So this draws the vector when the font is ready and a plain character when it
 * is not. The fallbacks are deliberately dull — no emoji, nothing the device
 * will colour in — because they exist to keep a control usable, not to look
 * like the real thing.
 *
 * One name per idea, and the name says the idea rather than the picture:
 * `send`, not `arrow-upward`. A screen asking for `chevron` should not have to
 * know which family covey draws it from.
 */
import { useEffect, useState } from "react";
import { Text } from "react-native";
import * as Font from "expo-font";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { T } from "./theme";

/** What covey draws: the vector's name, and what to write without it. */
const GLYPH = {
  attach: ["add", "+"],
  close: ["close", "×"],
  mic: ["mic", "●"],
  micOff: ["stop", "■"],
  stop: ["stop", "■"],
  send: ["arrow-upward", "↑"],
  chevron: ["chevron-right", "›"],
  back: ["chevron-left", "‹"],
  open: ["expand-more", "▾"],
  shut: ["chevron-right", "▸"],
  tick: ["check", "✓"],
  play: ["play-arrow", "▶"],
  file: ["description", "▤"],
  settings: ["settings", "≡"],
  add: ["add", "+"],
} as const;

export type IconName = keyof typeof GLYPH;

/**
 * Whether the icon font is on this device yet.
 *
 * Loaded once for the whole app rather than by each icon: every control mounting
 * its own copy of the same request is the same work many times over, and the
 * components that do it have no way to tell anybody when it fails.
 */
let state: "waiting" | "ready" | "failed" = Font.isLoaded("MaterialIcons") ? "ready" : "waiting";
let failure: string | null = null;
const listeners = new Set<() => void>();

function settle(next: "ready" | "failed", why?: string) {
  state = next;
  failure = why ?? null;
  for (const fn of listeners) fn();
}

/** Ask for the font once. Safe to call from anywhere; only the first call works. */
let started = false;
export function loadIconFont(): void {
  if (started || state === "ready") return;
  started = true;
  Font.loadAsync(MaterialIcons.font)
    .then(() => settle("ready"))
    // A bundle carries its font as an asset, so this is a real possibility and
    // not a theoretical one. The app stays usable either way.
    .catch((e: Error) => settle("failed", e.message || "the icon font would not load"));
}

function useIconFont(): "waiting" | "ready" | "failed" {
  const [, bump] = useState(0);
  useEffect(() => {
    loadIconFont();
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return state;
}

/** Why the icons are plain characters, or null when they are not. */
export function iconFontFailure(): string | null {
  return state === "failed" ? failure : null;
}

export function Icon({ name, size = 20, colour = T.muted }: { name: IconName; size?: number; colour?: string }) {
  const font = useIconFont();
  const [vector, plain] = GLYPH[name];
  // `waiting` draws the character too. A control that is blank for a moment is
  // a control a reader taps twice.
  if (font !== "ready") {
    return <Text style={{ color: colour, fontSize: size, lineHeight: size * 1.15, textAlign: "center" }}>{plain}</Text>;
  }
  return <MaterialIcons name={vector} size={size} color={colour} />;
}
