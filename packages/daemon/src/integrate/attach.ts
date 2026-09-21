/**
 * Media on a pull request (#105): the rules, with no process and no network.
 *
 * GitHub shows a video or an image inline only when the file is a *user
 * attachment*, the kind the web form makes. A link to a release asset or to
 * a raw file in the repository stays a link. The route the web form uses is
 * `uploadAttachment` on `GhHost`; this file decides what may go up, how big
 * it may be, and where its URL lands in the body. Every rule here has a test.
 */

/** What GitHub renders inline, by extension, and the media type it is sent as. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The extensions `ATTACHMENT_TYPES` allows, in the order the message names them. */
export const ATTACHMENT_EXTENSIONS = Object.keys(ATTACHMENT_TYPES);

/** The plan of the account that owns the repository, as far as `gh` can read it. */
export type OwnerPlan = "free" | "paid" | "unknown";

/** GitHub's cap on one attachment, in bytes, by kind and plan. */
export const IMAGE_CAP_BYTES = 10 * 1024 * 1024;
export const VIDEO_CAP_FREE_BYTES = 10 * 1024 * 1024;
export const VIDEO_CAP_PAID_BYTES = 100 * 1024 * 1024;

/** One file the caller wants on the pull request, before any check. */
export interface AttachmentInput {
  /** The name GitHub shows, and the name a `{{attach:NAME}}` placeholder uses. */
  name: string;
  /** How big the file is. The caller reads it from disk. */
  bytes: number;
}

/** One file that passed every check and may be uploaded. */
export interface AttachmentPlan extends AttachmentInput {
  contentType: string;
  kind: "image" | "video";
}

/** One file after the upload: what goes into the body. */
export interface UploadedAttachment {
  name: string;
  kind: "image" | "video";
  url: string;
}

/** A refusal in words the agent can act on. Never a stack. */
export class AttachError extends Error {}

/** Bytes as a MB string with one decimal, so a cap reads as "10 MB" and a file as "12.4 MB". */
export function mb(n: number): string {
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/** The media type a name is sent as, or null when GitHub would not render it. */
export function contentTypeOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return ATTACHMENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The cap that applies to one media type under one plan. */
export function capFor(contentType: string, plan: OwnerPlan): number {
  if (!contentType.startsWith("video/")) return IMAGE_CAP_BYTES;
  return plan === "paid" ? VIDEO_CAP_PAID_BYTES : VIDEO_CAP_FREE_BYTES;
}

/**
 * Check every file before anything is uploaded or pushed. The first refusal
 * stops the whole request, so the agent fixes one thing and runs it again.
 */
export function planAttachments(inputs: AttachmentInput[], plan: OwnerPlan): AttachmentPlan[] {
  return inputs.map((a) => {
    const contentType = contentTypeOf(a.name);
    if (!contentType) {
      throw new AttachError(`cannot attach ${a.name}: GitHub renders only ${ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(", ")} inline`);
    }
    const cap = capFor(contentType, plan);
    if (a.bytes > cap) {
      const why = contentType.startsWith("video/")
        ? plan === "paid" ? "the cap for a video on a paid plan" : plan === "free" ? "the cap for a video on the free plan" : "the cap for a video on the free plan, which applies because the plan could not be read"
        : "the cap for an image";
      throw new AttachError(`cannot attach ${a.name}: it is ${mb(a.bytes)}, over ${mb(cap)}, ${why}. Re-encode it under the cap and try again`);
    }
    return { ...a, contentType, kind: contentType.startsWith("video/") ? "video" : "image" };
  });
}

/** The markdown that makes GitHub render one attachment inline. */
export function inlineMarkdown(u: UploadedAttachment): string {
  // A video is a bare URL on its own line, which is the markup the web form
  // makes. An image is an image tag, so the reader sees it and not a link.
  return u.kind === "video" ? u.url : `![${u.name}](${u.url})`;
}

/**
 * Put every upload into the body. A `{{attach:NAME}}` placeholder that names
 * a file is replaced where it stands; the rest go at the end, one per line,
 * in the order the caller gave them. A placeholder that names no file is an
 * error, because the reader would see the braces.
 */
export function placeAttachments(body: string, uploads: UploadedAttachment[]): string {
  const byName = new Map(uploads.map((u) => [u.name, u]));
  const placed = new Set<string>();
  let out = body.replace(/\{\{attach:([^}]+)\}\}/g, (whole, name: string) => {
    const u = byName.get(name.trim());
    if (!u) throw new AttachError(`the body names ${whole}, but no --attach gives a file called ${name.trim()}`);
    placed.add(u.name);
    return inlineMarkdown(u);
  });
  const rest = uploads.filter((u) => !placed.has(u.name)).map(inlineMarkdown);
  if (rest.length === 0) return out;
  out = out.trimEnd();
  return out ? `${out}\n\n${rest.join("\n\n")}` : rest.join("\n\n");
}

/** The words for an upload GitHub refused. The route is undocumented, so the answer is shown whole. */
export function describeUploadFailure(name: string, status: number, body: string, keptAt: string | null): string {
  const shown = body.trim().split("\n")[0]?.slice(0, 300) ?? "";
  const kept = keptAt ? ` The file is kept at ${keptAt};` : " ";
  return `GitHub refused the upload of ${name}: HTTP ${status}${shown ? ` ${shown}` : ""}.${kept} a person can drag it into the pull request by hand instead. Nothing was pushed and nothing was opened`;
}
