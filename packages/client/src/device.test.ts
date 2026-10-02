import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADPCM_BLOCK_BYTES, ADPCM_BLOCK_SAMPLES, DeviceState, Down, FRAME_HEADER, MAX_TITLE_BYTES,
  MIN_PAYLOAD, Reassembler, SAMPLE_RATE, TextKind, Up, adpcmFromPcm, fragments, loudness,
  pcmFromAdpcm, readAck, readAudio, readHello, readSelect, readState, readStatus, readText, readThreads,
  usablePayload, wavFromPcm16, writeAck, writeState, writeText, writeThreads,
} from "./device.js";

/** Put a message through the wire and take it off again. */
function roundTrip(type: number, body: Uint8Array, payload: number, id = 7): Uint8Array {
  const r = new Reassembler();
  let out: Uint8Array | null = null;
  for (const f of fragments(type, body, payload, id)) {
    const got = r.push(f);
    if (got) {
      assert.equal(got.type, type);
      out = got.body;
    }
  }
  assert.ok(out, "the message never completed");
  return out;
}

/** A tone, as something with a shape the codec has to follow. */
function tone(samples: number, hz = 440, amp = 12000): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
  return pcm;
}

describe("frames", () => {
  it("carries a message of no bytes as one fragment", () => {
    const f = fragments(Up.hello, new Uint8Array(0), 100, 1);
    assert.equal(f.length, 1);
    assert.equal(f[0].length, FRAME_HEADER);
    assert.deepEqual(roundTrip(Up.hello, new Uint8Array(0), 100), new Uint8Array(0));
  });

  it("round-trips a long message at every payload a connection may agree", () => {
    const body = new Uint8Array(5000).map((_, i) => (i * 31) & 0xff);
    for (const payload of [MIN_PAYLOAD, 23, 64, 185, 244, 512]) {
      const got = roundTrip(0x42, body, payload);
      assert.deepEqual(got, body, `payload ${payload}`);
      for (const f of fragments(0x42, body, payload, 1)) assert.ok(f.length <= payload);
    }
  });

  it("drops a half-built message when the next one starts, and counts it", () => {
    const r = new Reassembler();
    const first = fragments(Up.audio, new Uint8Array(900), 100, 1);
    assert.ok(first.length > 2);
    // The tail of the first message never arrives.
    for (const f of first.slice(0, 2)) assert.equal(r.push(f), null);
    const second = fragments(Up.audio, new Uint8Array([1, 2, 3]), 100, 2);
    const got = r.push(second[0]);
    assert.ok(got, "the second message should complete on its own");
    assert.deepEqual(got.body, new Uint8Array([1, 2, 3]));
    assert.equal(r.dropped, 1);
  });

  it("refuses a continuation that belongs to another message", () => {
    const r = new Reassembler();
    const a = fragments(Up.audio, new Uint8Array(300), 100, 1);
    const b = fragments(Up.audio, new Uint8Array(300), 100, 2);
    assert.equal(r.push(a[0]), null);
    // A fragment of message 2 that is not its first: nothing to join it to.
    assert.equal(r.push(b[1]), null);
    // And the half-built message is gone, so message 1's tail finds no home.
    assert.equal(r.push(a[1]), null);
  });

  it("takes three bytes off the MTU, and never goes under the floor", () => {
    assert.equal(usablePayload(517), 514);
    assert.equal(usablePayload(23), MIN_PAYLOAD);
    assert.equal(usablePayload(null), MIN_PAYLOAD);
    assert.equal(usablePayload(0), MIN_PAYLOAD);
  });
});

describe("bodies", () => {
  it("round-trips a thread list, and marks what is busy", () => {
    const threads = [
      { title: "Bluetooth pairing for the phone", busy: true },
      { title: "A notice says why", busy: false },
    ];
    const got = readThreads(roundTrip(Down.threads, writeThreads(3, threads), 64));
    assert.deepEqual(got, { generation: 3, threads });
  });

  it("cuts a long title on a character and never inside one", () => {
    // Every one of these is three bytes, so the cut lands mid-character unless
    // the writer steps back. Half a character paints as a replacement mark.
    const title = "難".repeat(40);
    const got = readThreads(writeThreads(1, [{ title, busy: false }]));
    assert.ok(got);
    assert.ok(!got.threads[0].title.includes("�"), "a character was cut in half");
    assert.equal(got.threads[0].title, "難".repeat(Math.floor(MAX_TITLE_BYTES / 3)));
  });

  it("round-trips text, state and an acknowledgement", () => {
    const text = readText(roundTrip(Down.text, writeText(TextKind.reply, "I read the file. 🙂"), 24));
    assert.deepEqual(text, { kind: TextKind.reply, text: "I read the file. 🙂" });
    assert.equal(readState(writeState(DeviceState.busy)), DeviceState.busy);
    assert.deepEqual(readAck(writeAck(false, "No machine holds that thread.")), {
      ok: false,
      text: "No machine holds that thread.",
    });
  });

  it("reads a hello, an utterance, a selection and a status the firmware wrote", () => {
    // Bytes exactly as `device_proto.c` lays them out.
    const hello = new Uint8Array([
      1, 0, 2, 0, 200, 0, 200, 0, 0x80, 0x3e, 0, 0, 0, 1, 5, 0,
      ...[..."covey"].map((c) => c.charCodeAt(0)),
    ]);
    assert.deepEqual(readHello(hello), {
      protocol: 1, firmware: "0.2.0", width: 200, height: 200,
      sampleRate: 16000, blockBytes: 256, name: "covey",
    });

    const audio = new Uint8Array([0xe8, 3, 0, 0, 0x80, 0x3e, 0, 0, 0x10, 0x27, 0, 0, 0, 1, 0, 0, 9, 9]);
    assert.deepEqual(readAudio(audio), {
      durationMs: 1000, sampleRate: 16000, samples: 10000, blockBytes: 256,
      audio: new Uint8Array([9, 9]),
    });

    assert.deepEqual(readSelect(new Uint8Array([3, 0, 5, 0])), { generation: 3, index: 5 });
    assert.deepEqual(readStatus(new Uint8Array([84, 0x10, 0x27, 0, 0, 0, 0, 8, 0])), {
      battery: 84, upMs: 10000, freeHeap: 524288,
    });
  });

  it("answers null for a body too short to trust, rather than a wrong reading", () => {
    assert.equal(readHello(new Uint8Array(4)), null);
    assert.equal(readAudio(new Uint8Array(8)), null);
    assert.equal(readSelect(new Uint8Array(2)), null);
    assert.equal(readStatus(new Uint8Array(3)), null);
    assert.equal(readThreads(new Uint8Array(2)), null);
    // A count that promises more rows than the body holds.
    assert.equal(readThreads(new Uint8Array([1, 0, 9, 0])), null);
  });
});

