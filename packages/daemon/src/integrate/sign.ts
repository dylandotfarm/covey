/**
 * Which thread wrote a comment, written into the comment.
 *
 * Every thread of one pull request writes from one GitHub account — the author,
 * each of its reviewers, and any thread that watches the number — so an author
 * login says nothing about which thread wrote which comment. The watch has to
 * know, because a thread must never hear its own words back as news: that is a
 * turn spent answering itself, and under `auto` a reviewer woken by its own
 * review never finishes.
 *
 * `WatchCursor.posted` was the first answer and is a memory rather than a fact.
 * It holds the URL `gh pr comment` printed, and a URL is on both sides only
 * when GitHub lists one: the comment comes back with `url` empty and the thread
 * hears itself. It is also a bounded list on the thread row, so it holds
 * nothing for a comment written before the watch started, nothing after a watch
 * is stopped and started again, and only the last `POSTED_KEPT`.
 *
 * So the answer is in the artefact instead. Covey writes the thread's id into
 * every comment it posts and the watch reads it back off the pull request;
 * nothing has to be remembered, and a thread resumed on another machine reads
 * the same answer. The cursor stays as the second half, because a comment covey
 * posted before this carries no signature.
 *
 * The marker is an HTML comment, so GitHub renders nothing: a reader sees the
 * words the agent wrote and the review tagline, and the id is in the source for
 * whatever reads it. Covey writes it and the agent never does, for the reason
 * the tagline is covey's (`integrate/review.ts`): a marker an agent had to
 * remember is a marker that one day reads differently.
 *
 * The id goes on a public pull request, so it may be read by anybody. A thread
 * id is a random UUID that names nothing outside the machine that made it —
 * it is already in `COVEY_THREAD_ID` and in the review brief — so there is
 * nothing in it to keep. Never sign with anything there is.
 */

/**
 * The word that opens the marker.
 *
 * Exact, and matched exactly: `signComment` writes it and `signedBy` reads it
 * back, so the two can never drift. Change it and every comment already on a
 * pull request stops naming its thread, so do not.
 */
const MARK = "covey-thread";

/**
 * The marker, at the start of its own line.
 *
 * Anchored with no leading space, which is the whole safety of it: an answer to
 * a comment quotes the comment, and `describeEvent` quotes with `  > `, so a
 * signature a thread was *shown* can never be read as a signature it wrote.
 */
const SIGNATURE = new RegExp(`^<!-- ${MARK}: ([^\\s>]{1,128}) -->$`, "gm");

/**
 * Put the thread's id at the end of a comment.
 *
 * It goes on after the review tagline, so the tagline stays the last line a
 * reader sees and this is the last line in the source.
 */
export function signComment(body: string, threadId: string): string {
  if (!threadId) return body;
  const words = body.replace(/\s+$/, "");
  const mark = `<!-- ${MARK}: ${threadId} -->`;
  return words ? `${words}\n\n${mark}` : mark;
}

/**
 * The thread that wrote a comment, or null when covey did not sign it.
 *
 * The last signature wins. Covey appends its own, so the last one is always
 * covey's, whatever an agent wrote into the body above it.
 */
export function signedBy(body: string): string | null {
  let id: string | null = null;
  for (const m of body.matchAll(SIGNATURE)) id = m[1]!;
  return id;
}

/**
 * A comment's body with the signature taken out, for a reader.
 *
 * GitHub renders an HTML comment as nothing, and covey's own markdown escapes
 * it (`packages/web/src/markdown.ts`), so the marker that is invisible on a
 * pull request would be a line of machine noise on the phone and in the
 * transcript. The watch reads the signed body and every reader gets this one.
 */
export function unsign(body: string): string {
  return body.replace(SIGNATURE, "").replace(/\s+$/, "");
}
