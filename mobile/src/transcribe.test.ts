/**
 * Where speech is written out, and what happens when it cannot be.
 *
 * Both of this app's microphones are behind something node cannot start — a
 * Bluetooth radio and Android's own recogniser — so this file is the only
 * place the rule is held to. What it measures is the decision and not the
 * platform: which recording goes on the wire, which machine is asked, and
 * which of the three answers sends the phone back to its own recogniser.
 *
 * The one that matters most is the narrow one. `unavailable` means the machine
 * has nothing set up and the phone should quietly do it itself; every other
 * failure keeps the service's own sentence, because those sentences were
 * written for a reader and "The words could not be made out." is what covey
 * would have said instead about all of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RATE, adpcmFromPcm, pcmFromAdpcm, type Utterance } from "@covey/client";
import type { MachineCapabilities, MachineInfo } from "@covey/protocol";
import {
  MAX_RECORDING_MS, askMachine, deviceRecording, machineWritesSpeech, phoneRecording,
  type Recording, type SpeechMachine,
} from "./transcribe";

function machine(transcribes?: boolean): MachineInfo {
  const capabilities = {
    claude: true, worktrees: true, moveThreads: true, providers: ["claude"],
    ...(transcribes === undefined ? {} : { transcribes }),
  } as MachineCapabilities;
  return { capabilities } as MachineInfo;
}

/** A tone, so a recording carries something a decoder can be measured on. */
function tone(samples: number): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE));
  return pcm;
}

/** A machine that answers, or fails the way the daemon fails. */
function fake(answer: { text: string; backend?: string } | { code: string; message: string }): {
  client: SpeechMachine;
  seen: Recording[];
} {
  const seen: Recording[] = [];
  const client: SpeechMachine = {
    async transcribe(params) {
      seen.push(params);
      if ("text" in answer) return { text: answer.text, backend: answer.backend ?? "openai", durationMs: 1000 };
      throw Object.assign(new Error(answer.message), { code: answer.code });
    },
  };
  return { client, seen };
}

test("a machine that said nothing about speech is still asked", () => {
  assert.equal(machineWritesSpeech(machine(undefined)), true, "a daemon too old to say");
  assert.equal(machineWritesSpeech(undefined), true, "a machine covey has no info for");
  assert.equal(machineWritesSpeech(machine(true)), true);
  assert.equal(machineWritesSpeech(machine(false)), false, "it said it has nothing set up");
});

test("the device's own blocks go on the wire unchanged", () => {
  const pcm = tone(2000);
  const blocks = adpcmFromPcm(pcm);
  const u: Utterance = {
    audio: blocks, sampleRate: SAMPLE_RATE, samples: pcm.length, blockBytes: 256, durationMs: 125,
  };
  const r = deviceRecording(u);
  assert.equal(r.codec, "ima-adpcm");
  assert.equal(r.samples, pcm.length, "the count of samples, or the end is padding nobody said");
  assert.equal(r.blockBytes, 256);
  assert.deepEqual(Buffer.from(r.audio, "base64"), Buffer.from(blocks), "re-encoded on the way out");
});

test("the phone sends the samples it recorded, and the count that bounds them", () => {
  const pcm = tone(1600);
  const r = phoneRecording(pcm, SAMPLE_RATE);
  assert.equal(r?.codec, "pcm16", "the protocol keeps pcm16 for a caller holding samples");
  assert.equal(r?.samples, 1600);
  assert.equal(r?.sampleRate, SAMPLE_RATE);
  const bytes = Buffer.from(r!.audio, "base64");
  assert.equal(bytes.length, 3200, "two bytes a sample, little endian");
  assert.equal(bytes.readInt16LE(2), pcm[1]);
});

test("a recording longer than covey carries is not sent at all", () => {
  // The cap is a length of time, so it is measured at a rate that makes three
  // minutes a few thousand samples. Encoding the real 5.8 MB twice would be
  // half the time this whole file takes, and would prove the same rule.
  const seconds = MAX_RECORDING_MS / 1000;
  assert.ok(phoneRecording(tone(100 * seconds), 100), "the cap itself still goes");
  assert.equal(phoneRecording(tone(100 * (seconds + 1)), 100), null);
  assert.equal(phoneRecording(new Int16Array(0), SAMPLE_RATE), null, "nothing was recorded");
});

test("the samples survive the round trip the device's codec makes of them", () => {
  // Not a test of the codec, which `device.test.ts` holds: a test that the two
  // routes describe the same audio, so one of them cannot be decoded as noise.
  const pcm = tone(1010);
  const u: Utterance = {
    audio: adpcmFromPcm(pcm), sampleRate: SAMPLE_RATE, samples: pcm.length, blockBytes: 256, durationMs: 63,
  };
  const r = deviceRecording(u);
  const back = pcmFromAdpcm(Uint8Array.from(Buffer.from(r.audio, "base64")), r.blockBytes, r.samples);
  assert.equal(back.length, pcm.length);
});

test("the machine's words are used, with the name of what wrote them", async () => {
  const { client, seen } = fake({ text: "  open the pull request  ", backend: "openai" });
  const answer = await askMachine(client, machine(true), phoneRecording(tone(1600)));
  assert.deepEqual(answer, { words: { text: "open the pull request", backend: "openai" } });
  assert.equal(seen.length, 1);
});

test("`unavailable` is the one failure the phone answers for itself", async () => {
  const { client, seen } = fake({ code: "unavailable", message: "This machine has nothing set up to write out speech." });
  assert.deepEqual(await askMachine(client, machine(true), phoneRecording(tone(1600))), { fallBack: true });
  assert.equal(seen.length, 1, "it had to ask to find out");
});

test("every other failure keeps the sentence the service wrote for the reader", async () => {
  const silence = "The microphone recorded only silence; check that it works.";
  const { client } = fake({ code: "no-speech", message: silence });
  assert.deepEqual(await askMachine(client, machine(true), phoneRecording(tone(1600))), { failed: silence });

  const { client: broken } = fake({ code: "http-500", message: "" });
  const answer = await askMachine(broken, machine(true), phoneRecording(tone(1600)));
  assert.ok("failed" in answer && answer.failed, "a failure with no sentence still gets one");
});

test("a machine with nothing set up is never sent an utterance", async () => {
  const { client, seen } = fake({ text: "never reached" });
  assert.deepEqual(await askMachine(client, machine(false), phoneRecording(tone(1600))), { fallBack: true });
  assert.deepEqual(await askMachine(undefined, machine(true), phoneRecording(tone(1600))), { fallBack: true });
  assert.deepEqual(await askMachine(client, machine(true), null), { fallBack: true });
  assert.equal(seen.length, 0, "the phone spent mobile data on an answer it knew");
});

test("a machine that heard no words leaves the phone its own", async () => {
  const { client } = fake({ text: "   " });
  assert.deepEqual(await askMachine(client, machine(true), phoneRecording(tone(1600))), { fallBack: true });
});
