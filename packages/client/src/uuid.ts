/**
 * A random v4 uuid, on every runtime this client runs on.
 *
 * Three runtimes, and each has less than the one before:
 *
 * - **node** has `crypto.randomUUID`.
 * - **a browser** has it too, but only on a secure origin. A phone that opens
 *   `http://100.x.y.z:3790/` is not on one, and there the function is absent
 *   while `getRandomValues` is not, so the uuid is built from that.
 * - **React Native** has *no `crypto` global at all*. Hermes implements no Web
 *   Crypto and neither Expo nor React Native polyfills one, so the two branches
 *   above both throw before they can be tested.
 *
 * That last case is not hypothetical: it shipped. `client.ts` puts a
 * `commandId` on every command, so on the phone's app *every write* — a
 * message, a new thread, a rename, a setting — crashed the moment it was
 * attempted, while everything that only read went on working (#168).
 *
 * So the last resort is `Math.random`, and it is deliberately last. What it
 * costs is unpredictability, and nothing here needs any: a uuid in covey names
 * a thread, a turn, a command or a session, and a reader who can guess one
 * still has to get past the daemon's gate to use it. Guessing must never become
 * worth anything — if a uuid is ever made a credential, this fallback has to go
 * rather than be relied on.
 */
export function uuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
