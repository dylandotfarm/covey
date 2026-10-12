/**
 * How a reader starts dictation on this device.
 *
 * There are two push-to-talk buttons on a phone and they are not equally good.
 * The one on the screen is where the feature started: a microphone beside the
 * message box, held down while you speak. It works, and it has one fault no
 * layout can fix — a thumb held still on glass does not stay still. The hand
 * moves while the sentence is being thought out, the press ends somewhere
 * outside the button, and the recording stops mid-word. The volume keys have
 * an edge a finger can feel, and a hold on one survives the hand moving.
 *
 * So covey offers both, and this is the choice. It is a preference of the
 * *device*, like the level of detail and the hidden threads: it travels in no
 * command, no daemon hears it, and the phone that dictates with a key may be
 * reading a thread a laptop dictates nothing into.
 *
 * **It is off by default and that is deliberate.** While covey holds the keys
 * they do not change the volume, and a volume rocker that stopped working is
 * not a thing to hand somebody who never asked for it. The keys are taken only
 * while a composer is on screen, so the rest of the app is unaffected either
 * way — but the conversation is the screen a reader is on most.
 *
 * Covey takes *either* key. Nothing else on this phone wants a hardware button
 * yet, so there is no second gesture to tell them apart for, and a reader who
 * reaches for the rocker without looking should not have to find the right half
 * of it.
 *
 * Pure, and node-tested beside `markdown.ts`, because both callers sit behind
 * something this loop cannot start: a microphone and a key the Android
 * activity has to receive.
 */

/** The three ways to hold a push-to-talk button. */
export type TalkMode = "button" | "keys" | "both";

/** In the order the settings screen offers them. */
export const TALK_ORDER: readonly TalkMode[] = ["button", "keys", "both"];

/** What this device does unless the reader has said otherwise. */
export const DEFAULT_TALK: TalkMode = "button";

/** The rows of the settings screen, which is the only place these are read. */
export const TALK_LABEL: Record<TalkMode, { label: string; hint: string }> = {
  button: {
    label: "Microphone button",
    hint: "Hold the button beside the message box.",
  },
  keys: {
    label: "Volume keys",
    hint: "Hold either volume key. The button goes, and the keys stop changing the volume while a conversation is open.",
  },
  both: {
    label: "Both",
    hint: "Hold either volume key, or the button. The keys stop changing the volume while a conversation is open.",
  },
};

/**
 * What this device stored, or null when it is not a mode covey knows.
 *
 * A build newer than this one may have written a mode this one cannot act on,
 * and a launch must not fail over a preference. Null means the default, which
 * is the mode every install started on.
 */
export function asTalk(stored: string | null | undefined): TalkMode | null {
  return TALK_ORDER.includes(stored as TalkMode) ? (stored as TalkMode) : null;
}

/**
 * Whether the composer paints the microphone as a button to hold.
 *
 * `keys` is whether this build can read the volume keys — `volumeKeysAvailable`
 * from `modules/covey-keys`. A build that cannot keeps the button whatever is
 * stored, because the alternative is a conversation with no way to dictate at
 * all: a bundle sent over the air lands in whatever app is installed, and an
 * app built before the keys existed would otherwise read a stored `keys` as
 * "paint nothing and listen to nothing".
 */
export function talkButton(mode: TalkMode, keys: boolean): boolean {
  return mode !== "keys" || !keys;
}

/** Whether the composer takes the volume keys while it is on screen. */
export function talkWithKeys(mode: TalkMode, keys: boolean): boolean {
  return keys && mode !== "button";
}

/**
 * What the settings screen says when this build cannot read the keys.
 *
 * It names the one thing that fixes it. A bundle arrives over the air and an
 * APK does not, so an app a few weeks old runs today's JavaScript and holds
 * none of today's native code — the rows are still offered, because the
 * preference outlives the install that reads it.
 */
export function talkNote(keys: boolean): string | null {
  return keys
    ? null
    : "This app was built before covey could read the volume keys. The button stays until a newer one is installed.";
}

/**
 * What one key press or release does to a hold.
 *
 * Covey takes both volume keys, so a reader squeezing the rocker sends two
 * presses and two releases for one hold. The keys that are down are kept, and
 * the hold runs from the first of them to the last release: a second press
 * starts nothing and the first release of two stops nothing.
 *
 * `open` is whether a hold is actually running — `Dictation.held`. It is what
 * makes a *lost* release recoverable. Android can take a key event away: a
 * permission dialog has the focus, or the app goes to the background between
 * the press and the release. The key would stay down for ever and every later
 * press would read as the second of a squeeze. So a press that arrives while
 * nothing is being held starts from an empty hand.
 *
 * A release of a key covey never saw pressed does nothing at all, or the
 * release that dismissed a dialog would end a dictation the button started.
 */
export function keyHold(
  down: readonly string[],
  key: string,
  pressed: boolean,
  open: boolean,
): { down: string[]; act: "start" | "stop" | null } {
  if (pressed) {
    const held = open ? down.filter((k) => k !== key) : [];
    return { down: [...held, key], act: held.length === 0 ? "start" : null };
  }
  if (!down.includes(key)) return { down: [...down], act: null };
  const rest = down.filter((k) => k !== key);
  return { down: rest, act: rest.length === 0 ? "stop" : null };
}
