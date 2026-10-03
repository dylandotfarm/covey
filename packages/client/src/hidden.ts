import { threadIsHidden, type Thread } from "@covey/protocol";

/** What the hidden-threads switch reads as: its label, and the line under it. */
export interface HiddenPanel {
  label: string;
  hint: string;
}

/**
 * The switch that paints the threads covey hides, in the words every client
 * uses (#196).
 *
 * One function and not three labels. The TUI, the page and the app all offer
 * this switch, and each wrote its own sentence for it until the three had
 * drifted — "2 automated reviews hidden" on one screen against "2 hidden now"
 * on another, about the same two threads. A reader who keeps covey open on a
 * laptop and a phone reads that as two features.
 *
 * It lives here rather than in `@covey/web` because the TUI cannot import that:
 * `client` is what all three share. It takes plain threads for the same reason —
 * every client keeps its machines in a shape of its own, and none of those
 * shapes is this function's business.
 *
 * The hint counts what is hidden right now, because a switch over nothing reads
 * as a bug, and it names the one case the switch does not cover: a hidden thread
 * that needs the reader is never hidden.
 */
export function hiddenPanel(threads: Iterable<Thread>, showHidden: boolean): HiddenPanel {
  if (showHidden) return { label: "Hidden threads: shown", hint: "painted under the threads they review" };
  let n = 0;
  for (const t of threads) if (threadIsHidden(t, false) && !t.archivedAt && !t.movedTo) n++;
  return {
    label: "Hidden threads: hidden",
    hint: n === 0 ? "covey's automated reviewers, when it has any" : `${n} hidden now; one that needs you is never hidden`,
  };
}
