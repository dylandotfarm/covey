/**
 * Speech to text, for the screen with no room for a keyboard (#172).
 *
 * A cover display is a few lines tall and its keyboard takes most of them. The
 * phone already has a microphone key, on the keyboard — which is exactly the
 * thing there is no room for. So covey offers its own, beside the message box.
 *
 * This is the one part of the app that is **not** JavaScript. It is a native
 * module, so a bundle that uses it cannot reach an app built without it: the
 * app's version carries the runtime version, and it moves to `0.2.0` here so a
 * `0.1.0` install stops being offered bundles it could not run. That is
 * `runtimeVersion` doing its job rather than a mistake — see `docs/MOBILE.md`.
 *
 * Nothing here decides what the words mean. The transcript replaces whatever the
 * last utterance put in, on top of whatever the reader had already typed, so a
 * correction from the recogniser reads as a correction and not as a second
 * sentence.
 */
import { useCallback, useRef, useState } from "react";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";

export interface Dictation {
  /** The device can do this at all. False on one with no recogniser installed. */
  available: boolean;
  listening: boolean;
  /** What went wrong, in words a reader can act on. */
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

/**
 * Whether this device can turn speech into text.
 *
 * Asked once and guarded: the call reaches native code, and a device without a
 * recogniser is a device that should get no microphone button rather than one
 * that fails when pressed.
 */
function recognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Dictation into a draft.
 *
 * `onTranscript` is handed the text of the utterance so far. It arrives many
 * times while somebody speaks — the recogniser revises what it heard — so the
 * caller must *replace* rather than append, which is why it also gets told when
 * the utterance is final.
 */
export function useDictation(onTranscript: (text: string, final: boolean) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = useRef(recognitionAvailable()).current;

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (text) onTranscript(text, Boolean(e.isFinal));
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", (e) => {
    setListening(false);
    // `aborted` is the reader pressing stop, which is not a failure.
    if (e.error === "aborted") return;
    setError(
      e.error === "not-allowed"
        ? "covey may not use the microphone. Android's settings can allow it."
        : e.error === "no-speech"
          ? "Nothing was heard."
          : e.message || "The microphone would not start.",
    );
  });

  const start = useCallback(async () => {
    setError(null);
    try {
      const granted = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted.granted) {
        setError("covey may not use the microphone. Android's settings can allow it.");
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        // The words appear while they are spoken, which on a screen this small
        // is the difference between dictating and waiting.
        interimResults: true,
        // One utterance. Continuous listening on a phone in a pocket is a
        // microphone nobody turned off.
        continuous: false,
      });
      setListening(true);
    } catch (e) {
      setError((e as Error).message || "The microphone would not start.");
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* it had already stopped */ }
    setListening(false);
  }, []);

  return { available, listening, error, start, stop, clearError: () => setError(null) };
}
