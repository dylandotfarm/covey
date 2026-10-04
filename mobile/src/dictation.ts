/**
 * Speech to text, for the screen with no room for a keyboard (#172, #180).
 *
 * A cover display is a few lines tall and its keyboard takes most of them. The
 * phone already has a microphone key, on the keyboard — which is exactly the
 * thing there is no room for. So covey offers its own, beside the message box.
 *
 * **The machine writes the words, and this phone shows them while it waits.**
 * All of covey's audio takes that route (`src/transcribe.ts`): the recogniser
 * is a service on the machine that runs the work, where a key is allowed to
 * live, and it is a long way better than a phone's own. But it answers in
 * about a second, and a dictation that shows nothing for a second reads as a
 * microphone that is not working — so the phone's recogniser runs on the same
 * held button, puts its own words in the draft as they are spoken, and the
 * machine's words replace them when they land.
 *
 * That replacement is the whole reason the phone's words are *provisional*:
 * `onTranscript` is told `final` once, by whichever recogniser had the last
 * word, and the caller starts the next utterance from there. Report the phone's
 * text as final and the machine's answer would be added to the draft instead
 * of correcting it.
 *
 * It records with `recordingOptions.persist`, which is what gives the machine
 * something to be asked about: the module writes 16 kHz 16-bit mono PCM, the
 * one shape covey carries (`wavFromPcm16` writes it, `pcm16FromWav` reads it
 * back). Two things follow. It needs Android 13, and below that there is no
 * file — the phone's own words stand, which is the same floor the device's
 * route has. And covey's own recorder feeds the recogniser from then on, which
 * takes the start and stop beep away; on a held button that is a mercy rather
 * than a loss.
 *
 * This is the one part of the app that is **not** JavaScript. It is a native
 * module, so a bundle that uses it cannot reach an app built without it: the
 * app's version carries the runtime version, and it moved to `0.2.0` when this
 * arrived so a `0.1.0` install stopped being offered bundles it could not run.
 * That is `runtimeVersion` doing its job rather than a mistake — see
 * `docs/MOBILE.md`. Nothing here needs a new module, so nothing here moves it.
 *
 * Nothing here decides what the words mean. The transcript replaces whatever the
 * last utterance put in, on top of whatever the reader had already typed, so a
 * correction from the recogniser reads as a correction and not as a second
 * sentence.
 */
import { useCallback, useRef, useState } from "react";
import { File } from "expo-file-system";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { pcm16FromWav } from "@covey/client";
import { store } from "./store";
import { askMachine, phoneRecording, type Recording } from "./transcribe";

export interface Dictation {
  /** The device can do this at all. False on one with no recogniser installed. */
  available: boolean;
  listening: boolean;
  /** The microphone is off and the machine is writing out what was said. */
  writing: boolean;
  /** What went wrong, in words a reader can act on. */
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

/**
 * How many recordings this app has made.
 *
 * The file name carries it so that two holds cannot write over one another —
 * including two from different screens, which a counter inside the hook would
 * not have told apart.
 */
let recordings = 0;

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
 * times while somebody speaks — the recogniser revises what it heard, and then
 * the machine corrects the lot — so the caller must *replace* rather than
 * append, which is why it also gets told when the utterance is settled.
 *
 * `machine` is the machine of the thread being written to. It is that machine
 * and not the nearest one with a service: the words are going to a thread
 * there, and that is where its secrets and its work already live.
 */
export function useDictation(
  machine: string,
  onTranscript: (text: string, final: boolean) => void,
): Dictation {
  const [listening, setListening] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = useRef(recognitionAvailable()).current;

  /**
   * Which utterance is on the screen.
   *
   * The machine answers after the microphone has stopped, so a reader who
   * holds the button again straight away has moved the draft on from under the
   * answer in flight. Every late answer is matched against this and dropped —
   * the same guard, and for the same reason, as the one on the terminal's
   * picture preview: a slow fetch must never paint over a later one.
   */
  const utterance = useRef(0);
  /** What this phone made of the utterance, until the machine corrects it. */
  const heard = useRef("");
  /** The recording the machine is to be asked about, from `audioend`. */
  const recorded = useRef<string | null>(null);

  /**
   * Hand the recording to the machine, and settle the draft either way.
   *
   * The phone's words are already in the draft, so there is always something
   * to settle on: a machine with no service, a recording Android would not
   * write, and a service that failed all leave the reader with the sentence
   * they spoke. A failure still says so, because a reader whose words came
   * from the worse of the two recognisers should be told which one wrote them.
   */
  const writeOut = useCallback(async () => {
    const mine = utterance.current;
    const uri = recorded.current;
    recorded.current = null;
    const settle = (text: string) => {
      if (utterance.current !== mine) return;
      setWriting(false);
      if (text) onTranscript(text, true);
    };

    if (!uri) return settle(heard.current);
    const client = store.client(machine);
    const info = store.machineInfo(machine);
    setWriting(true);
    let recording: Recording | null = null;
    try {
      const file = new File(uri);
      const wav = pcm16FromWav(new Uint8Array(await file.arrayBuffer()));
      recording = wav && phoneRecording(wav.pcm, wav.sampleRate);
    } catch {
      /* The file is the machine's route and not the only one. */
    } finally {
      // The cache is not where a recording lives. One file per utterance, gone
      // as soon as it has been read, or a day of dictation fills the phone.
      try { new File(uri).delete(); } catch { /* it was never written */ }
    }

    const answer = await askMachine(client, info, recording);
    if (utterance.current !== mine) return;
    if ("words" in answer) {
      // The machine heard it, so whatever this phone made of the same sound is
      // not news. Its "Nothing was heard." above the words it is reading now
      // is the one message a reader cannot make sense of.
      setError(null);
      return settle(answer.words.text);
    }
    if ("failed" in answer) setError(answer.failed);
    return settle(heard.current);
  }, [machine, onTranscript]);

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (!text) return;
    heard.current = text;
    // Never final: the machine has the last word, and a caller told this one
    // was settled would add that word rather than put it in place.
    onTranscript(text, false);
  });

  useSpeechRecognitionEvent("audioend", (e) => {
    recorded.current = e.uri ?? null;
  });

  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    void writeOut();
  });

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
      utterance.current++;
      heard.current = "";
      recorded.current = null;
      setWriting(false);
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        // The words appear while they are spoken, which on a screen this small
        // is the difference between dictating and waiting.
        interimResults: true,
        // One utterance. Continuous listening on a phone in a pocket is a
        // microphone nobody turned off.
        continuous: false,
        // What the machine is asked about. Every recording gets its own name,
        // so a second hold cannot write over the file the first is reading.
        recordingOptions: { persist: true, outputFileName: `covey-dictation-${++recordings}.wav` },
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

  return { available, listening, writing, error, start, stop, clearError: () => setError(null) };
}
