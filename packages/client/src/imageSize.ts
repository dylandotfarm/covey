/**
 * The width and the height of an image, read from its own first bytes.
 *
 * Covey has to know these because the API has *two* image limits and only one
 * of them is a size in bytes. `MAX_IMAGE_BYTES` is what one image may weigh;
 * `MAX_IMAGE_EDGE` is how long either edge may be in a request that carries
 * many images — and a long conversation is always such a request. A 4096x3072
 * photograph off a phone is 1.5 MB, so it sails past the byte cap untouched,
 * and then every turn of that thread is refused with
 * `At least one of the image dimensions exceed max allowed size for
 * many-image requests: 3000 pixels` (#236).
 *
 * The header and never the pixels. Every format below states its size in the
 * first few dozen bytes, so this is a read of a prefix and a little arithmetic
 * — no decoder, nothing held in memory, and nothing platform-specific. That is
 * what lets the terminal, the page and the phone ask one question and get one
 * answer, which is the whole point: a photograph that the TUI scales and the
 * page does not is covey with two minds about the same file.
 *
 * Answering `null` is a real answer and means "covey could not tell". Every
 * caller reads it as "leave the file alone", which is what covey did before
 * this existed — a parser that guessed would scale pictures nobody asked it to.
 */
import { MAX_IMAGE_EDGE } from "@covey/protocol";

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * True when an image of this shape is one the API will refuse once the
 * conversation holds a few more pictures.
 *
 * It takes the two edges and not an `ImageSize`, because the callers come by
 * them differently: a picker on the phone reports them, and everywhere else
 * `imageSizeOfBytes` reads them. An edge nobody could name is `undefined` and
 * answers false — covey scales what it has measured and never what it guessed.
 */
export function overImageEdge(width?: number, height?: number): boolean {
  return (width ?? 0) > MAX_IMAGE_EDGE || (height ?? 0) > MAX_IMAGE_EDGE;
}

/** The markers that carry no length, so the walk steps over them by one. */
function standaloneJpegMarker(m: number): boolean {
  return m === 0x01 || (m >= 0xd0 && m <= 0xd9);
}

/**
 * A JPEG states its size in a start-of-frame segment, which sits behind every
 * EXIF block, colour profile and thumbnail the camera wrote — so this walks the
 * segment chain rather than reading a fixed offset, and gives up at the end of
 * what it was handed rather than reading past it.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; } // resynchronise: a padded segment
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // fill byte before the real marker
    if (standaloneJpegMarker(marker)) { i += 2; continue; }
    // C4 is a Huffman table, C8 is reserved and CC is an arithmetic table.
    // Every other C0..CF is a frame, and they all start precision, height,
    // width — progressive and lossless included.
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) return null; // a length that cannot advance: a broken file
    i += 2 + length;
  }
  return null;
}

/**
 * WebP is three formats under one wrapper, and they state the size three ways:
 * lossy carries it after the sync code, lossless packs two 14-bit fields into
 * four bytes, and the extended form opens with a 24-bit canvas. A file covey
 * read only the first of would be one whose size it got wrong for the other
 * two, so all three are here.
 */
function webpSize(b: Uint8Array): ImageSize | null {
  const tag = String.fromCharCode(...b.subarray(12, 16));
  if (tag === "VP8 " && b.length >= 30) {
    return { width: ((b[27]! << 8) | b[26]!) & 0x3fff, height: ((b[29]! << 8) | b[28]!) & 0x3fff };
  }
  if (tag === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (tag === "VP8X" && b.length >= 30) {
    return {
      width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
      height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
    };
  }
  return null;
}

/**
 * The size of an image, or null when these bytes are not one covey can read.
 *
 * `bytes` may be the whole file or only its front: nothing here reads further
 * than a header, so a caller holding a 20 MB photograph on disk may hand over
 * the first slice of it instead.
 */
export function imageSizeOfBytes(bytes: Uint8Array): ImageSize | null {
  const b = bytes;
  if (b.length < 16) return null;
  // PNG: the signature, then IHDR, whose first two fields are the size.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    const read = (at: number) => (b[at]! << 24 | b[at + 1]! << 16 | b[at + 2]! << 8 | b[at + 3]!) >>> 0;
    return { width: read(16), height: read(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  // GIF: the logical screen descriptor, little-endian, right behind the magic.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  }
  if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    return webpSize(b);
  }
  return null;
}

/**
 * How much of a file covey reads to ask the question.
 *
 * A PNG, a GIF and a WebP answer inside the first fifty bytes. A JPEG does not:
 * its frame sits behind whatever the camera wrote first, and a phone writes an
 * EXIF block with a thumbnail in it. 512 KB clears that with room to spare and
 * is still nothing beside the file — and a header this does not reach answers
 * null, which leaves the file alone rather than scaling it on a guess.
 */
export const IMAGE_HEADER_BYTES = 512 * 1024;
