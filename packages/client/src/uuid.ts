/**
 * A random v4 uuid, on every runtime this client runs on.
 *
 * `crypto.randomUUID` exists in node and in a browser on a secure origin. A
 * phone that opens `http://100.x.y.z:3790/` is not on one, and there the
 * function is absent. `getRandomValues` is on every origin, so the uuid is
 * built from that when it has to be.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
