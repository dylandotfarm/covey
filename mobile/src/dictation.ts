/**
 * Speech to text, for the screen with no room for a keyboard (#172, #180).
 *
 * A cover display is a few lines tall and its keyboard takes most of them. The
 * phone already has a microphone key, on the keyboard — which is exactly the
 * thing there is no room for. So covey offers its own, beside the message box,
 * and a reader may move it to the volume keys instead (`src/talk.ts`). Which
 * button is held changes nothing here: both end at `start` and `stop`.
 *
 * **A hold lasts until the reader lets go.** Not until they pause — a person
 * thinking a sentence out loud stops for longer than any endpointer waits, and
 * the recogniser's own two seconds of silence took the rest of the sentence
 * away. The silence it ends on is widened to the cap instead. The reader
 * decides when the thought is finished, which is what a held button is for.
 *
 * Two rules follow from that and neither is optional, because the hold now
 * runs for three minutes where it used to stop at a pause.
 *
 * **Nothing between the press and the recording may be awaited.** Android puts
 * its permission dialog up inside such an await, the dialog takes the focus and
 * the key events, and the release that was meant to end the hold never arrives
 * — so the recording starts with nobody holding it. The permission is read at
 * mount and a hold that still has to ask for it records nothing.
 *
 * **A hold covey ended is not sent.** The cap is reached by a key pressed
 * against a table far more often than by a sentence, and uploading three
 * minutes of a pocket over a mobile link is the thing `MAX_RECORDING_MS` was
 * written to prevent. The reader keeps the words this phone made of it, which
 * is what that constant has always promised.
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
 * The recogniser is **not** JavaScript. It is a native module, so a bundle that
 * uses it cannot reach an app built without it: the app's version carries the
 * runtime version, and it moved to `0.2.0` when this arrived so a `0.1.0`
 * install stopped being offered bundles it could not run. That is
 * `runtimeVersion` doing its job rather than a mistake — see `docs/MOBILE.md`.
 * The volume keys are a second native module and moved it again, to `0.5.0`,
 * which is why `modules/covey-keys` is optional and answers false in an older
 * app rather than throwing at import time.
 *
 * Nothing here decides what the words mean. The transcript replaces whatever the
 * last utterance put in, on top of whatever the reader had already typed, so a
 * correction from the recogniser reads as a correction and not as a second
 * sentence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { File } from "expo-file-system";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { pcm16FromWav } from "@covey/client";
import { store } from "./store";
import { askMachine, MAX_RECORDING_MS, phoneRecording, type Recording } from "./transcribe";

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
  /**
   * Whether a hold is open right now.
   *
   * A function and not a value, because it is read from inside a key handler
   * that is registered once and must not be re-registered per render — the
   * composer would give the volume keys back and take them again in the middle
   * of the hold it is asking about.
   */
  held: () => boolean;
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
 * Whether this app may use the microphone, as far as it last knew.
 *
 * Asked once per launch and kept here, because **a hold must not await
 * anything**. Android puts its permission dialog up inside that await and the
 * dialog takes the focus and the keys with it, so the release that ends the
 * hold never reaches covey: the recording would start with nobody holding it
 * and run until the cap. The first hold therefore buys the permission and
 * records nothing, and the next one records.
 *
 * `null` is "not asked yet". A reader who takes the permission away in
 * Android's settings makes this stale, and the `not-allowed` error is what puts
 * it back.
 */
