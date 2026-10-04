/**
 * One route from audio to words (#180).
 *
 * Two things on this phone record speech — the covey device's talk button and
 * the microphone beside the composer — and both of them ask the *machine* to
 * write out what was said. The machine's recogniser is a service the daemon
 * talks to over its own loopback (`packages/daemon/src/transcribe.ts`), so the
 * key it needs stays where covey keeps every secret, and the service can be
 * changed without anybody installing an app.
 *
 * The phone's own recogniser is the fallback and nothing more. It is what #180
 * was raised about. It stays because a machine with no service set up, and a
 * phone with no machine in reach, must still turn a held button into words.
 *
 * **This module holds the decision and no platform.** Nothing here imports
 * Expo, React or `react-native-ble-plx`, so node tests it
 * (`transcribe.test.ts`) — which is the only way the rule below is held to,
 * because the two callers sit behind a microphone and a radio and neither can
 * be run in this loop.
 *
 * The rule: ask the machine unless it has said it cannot, use what it answers,
 * and fall back to this phone on `unavailable` *only*. Every other failure
 * carries the service's own sentence to the screen, because those sentences
 * were written for a reader ("The microphone recorded only silence; check that
 * it works.") and covey has nothing better to say about silence than the thing
 * that listened to it.
 */
import type { MachineInfo } from "@covey/protocol";
import { SAMPLE_RATE, type Utterance } from "@covey/client";
import { toBase64 } from "@covey/web/attach";

/** What a machine was asked to write out, as `transcribe` takes it. */
export interface Recording {
  audio: string;
  codec: "ima-adpcm" | "pcm16";
  sampleRate: number;
  samples: number;
  blockBytes?: number;
}

/** The words, and what wrote them. */
export interface MachineWords {
  text: string;
  /** `openai`, a local model, the name the service gives itself. */
  backend: string;
}

/**
 * What came of asking.
 *
 * Three answers and not two: a machine that *has* no recogniser and a
 * recogniser that *failed* are different things, and the first is the only one
 * this phone answers for itself. Collapse them and a service that is down
 * reads as a phone that was never meant to ask.
 */
export type MachineAnswer =
  | { words: MachineWords }
  /** Nothing is set up there. Write the words here, and say nothing about it. */
  | { fallBack: true }
  /** The service answered, and this is its own sentence for the reader. */
  | { failed: string };

/**
 * The longest recording this phone sends.
 *
 * Samples are 32 kB a second, so three minutes is 5.8 MB going up from a
 * device that may be on a mobile link. Past this the phone's own words stand:
 * a hold that long is a button in a pocket far more often than it is a
 * sentence, and a reader must not pay for the difference. The recogniser ends
 * an utterance at a pause of its own accord, so an ordinary dictation is
 * nowhere near it.
 */
export const MAX_RECORDING_MS = 180_000;

/**
 * Whether to ask this machine at all.
 *
 * `undefined` is not `false` — a daemon built before the field sends nothing,
 * and the answer for one of those is to ask and read `unavailable` back. Only
 * a daemon that said `false` is one covey keeps an utterance from.
 */
export function machineWritesSpeech(info: MachineInfo | undefined): boolean {
  return info?.capabilities?.transcribes !== false;
}

/**
 * The device's own utterance, on the wire unchanged.
 *
 * Four bits a sample rather than sixteen, which is what makes an utterance fit
 * in the radio time Bluetooth Low Energy has — and these are the bytes the
 * firmware encoded, so nothing re-encodes them here. The daemon decodes with
 * the same decoder the encoder was written against.
 */
export function deviceRecording(u: Utterance): Recording {
  return {
    audio: toBase64(u.audio),
    codec: "ima-adpcm",
    sampleRate: u.sampleRate,
    samples: u.samples,
    blockBytes: u.blockBytes,
  };
}

/**
 * This phone's own recording, on the wire as samples.
 *
 * `pcm16` is in the protocol for a caller that already holds samples, and this
 * is that caller: the phone recorded them clean and ADPCM's four-to-one is a
 * trade the device makes for radio time it does not have. Better words are the
 * whole reason the machine is asked, so the phone spends the bytes instead —
 * about 32 kB a second, bounded by `MAX_RECORDING_MS`.
 *
 * `null` when there is nothing worth sending: no samples, or more of them than
 * covey carries on one recording.
 */
export function phoneRecording(pcm: Int16Array, sampleRate = SAMPLE_RATE): Recording | null {
  if (pcm.length === 0) return null;
  const rate = sampleRate || SAMPLE_RATE;
  if ((pcm.length * 1000) / rate > MAX_RECORDING_MS) return null;
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return { audio: toBase64(bytes), codec: "pcm16", sampleRate: rate, samples: pcm.length };
}

/**
 * The one call, so that `MachineClient` is not what the tests need.
 *
 * A structural type and not the class: a fake with one method is the whole of
 * what this module's rule has to be measured against.
 */
export interface SpeechMachine {
  transcribe(params: Recording): Promise<{ text: string; backend: string; durationMs: number }>;
}

/**
 * Ask the machine to write out a recording.
 *
 * It never throws. Each of the three answers is something a caller has to do
 * next, and a caller holding a half-finished utterance is the worst place in
 * covey to have to catch an exception.
 */
export async function askMachine(
  client: SpeechMachine | undefined,
  info: MachineInfo | undefined,
  recording: Recording | null,
): Promise<MachineAnswer> {
  if (!client || !recording || !machineWritesSpeech(info)) return { fallBack: true };
  try {
    const out = await client.transcribe(recording);
    const text = out.text.trim();
    // A machine that heard no words is not a machine to ask again with the
    // same audio, but this phone may yet have made them out.
    if (!text) return { fallBack: true };
    return { words: { text, backend: out.backend } };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "unavailable") return { fallBack: true };
    return { failed: err.message || "The words could not be made out." };
  }
}
