/**
 * Files, from a phone's own pickers (issue #168).
 *
 * The reading, the caps and the words for a failure are **not** here: they are
 * `readPicked` in `@covey/web/attach`, which both clients call. That is
 * deliberate and it is #132's lesson — one word for four problems is what made
 * a screenshot read as "unreadable" for weeks, and two clients with two copies
 * of that logic would drift back into it. `readPicked` is pure and node-tested,
 * and it takes the two things only a real device can do as arguments.
 *
 * So this file is the two arguments and nothing else:
 *
 *  - a `PickedFile` over what Android's pickers hand back, which is a URI
 *    rather than the bytes a browser gives;
 *  - a `Shrinker` over `expo-image-manipulator`, which is this platform's
 *    answer to `sips`, `magick` and a browser's canvas.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { MAX_IMAGE_BYTES, SHRINK_LONG_EDGE } from "@covey/protocol";
import type { PickedFile, Shrinker } from "@covey/web/attach";

/**
 * A picked file, and the URI it came from.
 *
 * `PickedFile` deliberately hides the path: the shared reader must not depend on
 * any platform's idea of one. But the shrinker does need it — this platform's
 * image tool takes a URI — and the pickers here are the only makers of these,
 * so the URI rides along under a name the shrinker can ask for.
 */
export interface DeviceFile extends PickedFile {
  uri: string;
}

/** The bytes behind a `file://` or `content://` URI. */
async function bytesOf(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/**
 * One picked file, as `readPicked` needs it.
 *
 * `bytes()` is a function and not a value on purpose: `readPicked` decides what
 * it will read, in the order it was picked, and stops at the cap. A phone that
 * read every photograph first would run out of memory before it got to the
 * check that would have refused them.
 */
function picked(f: { uri: string; name: string; mimeType?: string | null; size?: number | null }): DeviceFile {
  return {
    uri: f.uri,
    name: f.name,
    type: f.mimeType ?? "",
    size: f.size ?? 0,
    bytes: () => bytesOf(f.uri),
  };
}

/** The last part of a URI, for a picker that named nothing. */
function nameOf(uri: string, fallback: string): string {
  const tail = decodeURIComponent(uri.split("?")[0] ?? "").split("/").pop() ?? "";
  return tail || fallback;
}

/**
 * The photo roll. Images and videos both, because covey carries both and the
 * reader should not have to know which picker they wanted.
 */
export async function pickMedia(): Promise<DeviceFile[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    // covey shrinks a photograph itself, with the API's own long edge, and a
    // picker that re-encoded first would cost quality for nothing.
    quality: 1,
    exif: false,
  });
  if (res.canceled) return [];
  return res.assets.map((a, i) => picked({
    uri: a.uri,
    name: a.fileName ?? nameOf(a.uri, `image-${i + 1}.jpg`),
    mimeType: a.mimeType,
    size: a.fileSize,
  }));
}

/** The camera, for the screenshot that is not on the roll yet. */
export async function pickCamera(): Promise<DeviceFile[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return [];
  const res = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });
  if (res.canceled) return [];
  return res.assets.map((a, i) => picked({
    uri: a.uri,
    name: a.fileName ?? nameOf(a.uri, `photo-${i + 1}.jpg`),
    mimeType: a.mimeType,
    size: a.fileSize,
  }));
}

/** Any file: a log, a diff, a PDF, whatever the reader has. */
export async function pickDocument(): Promise<DeviceFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return res.assets.map((a, i) => picked({
    uri: a.uri,
    name: a.name || nameOf(a.uri, `file-${i + 1}`),
    mimeType: a.mimeType,
    size: a.size,
  }));
}

/**
 * The two passes, longest edge and JPEG quality, in the order they are tried —
 * the same two the web client's `shrink.ts` uses, and for the same reason.
 *
 * Scaling comes before quality because heavy JPEG is what makes a screenshot's
 * text illegible, and `SHRINK_LONG_EDGE` is the API's own long edge, so the
 * first pass costs nothing the model would have read.
 */
const PASSES: [number, number][] = [[SHRINK_LONG_EDGE, 0.85], [Math.round(SHRINK_LONG_EDGE / 2), 0.7]];

/**
 * Bring a photograph under `MAX_IMAGE_BYTES`, or answer null.
 *
 * Null is not a failure: `readPicked` reads it as "this still travels, and the
 * model will be told it is a file rather than a picture", which is the rule the
 * TUI keeps for an image no tool could shrink.
 */
export const shrinkOnDevice: Shrinker = async (file: PickedFile) => {
  // Every file that reaches here came from a picker above, so it is a
  // `DeviceFile`. The check is what makes that an assumption the code states
  // rather than one it relies on.
  const { uri } = file as DeviceFile;
  if (typeof uri !== "string" || !uri) return null;
  for (const [edge, compress] of PASSES) {
    try {
      const ref = await ImageManipulator.manipulate(uri).resize({ width: edge }).renderAsync();
      // JPEG: the one encoding every phone writes, and a media type the API
      // reads. A photograph has no transparency to lose.
      const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress });
      const bytes = await bytesOf(out.uri);
      if (bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes, mimeType: "image/jpeg" };
    } catch {
      // A file this device cannot decode. The next pass will not decode it
      // either, so stop rather than spend the second one finding out.
      return null;
    }
  }
  return null;
};
