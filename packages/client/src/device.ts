/**
 * The wire between a covey device and the phone (#178).
 *
 * A covey device is a small thing with two buttons and a screen that holds no
 * covey state of its own. It is a *peripheral of the app*: it records what a
 * person says, hands the bytes to the phone over Bluetooth Low Energy, and
 * paints whatever the phone sends back. The phone is already a covey client,
 * so the device reaches a daemon the same way the app does and needs to know
 * nothing about machines, tokens or sockets.
 *
 * Everything here is pure and node tests it, because the other end is C on an
 * ESP32-S3 and the two cannot be tested together. A decoder with a test is the
 * only thing that keeps the two implementations honest, so the firmware emits
 * its own bytes over the serial port and `device.test.ts` decodes those exact
 * bytes. See `docs/DEVICE.md`.
 *
 * Three decisions live here and nowhere else.
 *
 * **The frame.** A BLE notification is bounded by the ATT maximum transmission
 * unit, which the phone negotiates and which covey cannot choose. A thread
 * list, a reply and an utterance are all longer than that, so every message is
 * cut into fragments with a four-byte header. BLE keeps the order of what it
 * carries on one characteristic, so a fragment needs no index of its own — it
 * needs only to say that it starts a message and that it ends one. The message
 * id is what makes a lost fragment *visible*: a fragment whose id is not the id
 * being assembled throws the half-built message away rather than joining two
 * utterances into one.
 *
 * **The codec.** Audio is IMA ADPCM at 16 kHz, mono. Sixteen-bit samples would
 * be 32 kB for every second a person holds the button, and BLE carries about a
 * tenth of that, so a five-second question would take half a minute to arrive.
 * ADPCM is four bits a sample, costs the ESP32 almost nothing, and is the one
 * compression Android's own recogniser can be fed after one pass of arithmetic.
 * It is **block based** on purpose: every block carries its own predictor, so a
 * block covey could not read costs that block and not the rest of the sentence.
 *
 * **The format the phone must produce.** Android transcribes a *file*, and it
 * accepts exactly one shape of it: 16 kHz, 16-bit, one channel, PCM in a WAV
 * container. `wavFromPcm16` writes that and nothing else. Change the sample
 * rate here and the recogniser stops answering, so `SAMPLE_RATE` is the one
 * number the firmware and the app both read.
 */

/** The protocol this build speaks. The device sends its own in `Hello`. */
export const DEVICE_PROTOCOL = 1;

/**
 * The GATT service and its two characteristics.
 *
 * One characteristic each way. The device notifies on `UPLINK` and the phone
 * writes to `DOWNLINK`, so neither direction waits on the other and a reply can
 * go out while an utterance is still arriving.
 */
export const DEVICE_SERVICE_UUID = "c0be1000-7b2d-4f1a-9c3e-1d5a8f0b6e21";
export const DEVICE_UPLINK_UUID = "c0be1001-7b2d-4f1a-9c3e-1d5a8f0b6e21";
export const DEVICE_DOWNLINK_UUID = "c0be1002-7b2d-4f1a-9c3e-1d5a8f0b6e21";

/** What the device advertises itself as. The app scans for the service, not this. */
export const DEVICE_NAME_PREFIX = "covey";

/** Audio the recogniser accepts, and therefore audio the device must record. */
export const SAMPLE_RATE = 16000;

/** Bytes in one ADPCM block. 4 of header and 252 of nibbles is 505 samples. */
export const ADPCM_BLOCK_BYTES = 256;

/** Samples one block of `ADPCM_BLOCK_BYTES` holds. */
export const ADPCM_BLOCK_SAMPLES = 1 + (ADPCM_BLOCK_BYTES - 4) * 2;

/** The fragment header: type, flags, and the message id. */
export const FRAME_HEADER = 4;

/** Set on the fragment that starts a message. */
const FLAG_FIRST = 0x01;
/** Set on the fragment that ends one. A lone fragment carries both. */
const FLAG_LAST = 0x02;