describe("audio", () => {
  it("holds a block's worth of samples per block", () => {
    assert.equal(ADPCM_BLOCK_SAMPLES, 505);
    const pcm = tone(ADPCM_BLOCK_SAMPLES * 4);
    const blocks = adpcmFromPcm(pcm);
    assert.equal(blocks.length, ADPCM_BLOCK_BYTES * 4);
    assert.equal(pcmFromAdpcm(blocks).length, pcm.length);
  });

  it("costs about a quarter of what the samples cost", () => {
    const pcm = tone(SAMPLE_RATE); // one second
    const blocks = adpcmFromPcm(pcm);
    const ratio = blocks.length / (pcm.length * 2);
    assert.ok(ratio > 0.24 && ratio < 0.27, `ratio ${ratio}`);
  });

  it("round-trips a tone closely enough to hear the words", () => {
    const pcm = tone(SAMPLE_RATE / 2);
    const back = pcmFromAdpcm(adpcmFromPcm(pcm), ADPCM_BLOCK_BYTES, pcm.length);
    assert.equal(back.length, pcm.length);
    let signal = 0;
    let noise = 0;
    for (let i = 0; i < pcm.length; i++) {
      signal += pcm[i] * pcm[i];
      const d = pcm[i] - back[i];
      noise += d * d;
    }
    const snr = 10 * Math.log10(signal / noise);
    assert.ok(snr > 20, `signal to noise ${snr.toFixed(1)} dB is too low to transcribe`);
  });

  it("keeps a damaged block from costing the rest of the sentence", () => {
    const pcm = tone(ADPCM_BLOCK_SAMPLES * 5);
    const blocks = adpcmFromPcm(pcm);
    // Ruin the second block, as a radio would.
    blocks.fill(0xff, ADPCM_BLOCK_BYTES, ADPCM_BLOCK_BYTES * 2);
    const back = pcmFromAdpcm(blocks, ADPCM_BLOCK_BYTES, pcm.length);
    assert.equal(back.length, pcm.length);
    const wrong = (from: number, upto: number) => {
      let n = 0;
      for (let i = from; i < upto; i++) if (Math.abs(pcm[i] - back[i]) > 2000) n++;
      return n / (upto - from);
    };
    assert.ok(wrong(ADPCM_BLOCK_SAMPLES, ADPCM_BLOCK_SAMPLES * 2) > 0.5, "the damaged block should be wrong");
    assert.ok(wrong(ADPCM_BLOCK_SAMPLES * 2, ADPCM_BLOCK_SAMPLES * 5) < 0.01, "the blocks after it should not be");
  });

  it("stops a part block where the device stopped recording", () => {
    const pcm = tone(700); // one whole block and a short one
    const blocks = adpcmFromPcm(pcm);
    // Told nothing, the decoder hands back the padding as well.
    assert.equal(pcmFromAdpcm(blocks).length, ADPCM_BLOCK_SAMPLES * 2);
    // Told what the device recorded, it stops there.
    assert.equal(pcmFromAdpcm(blocks, ADPCM_BLOCK_BYTES, pcm.length).length, pcm.length);
  });

  it("writes the one WAV header Android's recogniser accepts", () => {
    const wav = wavFromPcm16(new Int16Array([0, 1000, -1000]));
    const v = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    assert.equal(tag(0), "RIFF");
    assert.equal(tag(8), "WAVE");
    assert.equal(tag(12), "fmt ");
    assert.equal(v.getUint16(20, true), 1, "uncompressed PCM");
    assert.equal(v.getUint16(22, true), 1, "one channel");
    assert.equal(v.getUint32(24, true), 16000, "16 kHz");
    assert.equal(v.getUint16(34, true), 16, "16 bits a sample");
    assert.equal(tag(36), "data");
    assert.equal(v.getUint32(40, true), 6);
    assert.equal(v.getUint32(4, true), wav.length - 8);
    assert.equal(v.getInt16(46, true), 1000);
  });

  it("measures silence as nothing and a loud tone as most of the way up", () => {
    assert.equal(loudness(new Int16Array(100)), 0);
    const loud = loudness(tone(SAMPLE_RATE / 10, 440, 32000));
    assert.ok(loud > 0.6 && loud <= 1, `loudness ${loud}`);
  });
});