let permitted: boolean | null = null;

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
  /**
   * The parts of the utterance the recogniser has settled, in order.
   *
   * A hold is one utterance to the reader and may be several *segments* to the
   * recogniser: Android reports a segment as final and goes on listening, and
   * each one carries its own words rather than the whole sentence so far. So
   * they are kept and joined. Replace the last one instead and a reader who
   * paused for breath watches their first sentence vanish when the second
   * arrives.
   */
  const settled = useRef<string[]>([]);
  /** What the recogniser is making of the segment it is still hearing. */
  const partial = useRef("");
  /** The recording the machine is to be asked about, from `audioend`. */
  const recorded = useRef<string | null>(null);
  /**
   * The cap on one hold.
   *
   * The recogniser used to end an utterance at a pause and now ends it when the
   * reader lets go, so nothing but this bounds a hold — and a button in a
   * pocket, or a volume key pressed against a table, is a microphone nobody
   * turned off. It fires at `MAX_RECORDING_MS`, which is the length
   * `phoneRecording` refuses to send, so the hold ends while the words it
   * gathered can still be written out.
   */
  const capped = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether a hold is open: from the press to the release, or to the cap. */
  const holding = useRef(false);
  /**
   * Whether covey ended this hold rather than the reader.
   *
   * It decides whether the machine is asked at all. A hold that ran the whole
   * of `MAX_RECORDING_MS` is a key pressed against a table far more often than
   * it is a sentence, and uploading three minutes of a pocket over a mobile
   * link is what that cap was written to prevent. The reader keeps the words
   * this phone made of it, which is what `MAX_RECORDING_MS` has always
   * promised.
   */
  const abandoned = useRef(false);

  /** What this phone has made of the hold so far, settled parts and all. */
  const spoken = () => [...settled.current, partial.current].filter(Boolean).join(" ");

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
    // Read once, here. No more results arrive for this utterance — the
    // recogniser sent its last one before the `end` that called this — and a
    // later hold resets both refs under the awaits below.
    const heard = spoken();
    recorded.current = null;
    const settle = (text: string) => {
      if (utterance.current !== mine) return;
      setWriting(false);
      if (text) onTranscript(text, true);
    };

    if (!uri) return settle(heard);
    if (abandoned.current) {
      // The file is still deleted below; it is the *upload* that is refused.
      try { new File(uri).delete(); } catch { /* it was never written */ }
      setError(`covey records ${Math.round(MAX_RECORDING_MS / 60_000)} minutes at a time. These words are this phone's own.`);
      return settle(heard);
    }
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
    // And the same sentence the other way round. A machine that heard nothing
    // has nothing to tell a reader who is looking at the words this phone
    // heard; every other failure says why the worse recogniser wrote them.
    if ("failed" in answer && !(answer.code === "no-speech" && heard)) setError(answer.failed);
    return settle(heard);
  }, [machine, onTranscript]);

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (!text) return;
    // A segment the recogniser called final is kept; everything else is the
    // segment it is still revising and replaces the last guess at it.
    if (e.isFinal) {
      /*
       * A recogniser that re-sends the whole utterance rather than the newest
       * segment would be doubled by a join, and no test here can tell which one
       * a given Android has: this runs behind a microphone. One whose words
       * already contain everything settled stands in their place instead, so
       * both kinds come out right.
       */
      const far = settled.current.join(" ");
      if (far && text.startsWith(far)) settled.current = [text];
      else settled.current.push(text);
      partial.current = "";
    } else partial.current = text;
    // Never final to the caller, whatever the recogniser called it: the machine
    // has the last word, and a caller told this one was settled would add that
    // word rather than put it in place.
    onTranscript(spoken(), false);
  });

  useSpeechRecognitionEvent("audioend", (e) => {
    recorded.current = e.uri ?? null;
  });

  useSpeechRecognitionEvent("end", () => {
    if (capped.current) { clearTimeout(capped.current); capped.current = null; }
    // The recogniser may end before the reader lets go — Android answers for
    // the silence extras and some of them are advisory. The hold is over
    // whatever ended it, or the next press would read as the second of a
    // squeeze and start nothing.
    holding.current = false;
    setListening(false);
    void writeOut();
  });

  useSpeechRecognitionEvent("error", (e) => {
    if (capped.current) { clearTimeout(capped.current); capped.current = null; }
    holding.current = false;
    setListening(false);
    // `aborted` is the reader pressing stop, which is not a failure.
    if (e.error === "aborted") return;
    // The reader took the permission away in Android's settings while the app
    // ran, so what this module last knew is wrong. The next hold asks again.
    if (e.error === "not-allowed") permitted = false;
    setError(
      e.error === "not-allowed"
        ? "covey may not use the microphone. Android's settings can allow it."
        : e.error === "no-speech"
          ? "Nothing was heard."
          : e.message || "The microphone would not start.",
    );
  });

  /*
   * Ask for the permission once, as the composer mounts.
   *
   * It is asked here so that `start` never has to: a hold that awaits anything
   * is a hold whose release can go missing. This only *reads* the answer, so no
   * dialog appears and nothing is asked of the reader until they press.
   */
  useEffect(() => {
    if (permitted !== null) return;
    ExpoSpeechRecognitionModule.getPermissionsAsync()
      .then((r) => { permitted = r.granted; })
      .catch(() => { /* the first hold asks for it */ });
  }, []);

  /**
   * End the hold.
   *
   * `stop` and not `abort`: it asks the recogniser for one last result, which
   * is the only part of a long hold this phone has not already shown. The
   * `end` event follows either way and `writeOut` runs from there.
   */
  const stop = useCallback(() => {
    if (capped.current) { clearTimeout(capped.current); capped.current = null; }
    holding.current = false;
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* it had already stopped */ }
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    /*
     * The hold begins here.
     *
     * The composer clears the base it writes dictation onto as the finger goes
     * down, so a late answer that lands after this point would be settled onto
     * a draft that no longer holds the words it is meant to replace, and the
     * reader would get both. Counting the utterance first makes the guard cover
     * the whole of the hold rather than most of it.
     */
    utterance.current++;
    settled.current = [];
    partial.current = "";
    recorded.current = null;
    abandoned.current = false;
    setWriting(false);

    /*
     * The permission is bought by a hold that records nothing.
     *
     * **A hold that reaches the recogniser may not have awaited anything, and
     * this one has** — so it ends here instead. Android puts its dialog up
     * inside that await and the dialog takes the focus and the key events with
     * it, so neither the release of the button nor the release of the key
     * reaches covey; and `stop()` before the recogniser exists does nothing at
     * all, because the module posts `stopListening` to a recogniser it has not
     * built. The recording would start with nobody holding it and run to the
     * cap. The reader holds again, and that hold records.
     *
     * Everything after this point is synchronous, which is the rule. Put an
     * await back in and the race comes with it.
     */
    if (!permitted) {
      const granted = await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => ({ granted: false }));
      permitted = granted.granted;
      setError(permitted
        ? "covey may use the microphone now. Hold again to dictate."
        : "covey may not use the microphone. Android's settings can allow it.");
      return;
    }

    holding.current = true;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        // The words appear while they are spoken, which on a screen this small
        // is the difference between dictating and waiting.
        interimResults: true,
        // One utterance, ended by the reader. `continuous` is the module's
        // other way to listen through a pause and it is not this one: with a
        // recording it keys the segmented session on the audio *source*, whose
        // only end is the recorder closing — which `stop()` does not do. The
        // hold would never settle. The silence below is what keeps the
        // recogniser listening, and it keeps the flow that already works.
        continuous: false,
        /*
         * Listen until the reader lets go.
         *
         * A recording puts the module in Android's segmented session mode and
         * sets the silence it ends on to two seconds. Two seconds is a breath.
         * A reader thinking a sentence out loud pauses for longer than that and
         * had the rest of it dropped, which is the fault this works around —
         * the hold is the gesture, so the silence inside it means nothing.
         *
         * These are the intent extras the module writes, applied after its own,
         * and the one the session ends on is `COMPLETE_SILENCE`. The *possible*
         * one goes with it, because that is the endpointer cutting off a pause
         * mid-sentence. Both are `MAX_RECORDING_MS`, so the cap below is what
         * ends a hold nobody ended, rather than a silence the recogniser
         * noticed first.
         */
        androidIntentOptions: {
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: MAX_RECORDING_MS,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: MAX_RECORDING_MS,
        },
        // What the machine is asked about. Every recording gets its own name,
        // so a second hold cannot write over the file the first is reading.
        recordingOptions: { persist: true, outputFileName: `covey-dictation-${++recordings}.wav` },
      });
      setListening(true);
      if (capped.current) clearTimeout(capped.current);
      // Covey ending the hold, not the reader — so the recording is not sent.
      capped.current = setTimeout(() => { abandoned.current = true; stop(); }, MAX_RECORDING_MS);
    } catch (e) {
      holding.current = false;
      setError((e as Error).message || "The microphone would not start.");
      setListening(false);
    }
  }, [stop]);

  const held = useCallback(() => holding.current, []);

  return { available, listening, writing, error, start, stop, held, clearError: () => setError(null) };
}