/**
 * What the ATT payload is before the phone has negotiated anything.
 *
 * Every BLE stack starts at an MTU of 23 and three of those bytes are the ATT
 * header, so 20 is what a write is guaranteed to carry. covey never sends at
 * this size on purpose — it is the floor `fragments` falls back to when the
 * platform will not say what was agreed.
 */
export const MIN_PAYLOAD = 20;

/** Messages the device sends. */
export const Up = {
  /** Who the device is, sent as soon as the phone subscribes. */
  hello: 0x01,
  /** One utterance, whole, after the reader let the record button go. */
  audio: 0x02,
  /** The reader picked a thread out of the menu. */
  select: 0x03,
  /** Battery and uptime, so the app can say the device is alive. */
  status: 0x04,
} as const;

/** Messages the phone sends. */
export const Down = {
  /** The whole menu, replaced each time. */
  threads: 0x81,
  /** A line of text for the screen. */
  text: 0x82,
  /** What the open thread is doing. */
  state: 0x83,
  /** The answer to an utterance: covey took it, or covey could not. */
  ack: 0x84,
} as const;

/** What a line of text on the device is for. The device paints each its own way. */
export const TextKind = {
  /** The words covey heard. The reader checks them before the agent answers. */
  heard: 0,
  /** What the agent said. */
  reply: 1,
  /** Something went wrong, in words the reader can act on. */
  notice: 2,
  /** The name of the thread the device is pointed at. */
  thread: 3,
} as const;

/** What the open thread is doing, as the device paints it. */
export const DeviceState = {
  idle: 0,
  /** The phone is turning the recording into words. */
  hearing: 1,
  /** The agent is working. */
  busy: 2,
  /** The app is not connected to the machine that holds this thread. */
  away: 3,
} as const;

export type UpType = (typeof Up)[keyof typeof Up];
export type DownType = (typeof Down)[keyof typeof Down];

/** One message, after its fragments were put back together. */
export interface DeviceMessage {
  type: number;
  body: Uint8Array;
}

/* ------------------------------------------------------------------ frames */

/**
 * Cut one message into the fragments a characteristic can carry.
 *
 * `payloadBytes` is the ATT payload the connection agreed, not the MTU: a
 * platform reports the MTU and three of those bytes belong to ATT itself. Pass
 * what `usablePayload` worked out. A message of no bytes is still one fragment,
 * because `Hello` has a body and an acknowledgement may not.
 */
export function fragments(type: number, body: Uint8Array, payloadBytes: number, msgId: number): Uint8Array[] {
  const room = Math.max(1, payloadBytes - FRAME_HEADER);
  const out: Uint8Array[] = [];
  let at = 0;
  do {
    const take = Math.min(room, body.length - at);
    const frame = new Uint8Array(FRAME_HEADER + take);
    frame[0] = type & 0xff;
    frame[1] = (at === 0 ? FLAG_FIRST : 0) | (at + take >= body.length ? FLAG_LAST : 0);
    frame[2] = msgId & 0xff;
    frame[3] = (msgId >> 8) & 0xff;
    frame.set(body.subarray(at, at + take), FRAME_HEADER);
    out.push(frame);
    at += take;
  } while (at < body.length);
  return out;
}

/**
 * The ATT payload of a connection whose MTU is `mtu`.
 *
 * Three bytes of every ATT packet are the opcode and the handle. A platform
 * that will not say what the MTU is gets the floor every BLE stack starts at.
 */
export function usablePayload(mtu: number | null | undefined): number {
  if (!mtu || !Number.isFinite(mtu)) return MIN_PAYLOAD;
  return Math.max(MIN_PAYLOAD, Math.floor(mtu) - 3);
}

/**
 * Fragments back into messages.
 *
 * One of these per direction. It holds at most one half-built message, which is
 * what lets a fragment that does not belong throw the rest away: two utterances
 * joined end to end would reach the recogniser as one sentence and there would
 * be nothing in the words to say it had happened.
 */
export class Reassembler {
  private type = -1;
  private id = -1;
  private parts: Uint8Array[] = [];
  private held = 0;
  /** How many messages this dropped. The app shows it; a rising count is a bug. */
  dropped = 0;

