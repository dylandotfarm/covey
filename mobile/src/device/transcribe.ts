/**
 * Turning an utterance into words (#178, #180).
 *
 * Two routes, and the daemon's is the one covey wants. The daemon hands the
 * recording to a transcription service on its own machine (#180): the key that
 * reaches such a service is a secret, and covey keeps secrets on the machine
 * that runs the work and never on a phone. It also means the service can change
 * without anybody installing an app, which matters because an app changes only
 * by somebody installing one.
 *
 * The phone's own recogniser stays as the fallback, for a daemon that has
 * nothing set up and for a phone with no way to reach one. It is worse - it is
 * what #180 was raised about - but a device whose button does nothing is worse
 * still.
 *
 * What goes over the wire to the daemon is the device's **own** blocks, not the
 * samples: four bits a sample rather than sixteen, which on a phone's mobile
 * link is four times less of a wait. The daemon decodes with the same decoder
 * the firmware's encoder was written against.
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
import type { MachineClient, Utterance } from "@covey/client";
import { File, Paths } from "expo-file-system";
import {
  AudioEncodingAndroid, ExpoSpeechRecognitionModule,
} from "expo-speech-recognition";
import { SAMPLE_RATE, wavFromPcm16 } from "@covey/client";
import { toBase64 } from "./ble";

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

/**
 * Ask the daemon, and fall back to this phone when it has nothing set up.
 *
 * `unavailable` is the one code that means "do it yourself". Every other
 * failure is a real one and is shown to the reader as it came: the service
 * writes its sentences for this screen, and covey has nothing better to say
 * about silence than the thing that heard it.
 */
export async function transcribeUtterance(
  client: MachineClient | undefined,
  utterance: Utterance,
  pcm: Int16Array,
): Promise<Transcription & { backend: string }> {
  if (client) {
    try {
      const out = await client.transcribe({
        audio: toBase64(utterance.audio),
        codec: "ima-adpcm",
        sampleRate: utterance.sampleRate,
        samples: utterance.samples,
        blockBytes: utterance.blockBytes,
      });
      return { text: out.text, error: null, backend: out.backend };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code !== "unavailable") {
        return { text: "", error: err.message || "The words could not be made out.", backend: "daemon" };
      }
      // Nothing is set up on that machine. Fall through to this phone.
    }
  }
  const out = await transcribeOnDevice(pcm);
  return { ...out, backend: "phone" };
}

export async function transcribeOnDevice(pcm: Int16Array): Promise<Transcription> {
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
