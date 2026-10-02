/**
 * Turning an utterance into words, on the phone (#178).
 *
 * Android will transcribe a *file*, and it takes one shape of it: 16 kHz,
 * 16-bit, one channel, PCM in a WAV container. That is exactly what the device
 * records and what `wavFromPcm16` writes, which is why there is no audio API
 * anywhere in covey and no key to keep: the recogniser is already on the phone,
 * it runs without a network, and the words never leave the device until covey
 * sends them to a thread.
 *
 * It needs Android 13. Below that the recogniser answers `audio-capture`, which
 * reads as a broken microphone rather than as an old phone, so this says which
 * it is. A phone that cannot do it gets a sentence on the device's screen and
 * covey sends nothing — a turn started from words nobody checked is worse than
 * no turn.
 *
 * The same recogniser dictates into the composer (`src/dictation.ts`, #172).
 * That one listens to a live microphone and this one reads a file; they share
 * the module and nothing else.
 */
import { File, Paths } from "expo-file-system";
import {
  AudioEncodingAndroid, ExpoSpeechRecognitionModule,
} from "expo-speech-recognition";
import { SAMPLE_RATE, wavFromPcm16 } from "@covey/client";

/** What came back. `text` is empty when nothing was understood. */
export interface Transcription {
  text: string;
  /** Why there are no words, in something a reader can act on. */
  error: string | null;
}

/**
 * How long to wait for the recogniser.
 *
 * It ends on its own when it has finished. This bound is for the case it does
 * not answer at all, which happens on a phone whose recognition service has
 * been disabled: without it the device would say "hearing" until somebody
 * restarted the app.
 */
const PATIENCE_MS = 30000;

function reason(code: string, message: string): string {
  switch (code) {
    case "audio-capture":
      return "This phone cannot write out speech from a recording. Android 13 or later can.";
    case "not-allowed":
      return "covey may not use the microphone. Android's settings can allow it.";
    case "no-speech":
      return "Nothing was heard.";
    case "network":
      return "The recogniser needed the network and could not reach it.";
    case "language-not-supported":
      return "No language pack for this. Android's settings can add one.";
    default:
      return message || "The words could not be made out.";
  }
}

/**
 * Write the samples somewhere the recogniser can open them.
 *
 * One file, overwritten each time. A recording is up to a megabyte and the
 * reader never sees these; keeping one per utterance would fill the cache with
 * audio nobody asked to keep.
 */
async function writeWav(pcm: Int16Array): Promise<File> {
  const file = new File(Paths.cache, "covey-device-utterance.wav");
  if (file.exists) file.delete();
  file.create();
  file.write(wavFromPcm16(pcm, SAMPLE_RATE));
  return file;
}

export async function transcribe(pcm: Int16Array): Promise<Transcription> {
  if (pcm.length === 0) return { text: "", error: "Nothing was recorded." };

  let file: File;
  try {
    file = await writeWav(pcm);
  } catch (e) {
    return { text: "", error: `The recording could not be saved: ${(e as Error).message}` };
  }

  const granted = await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => null);
  if (!granted?.granted) {
    return { text: "", error: "covey may not use the microphone. Android's settings can allow it." };
  }

  return new Promise<Transcription>((resolve) => {
    let best = "";
    let done = false;

    const finish = (out: Transcription) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      result.remove();
      error.remove();
      end.remove();
      try { file.delete(); } catch { /* the cache is allowed to keep it */ }
      resolve(out);
    };

    const timer = setTimeout(() => {
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* it had already stopped */ }
      finish({ text: best, error: best ? null : "The recogniser did not answer." });
    }, PATIENCE_MS);

    /*
     * The recogniser revises what it heard as it goes, so every result replaces
     * the last rather than being added to it. `end` is what says it is finished:
     * a final result is not always the last one to arrive.
     */
    const result = ExpoSpeechRecognitionModule.addListener("result", (e) => {
      const text = e.results[0]?.transcript ?? "";
      if (text) best = text;
    });
    const error = ExpoSpeechRecognitionModule.addListener("error", (e) => {
      if (e.error === "aborted") return;
      finish({ text: best, error: best ? null : reason(e.error, e.message) });
    });
    const end = ExpoSpeechRecognitionModule.addListener("end", () => {
      finish({ text: best, error: best ? null : "Nothing was heard." });
    });

    try {
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: false,
        continuous: false,
        audioSource: {
          uri: file.uri,
          audioChannels: 1,
          audioEncoding: AudioEncodingAndroid.ENCODING_PCM_16BIT,
          sampleRate: SAMPLE_RATE,
        },
      });
    } catch (e) {
      finish({ text: "", error: (e as Error).message || "The recogniser would not start." });
    }
  });
}