  constructor(private readonly limit = 512 * 1024) {}

  /** Feed one fragment. Answers the message when the fragment completed one. */
  push(frame: Uint8Array): DeviceMessage | null {
    if (frame.length < FRAME_HEADER) {
      this.drop();
      return null;
    }
    const type = frame[0]!;
    const flags = frame[1]!;
    const id = frame[2]! | (frame[3]! << 8);
    const body = frame.subarray(FRAME_HEADER);

    if (flags & FLAG_FIRST) {
      if (this.parts.length) this.dropped++;
      this.type = type;
      this.id = id;
      this.parts = [];
      this.held = 0;
    } else if (this.parts.length === 0 || id !== this.id || type !== this.type) {
      // A continuation with nothing to continue, or one from another message.
      this.drop();
      return null;
    }

    this.held += body.length;
    if (this.held > this.limit) {
      this.drop();
      return null;
    }
    this.parts.push(body);

    if (!(flags & FLAG_LAST)) return null;

    const whole = new Uint8Array(this.held);
    let at = 0;
    for (const part of this.parts) {
      whole.set(part, at);
      at += part.length;
    }
    const message = { type: this.type, body: whole };
    this.clear();
    return message;
  }

  /** Throw away what was half built, and say that it happened. */
  private drop(): void {
    if (this.parts.length) this.dropped++;
    this.clear();
  }

  private clear(): void {
    this.type = -1;
    this.id = -1;
    this.parts = [];
    this.held = 0;
  }
}

/* ------------------------------------------------------------------ bodies */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A reader over a message body that answers `null` rather than throwing. */
class Cursor {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  left(n: number): boolean {
    return this.bytes.length - this.at >= n;
  }
  u8(): number {
    return this.bytes[this.at++]!;
  }
  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  /** A length-prefixed UTF-8 string. */
  str(): string {
    const n = this.u16();
    if (!this.left(n)) {
      this.at = this.bytes.length;
      return "";
    }
    const s = decoder.decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }
}

