import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_IMAGE_EDGE } from "@covey/protocol";
import { IMAGE_HEADER_BYTES, imageSizeOfBytes, overImageEdge } from "./imageSize.js";

/** A PNG header: the signature, then an IHDR carrying the two edges. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/**
 * A JPEG with `pad` bytes of segments in front of the frame, which is what an
 * EXIF block and a thumbnail are.
 */
function jpeg(width: number, height: number, pad = 0, marker = 0xc0): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (pad > 0) {
    // One APP1 segment of `pad` bytes, as a camera writes before the frame.
    parts.push(0xff, 0xe1, (pad >> 8) & 0xff, pad & 0xff, ...new Array(pad - 2).fill(0));
  }
  parts.push(0xff, marker, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push(...new Array(8).fill(0));
  return new Uint8Array(parts);
}

test("reads a PNG's two edges", () => {
  assert.deepEqual(imageSizeOfBytes(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSizeOfBytes(png(4096, 3072)), { width: 4096, height: 3072 });
});

test("reads a JPEG's frame from behind the camera's own segments", () => {
  assert.deepEqual(imageSizeOfBytes(jpeg(4096, 3072)), { width: 4096, height: 3072 });
  // The photograph that started this: the frame sits behind an EXIF block.
  assert.deepEqual(imageSizeOfBytes(jpeg(4096, 3072, 40_000)), { width: 4096, height: 3072 });
});

test("reads every kind of JPEG frame, not only the baseline one", () => {
  // Progressive (C2) and lossless (C3) state their size the same way, and a
  // reader that matched C0 alone would pass a progressive photograph through.
  for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcd]) {
    assert.deepEqual(imageSizeOfBytes(jpeg(3200, 2400, 0, marker)), { width: 3200, height: 2400 }, `marker ${marker.toString(16)}`);
  }
});

test("walks past a Huffman table rather than reading it as a frame", () => {
  // C4 is a table and carries no size. Read it as a frame and the answer is
  // whatever its first bytes happen to be.
  const b = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x0c, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assert.deepEqual(imageSizeOfBytes(b), { width: 4096, height: 3072 });
});

test("reads a GIF, little-endian", () => {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  b.set([0x00, 0x04, 0x00, 0x03], 6); // 1024 x 768
  assert.deepEqual(imageSizeOfBytes(b), { width: 1024, height: 768 });
});

test("reads all three kinds of WebP", () => {
  const riff = (tag: string, len: number) => {
    const b = new Uint8Array(len);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([...tag].map((c) => c.charCodeAt(0)), 12);
    return b;
  };
  const lossy = riff("VP8 ", 32);
  lossy.set([0x9d, 0x01, 0x2a], 23);
  lossy.set([0x00, 0x05, 0x00, 0x04], 26); // 1280 x 1024
  assert.deepEqual(imageSizeOfBytes(lossy), { width: 1280, height: 1024 });

  const lossless = riff("VP8L", 32);
  lossless[20] = 0x2f;
  // width-1 in bits 0..13, height-1 in bits 14..27.
  const bits = (1279) | (1023 << 14);
  lossless.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
  assert.deepEqual(imageSizeOfBytes(lossless), { width: 1280, height: 1024 });

  const extended = riff("VP8X", 32);
  extended.set([0xff, 0x04, 0x00], 24); // 1280 - 1
  extended.set([0xff, 0x03, 0x00], 27); // 1024 - 1
  assert.deepEqual(imageSizeOfBytes(extended), { width: 1280, height: 1024 });
});

test("answers null for what it cannot read, rather than a guess", () => {
  assert.equal(imageSizeOfBytes(new Uint8Array(0)), null);
  assert.equal(imageSizeOfBytes(new Uint8Array(8)), null);
  assert.equal(imageSizeOfBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new Array(32).fill(0)])), null); // a PDF
  // A JPEG whose frame is further in than the caller read: null, not a wrong
  // answer, so the file is left alone.
  assert.equal(imageSizeOfBytes(jpeg(4096, 3072, 40_000).subarray(0, 1024)), null);
});

test("a length that cannot advance ends the walk instead of hanging", () => {
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, ...new Array(32).fill(0)]);
  assert.equal(imageSizeOfBytes(b), null);
});

test("overImageEdge reads either edge, and an unknown one as no", () => {
  assert.equal(overImageEdge(4096, 3072), true);
  assert.equal(overImageEdge(3072, 4096), true, "the long edge may be the height");
  assert.equal(overImageEdge(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), false, "the limit itself passes");
  assert.equal(overImageEdge(MAX_IMAGE_EDGE + 1, 10), true);
  assert.equal(overImageEdge(2576, 1932), false, "what SHRINK_LONG_EDGE leaves");
  assert.equal(overImageEdge(undefined, undefined), false, "covey measured nothing, so it scales nothing");
  assert.equal(overImageEdge(undefined, 4096), true, "one edge is enough to refuse");
});

test("the header slice is big enough for a phone's EXIF block", () => {
  assert.ok(IMAGE_HEADER_BYTES > 64 * 1024);
});
