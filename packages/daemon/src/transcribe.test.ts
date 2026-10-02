import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADPCM_BLOCK_BYTES, SAMPLE_RATE, adpcmFromPcm } from "@covey/client";
import {
  DEFAULT_TRANSCRIBE_URL, TranscribeError, samplesOf, transcribe, transcribeUrl,
  type TranscribeParams,
} from "./transcribe.js";

/** A tone, as something with a shape the codec has to carry. */
function tone(samples: number, amp = 9000): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  return pcm;
}

function adpcmParams(pcm: Int16Array): TranscribeParams {
  return {
    audio: Buffer.from(adpcmFromPcm(pcm)).toString("base64"),
    codec: "ima-adpcm",
    sampleRate: SAMPLE_RATE,
    samples: pcm.length,
    blockBytes: ADPCM_BLOCK_BYTES,
  };
}

/** A service that answers however the test says, and records what it was sent. */
function service(reply: { status: number; body?: unknown; text?: string }) {
  const seen: { url: string; bytes: number; type: string | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as Uint8Array;
    seen.push({
      url: String(url),
      bytes: body?.byteLength ?? 0,
      type: (init?.headers as Record<string, string> | undefined)?.["content-type"],
    });
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": reply.text ? "text/plain" : "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("where the service is", () => {
  it("takes the machine's own loopback unless the environment says otherwise", () => {
    assert.equal(transcribeUrl({}), DEFAULT_TRANSCRIBE_URL);
    assert.equal(transcribeUrl({ COVEY_TRANSCRIBE_URL: "http://box:8790/" }), "http://box:8790");
  });

  it("is turned off by an empty setting, which is not the same as an unset one", () => {
    // A machine that must never send audio anywhere says so by setting nothing
    // into the variable. Unset means "the usual place".
    assert.equal(transcribeUrl({ COVEY_TRANSCRIBE_URL: "" }), null);
    assert.equal(transcribeUrl({ COVEY_TRANSCRIBE_URL: "   " }), null);
  });
});

describe("the recording", () => {
  it("decodes the device's own blocks and stops where the device stopped", () => {
    const pcm = tone(700);
    const got = samplesOf(adpcmParams(pcm));
    assert.equal(got.length, 700, "a padded last block must not add samples nobody made");
  });

  it("reads plain samples as well, for a caller that already has them", () => {
    const pcm = tone(400);
    const got = samplesOf({
      audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
      codec: "pcm16",
      sampleRate: SAMPLE_RATE,
      samples: pcm.length,
    });
    assert.deepEqual(Array.from(got.subarray(0, 8)), Array.from(pcm.subarray(0, 8)));
    assert.equal(got.length, pcm.length);
  });

  it("goes to the service as a WAV, which is the one shape every recogniser takes", async () => {
    const pcm = tone(SAMPLE_RATE); // one second
    const { fetchImpl, seen } = service({ status: 200, body: { text: "hello", backend: "openai" } });
    const out = await transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl });

    assert.equal(out.text, "hello");
    assert.equal(out.backend, "openai");
    assert.equal(out.durationMs, 1000, "the length comes from the samples, not from a clock");
    assert.equal(seen[0]!.url, "http://box:8790/transcribe");
    assert.equal(seen[0]!.type, "audio/wav");
    assert.equal(seen[0]!.bytes, 44 + SAMPLE_RATE * 2, "a 44 byte header and the samples");
  });
});

describe("what a reader is told", () => {
  const pcm = tone(SAMPLE_RATE / 2);

  it("keeps the service's own words, because they were written for this screen", async () => {
    // "The microphone recorded only silence; check that it works." is better
    // than anything covey could write from a status number alone.
    const { fetchImpl } = service({
      status: 422,
      body: { error: "silent-audio", message: "The microphone recorded only silence; check that it works." },
    });
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl }),
      (e: TranscribeError) => {
        assert.equal(e.code, "silent-audio");
        assert.match(e.message, /only silence/);
        return true;
      },
    );
  });

  it("writes its own sentence when the service answers with nothing useful", async () => {
    const { fetchImpl } = service({ status: 503, text: "<html>bad gateway</html>" });
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl }),
      (e: TranscribeError) => {
        assert.equal(e.code, "http-503");
        assert.match(e.message, /had a fault/);
        return true;
      },
    );
  });

  it("calls a machine with no service `unavailable`, never a failure", async () => {
    // The client reads this one as "do it yourself". A machine nobody set a
    // service up on is not a broken machine.
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: null }),
      (e: TranscribeError) => e.code === "unavailable",
    );

    const refused = (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    }) as unknown as typeof fetch;
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl: refused }),
      (e: TranscribeError) => e.code === "unavailable",
    );
  });

  it("names a service that never answered", async () => {
    const hangs = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl: hangs }),
      (e: TranscribeError) => e.code === "timeout",
    );
  });

  it("refuses an empty recording before it reaches the service", async () => {
    const { fetchImpl, seen } = service({ status: 200, body: { text: "x" } });
    await assert.rejects(
      transcribe({ audio: "", codec: "ima-adpcm", sampleRate: SAMPLE_RATE, samples: 0 },
        { url: "http://box:8790", fetchImpl }),
      (e: TranscribeError) => e.code === "audio-empty",
    );
    assert.equal(seen.length, 0, "nothing should have gone over the wire");
  });

  it("treats words the service did not find as `no-speech`, not as an empty message", async () => {
    // An empty string sent to an agent as a turn is a turn nobody meant.
    const { fetchImpl } = service({ status: 200, body: { text: "   ", backend: "openai" } });
    await assert.rejects(
      transcribe(adpcmParams(pcm), { url: "http://box:8790", fetchImpl }),
      (e: TranscribeError) => e.code === "no-speech",
    );
  });
});