/** A writer that grows. Bodies here are small; a thread list is the largest. */
class Writer {
  private bytes = new Uint8Array(256);
  private at = 0;
  private room(n: number): void {
    if (this.at + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.at));
    this.bytes = next;
  }
  u8(v: number): this {
    this.room(1);
    this.bytes[this.at++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.room(2);
    this.bytes[this.at++] = v & 0xff;
    this.bytes[this.at++] = (v >> 8) & 0xff;
    return this;
  }
  u32(v: number): this {
    this.u16(v & 0xffff);
    this.u16((v >>> 16) & 0xffff);
    return this;
  }
  /**
   * A length-prefixed UTF-8 string, cut to `max` *bytes*.
   *
   * It cuts on a character and never inside one: half a character is a
   * replacement mark on the screen, which reads as a fault in the device.
   */
  str(s: string, max = 0xffff): this {
    let raw = encoder.encode(s);
    if (raw.length > max) {
      let end = max;
      while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--;
      raw = raw.subarray(0, end);
    }
    this.u16(raw.length);
    this.room(raw.length);
    this.bytes.set(raw, this.at);
    this.at += raw.length;
    return this;
  }
  done(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}

/** What the device said it is. */
export interface Hello {
  protocol: number;
  firmware: string;
  width: number;
  height: number;
  sampleRate: number;
  blockBytes: number;
  name: string;
}

/** Read a `Up.hello` body. Answers null when the body is too short to trust. */
export function readHello(body: Uint8Array): Hello | null {
  const c = new Cursor(body);
  if (!c.left(16)) return null;
  const protocol = c.u8();
  const major = c.u8();
  const minor = c.u8();
  const patch = c.u8();
  const width = c.u16();
  const height = c.u16();
  const sampleRate = c.u32();
  const blockBytes = c.u16();
  const name = c.str();
  return { protocol, firmware: `${major}.${minor}.${patch}`, width, height, sampleRate, blockBytes, name };
}

/** One utterance, as it came off the wire. */
export interface Utterance {
  /** How long the reader held the button, by the device's own clock. */
  durationMs: number;
  sampleRate: number;
  blockBytes: number;
  /**
   * Samples the device recorded.
   *
   * A block is a fixed 505 samples and an utterance ends whenever the reader
   * lets go, so the last block is almost never full. The device pads it, because
   * a block that starts anywhere but on its boundary is a block the decoder
   * cannot find — and then says here how many of those samples are real. Without
   * this number the recogniser is handed up to 31 ms of invented sound at the
   * end of every sentence.
   */
  samples: number;
  /** The ADPCM blocks. `pcmFromAdpcm` turns these into samples. */
  audio: Uint8Array;
}

/** Read a `Up.audio` body. */
export function readAudio(body: Uint8Array): Utterance | null {
  const c = new Cursor(body);
  if (!c.left(16)) return null;
  const durationMs = c.u32();
  const sampleRate = c.u32();
  const samples = c.u32();
  const blockBytes = c.u16();
  c.u16(); // reserved, so the header stays four-byte aligned on the device
  if (blockBytes < 5) return null;
  return { durationMs, sampleRate, samples, blockBytes, audio: body.subarray(c.at) };
}

/** Which thread the reader chose, and out of which menu. */
export interface Selection {
  /** The generation of the thread list this index belongs to. */
  generation: number;
  index: number;
}

/**
 * Read a `Up.select` body.
 *
 * The device answers with a *position*, not an id: an id is a UUID and the menu
 * is twenty of them, which is a kilobyte of radio time for something the phone
 * already knows. The generation is what makes the position safe — the app sent
 * the list and remembers which one, so a pick against a menu that has since
 * changed is refused rather than opening the wrong thread.
 */
export function readSelect(body: Uint8Array): Selection | null {
  const c = new Cursor(body);
  if (!c.left(4)) return null;
  return { generation: c.u16(), index: c.u16() };
}

/** What the device reports about itself while it runs. */
export interface DeviceStatus {
  /** Charge, 0 to 100. 255 when the device cannot measure it. */
  battery: number;
  upMs: number;
  freeHeap: number;
}

/** Read a `Up.status` body. */
export function readStatus(body: Uint8Array): DeviceStatus | null {
  const c = new Cursor(body);
  if (!c.left(9)) return null;
  return { battery: c.u8(), upMs: c.u32(), freeHeap: c.u32() };
}

/** One row of the device's menu. */
export interface DeviceThread {
  title: string;
  /** The thread is running a turn. The device marks it. */
  busy: boolean;
}

/** How many threads the menu carries, and how long a title may be. */
export const MAX_THREADS = 32;
/** Bytes, not characters: a title is cut on a character boundary. */
export const MAX_TITLE_BYTES = 48;

/**
 * Write a `Down.threads` body.
 *
 * The list is sent whole and replaces what the device held. A device with no
 * list of its own cannot fall out of step with the app, which is worth more
 * than the few hundred bytes a difference would save.
 */
export function writeThreads(generation: number, threads: DeviceThread[]): Uint8Array {
  const take = threads.slice(0, MAX_THREADS);
  const w = new Writer().u16(generation).u16(take.length);
  for (const t of take) w.u8(t.busy ? 1 : 0).str(t.title, MAX_TITLE_BYTES);
  return w.done();
}

/** Read a `Down.threads` body. The firmware does this; the test holds it. */
export function readThreads(body: Uint8Array): { generation: number; threads: DeviceThread[] } | null {
  const c = new Cursor(body);
  if (!c.left(4)) return null;
  const generation = c.u16();
  const count = c.u16();
  const threads: DeviceThread[] = [];
  for (let i = 0; i < count; i++) {
    if (!c.left(3)) return null;
    const busy = c.u8() === 1;
    threads.push({ title: c.str(), busy });
  }
  return { generation, threads };
}

/** Bytes of one line of text. More than this and the screen could not hold it. */
export const MAX_TEXT_BYTES = 2048;

/** Write a `Down.text` body. */
export function writeText(kind: number, text: string): Uint8Array {
  return new Writer().u8(kind).str(text, MAX_TEXT_BYTES).done();
}

/** Read a `Down.text` body. */
export function readText(body: Uint8Array): { kind: number; text: string } | null {
  const c = new Cursor(body);
  if (!c.left(3)) return null;
  return { kind: c.u8(), text: c.str() };
}

/** Write a `Down.state` body. */
export function writeState(state: number): Uint8Array {
  return new Writer().u8(state).done();
}

/** Read a `Down.state` body. */
export function readState(body: Uint8Array): number | null {
  return body.length >= 1 ? body[0]! : null;
}

/**
 * Write a `Down.ack` body.
 *
 * `ok` false carries why in `text`, and the device paints it. An utterance that
 * went nowhere must say so on the thing the reader is holding: the phone may be
 * in a pocket.
 */
export function writeAck(ok: boolean, text: string): Uint8Array {
  return new Writer().u8(ok ? 1 : 0).str(text, 256).done();
}

/** Read a `Down.ack` body. */
export function readAck(body: Uint8Array): { ok: boolean; text: string } | null {
  const c = new Cursor(body);
  if (!c.left(3)) return null;
  return { ok: c.u8() === 1, text: c.str() };
}

/* ------------------------------------------------------------------- audio */

/** IMA ADPCM, the step a nibble moves the index by. */
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** IMA ADPCM, the 89 step sizes. */
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

function clampSample(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function clampIndex(v: number): number {
  return v < 0 ? 0 : v > 88 ? 88 : v;
}

/**
 * Turn ADPCM blocks back into samples.
 *
 * Each block stands alone: it opens with the sample it starts from and the step
 * index to read the rest with, so a block that arrives damaged costs its own
 * 32 milliseconds and the sentence carries on. A trailing part block is read
 * for as many samples as its bytes hold.
 *
 * `samples` is what the device said it recorded. The last block is padded out
 * to its boundary, so without that count the decoder hands back up to 31 ms of
 * sound nobody made — `Utterance.samples` is where it comes from.
 */
export function pcmFromAdpcm(blocks: Uint8Array, blockBytes = ADPCM_BLOCK_BYTES, samples = 0): Int16Array {
  if (blockBytes < 5) return new Int16Array(0);
  const perBlock = 1 + (blockBytes - 4) * 2;
  const count = Math.ceil(blocks.length / blockBytes);
  const out = new Int16Array(count * perBlock);
  let wrote = 0;

  for (let b = 0; b < count; b++) {
    const start = b * blockBytes;
    const end = Math.min(start + blockBytes, blocks.length);
    if (end - start < 4) break;

    let predictor = ((blocks[start]! | (blocks[start + 1]! << 8)) << 16) >> 16;
    let index = clampIndex(blocks[start + 2]!);
    out[wrote++] = predictor;

    for (let i = start + 4; i < end; i++) {
      const byte = blocks[i]!;
      // Two samples to a byte, the earlier one in the low nibble. Unrolled
      // rather than looped over a pair, because a phone decodes this and an
      // array per byte is an allocation every 62 microseconds of speech.
      for (let half = 0; half < 2; half++) {
        const nibble = half === 0 ? byte & 0x0f : byte >> 4;
        const step = STEP_TABLE[index]!;
        let diff = step >> 3;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 4) diff += step;
        predictor = clampSample(nibble & 8 ? predictor - diff : predictor + diff);
        index = clampIndex(index + INDEX_TABLE[nibble]!);
        out[wrote++] = predictor;
      }
    }
  }
  return out.subarray(0, samples > 0 ? Math.min(samples, wrote) : wrote);
}

/**
 * Turn samples into ADPCM blocks.
 *
 * The device does this in C. This copy is what the test measures that one
 * against: it encodes, the firmware's own bytes decode, and the two paths meet
 * in the middle. It is also how `docs/DEVICE.md`'s figures were measured.
 */
export function adpcmFromPcm(pcm: Int16Array, blockBytes = ADPCM_BLOCK_BYTES): Uint8Array {
  if (blockBytes < 5 || pcm.length === 0) return new Uint8Array(0);
  const perBlock = 1 + (blockBytes - 4) * 2;
  const blocks = Math.ceil(pcm.length / perBlock);
  const out = new Uint8Array(blocks * blockBytes);
  let wrote = 0;
  let index = 0;

  for (let b = 0; b < blocks; b++) {
    const from = b * perBlock;
    const upto = Math.min(from + perBlock, pcm.length);
    let predictor = pcm[from]!;

    out[wrote++] = predictor & 0xff;
    out[wrote++] = (predictor >> 8) & 0xff;
    out[wrote++] = index;
    out[wrote++] = 0;

    let pending = -1;
    for (let i = from + 1; i < upto; i++) {
      const step = STEP_TABLE[index]!;
      let diff = pcm[i]! - predictor;
      let nibble = 0;
      if (diff < 0) {
        nibble = 8;
        diff = -diff;
      }
      let delta = step >> 3;
      if (diff >= step) {
        nibble |= 4;
        diff -= step;
        delta += step;
      }
      if (diff >= step >> 1) {
        nibble |= 2;
        diff -= step >> 1;
        delta += step >> 1;
      }
      if (diff >= step >> 2) {
        nibble |= 1;
        delta += step >> 2;
      }
      predictor = clampSample(nibble & 8 ? predictor - delta : predictor + delta);
      index = clampIndex(index + INDEX_TABLE[nibble]!);

      if (pending < 0) pending = nibble;
      else {
        out[wrote++] = pending | (nibble << 4);
        pending = -1;
      }
    }
    if (pending >= 0) out[wrote++] = pending;
    // Round up to the block, so every block starts where the reader expects.
    wrote = Math.min(out.length, (b + 1) * blockBytes);
  }
  return out.subarray(0, wrote);
}

/**
 * A RIFF WAV file around 16-bit samples.
 *
 * Android's recogniser takes a *file* and takes one shape of it: 16 kHz,
 * 16-bit, one channel. Hand it anything else and it answers `audio-capture`,
 * which reads as a broken microphone rather than a wrong header. So this writes
 * that one shape and takes the rate only so a test can prove the header.
 */
export function wavFromPcm16(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // the size of this chunk
  view.setUint16(20, 1, true); // 1 is uncompressed PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/**
 * The samples back out of a RIFF WAV.
 *
 * The other half of `wavFromPcm16`, and here for the same reason: there is one
 * definition of this format in covey and never a second copy. The phone's own
 * microphone records dictation to a file, and the samples have to come out of
 * that file before they can go on the wire to the daemon (#180).
 *
 * It walks the chunks rather than reading from byte 44. A 44-byte header is
 * what a plain writer happens to produce, not what the format says, and a
 * `LIST` chunk before `data` is legal — read it as audio and the reader hears
 * their own file name at the start of the sentence.
 *
 * `null` for anything that is not uncompressed 16-bit mono PCM, because a
 * wrong guess at the shape is a recording of noise and the caller has
 * something better to do with it: its own recogniser already heard the words.
 */
export function pcm16FromWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string =>
    String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let sampleRate = 0;
  let data: { at: number; bytes: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && size >= 16) {
      if (view.getUint16(body, true) !== 1) return null; // 1 is uncompressed PCM
      if (view.getUint16(body + 2, true) !== 1) return null; // one channel
      if (view.getUint16(body + 14, true) !== 16) return null; // bits per sample
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === "data") {
      // A file cut short — a recording the phone was killed in the middle of —
      // declares more than it holds, so the bytes that are there decide.
      data = { at: body, bytes: Math.min(size, bytes.length - body) };
    }
    // Every chunk is padded to an even length, and the pad byte is not its own.
    at = body + size + (size % 2);
  }
  if (!data || !sampleRate) return null;

  const count = Math.floor(data.bytes / 2);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = view.getInt16(data.at + i * 2, true);
  return { pcm, sampleRate };
}

/**
 * How loud an utterance is, as a number between 0 and 1.
 *
 * The app shows it so a reader who gets no words back can tell a microphone
 * that heard nothing from a recogniser that understood nothing — which are the
 * same silence on the screen and two different things to fix.
 */
export function loudness(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.min(1, Math.sqrt(sum / pcm.length) / 32768);
}
