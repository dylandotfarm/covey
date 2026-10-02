/**
 * Writing out what somebody said (#180).
 *
 * The daemon does not transcribe. It hands the recording to a service that
 * does, over plain HTTP on the machine's own loopback, and turns whatever comes
 * back into either words or one sentence a reader can act on.
 *
 * **Why the daemon and not the phone.** The key that reaches a transcription
 * service is a secret, and covey keeps secrets on the machine that runs the
 * work (#126). A phone is not that machine. It also means the service can be
 * swapped — a local model today, a hosted one tomorrow — without anybody
 * installing an app, and the TUI gets dictation for nothing.
 *
 * **The decode is the shared one.** `pcmFromAdpcm` and `wavFromPcm16` come from
 * `@covey/client`, which is where the device's own encoder is defined and where
 * node tests it. The firmware writes those bytes and this reads them; there is
 * one definition of the format and no second copy here.
 *
 * **Sixteen kilohertz, sixteen bit, one channel.** That is what the device
 * records and the only shape `wavFromPcm16` writes. Every recogniser covey has
 * met takes it.
 */
import { pcmFromAdpcm, wavFromPcm16, ADPCM_BLOCK_BYTES } from "@covey/client";

/** Where the service listens, unless the environment says otherwise. */
export const DEFAULT_TRANSCRIBE_URL = "http://127.0.0.1:8790";

/**
 * How long to wait.
 *
 * A person is holding a device, waiting. Measured against the service on this
 * project's machine, a five-second utterance comes back in about 600 ms and an
 * eleven-second one in about 840 ms. Fifteen seconds is far past anything that
 * is still working, and it is a bound rather than a budget.
 */
const TIMEOUT_MS = 15000;

export interface TranscribeParams {
  audio: string;
  codec: "ima-adpcm" | "pcm16";
  sampleRate: number;
  samples: number;
  blockBytes?: number;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
  backend: string;
}

/** Thrown with a code the client can branch on and a sentence a reader reads. */
export class TranscribeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The service covey talks to, or none. `""` turns the feature off outright. */
export function transcribeUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env.COVEY_TRANSCRIBE_URL;
  if (set === undefined) return DEFAULT_TRANSCRIBE_URL;
  const trimmed = set.trim();
  return trimmed === "" ? null : trimmed.replace(/\/+$/, "");
}

/**
 * Turn the parameters into the samples they stand for.
 *
 * Exported because it is the half worth testing without a service: a wrong
 * block size or a missing sample count is a sentence that ends in noise, and
 * neither shows up as an error anywhere.
 */
export function samplesOf(params: TranscribeParams): Int16Array {
  const raw = Uint8Array.from(Buffer.from(params.audio, "base64"));
  if (params.codec === "pcm16") {
    // The bytes are already samples, little endian, as every WAV writes them.
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const count = Math.min(params.samples || raw.length / 2, Math.floor(raw.length / 2));
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) pcm[i] = view.getInt16(i * 2, true);
    return pcm;
  }
  return pcmFromAdpcm(raw, params.blockBytes || ADPCM_BLOCK_BYTES, params.samples);
}

/**
 * What the service said, as something a reader can act on.
 *
 * The service answers a code and a sentence of its own, and its sentences are
 * written for this screen — "The microphone recorded only silence; check that it
 * works." is better than anything covey could say from a status number. So its
 * words are kept, and only a service that says nothing useful gets covey's.
 */
async function readFailure(res: Response): Promise<TranscribeError> {
  let code = `http-${res.status}`;
  let message = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error) code = body.error;
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    /* not JSON: the status is all there is */
  }
  if (!message) {
    message = res.status >= 500
      ? "The service that writes out speech had a fault."
      : "The recording could not be read.";
  }
  return new TranscribeError(code, message);
}

/**
 * Hand one recording to the service.
 *
 * `fetchImpl` is for the tests, which must never reach a network: `pnpm test`
 * stands up no service and must not need one.
 */
export async function transcribe(
  params: TranscribeParams,
  opts: { url?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<TranscribeResult> {
  const url = opts.url === undefined ? transcribeUrl() : opts.url;
  if (!url) {
    throw new TranscribeError(
      "unavailable",
      "This machine has nothing set up to write out speech.",
    );
  }

  const pcm = samplesOf(params);
  if (pcm.length === 0) {
    throw new TranscribeError(
      "audio-empty",
      "The recording was empty; hold the button while you speak.",
    );
  }
  const durationMs = Math.round((pcm.length * 1000) / (params.sampleRate || 16000));
  const wav = wavFromPcm16(pcm, params.sampleRate || 16000);

  const call = opts.fetchImpl ?? fetch;
  const stop = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await call(`${url}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
      signal: stop,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new TranscribeError("timeout", "The service that writes out speech did not answer.");
    }
    // A service that is not running is the ordinary case on a machine nobody
    // set one up on, so it reads as "not set up" rather than as a fault.
    throw new TranscribeError(
      "unavailable",
      "Nothing answered on this machine to write out speech.",
    );
  }

  if (!res.ok) throw await readFailure(res);

  const body = (await res.json()) as { text?: unknown; backend?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    throw new TranscribeError("no-speech", "Nothing was heard.");
  }
  return {
    text,
    durationMs,
    backend: typeof body.backend === "string" ? body.backend : "unknown",
  };
}
