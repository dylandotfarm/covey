/**
 * Every screen, and what it takes (issue #168).
 *
 * The web client keeps what is on screen in `location.hash` so the browser's back
 * control, a swipe from the edge and a reload all read the same thing. An app has
 * a navigation stack instead, and it does the same job better: Android's back
 * gesture and its back button are the stack's own.
 *
 * Two of these screens are here because of that, and they are the point:
 *
 *  - `Media` is a *screen*, so a picture is a step in the stack and the back
 *    gesture shuts it. That is #167's whole lesson — a picture outside the route
 *    meant one gesture shut nothing and skipped a level.
 *  - `Sheet` is a screen too. On the page the settings sheet is *not* a layer
 *    yet and has exactly that bug, because it has pages of its own so back
 *    inside it means more than one thing. Here the stack holds it and back means
 *    one thing again.
 *
 * Unlike the page, `Media` may name the picture: a route parameter is not an
 * address bar, so a token in the source cannot be written into a history a
 * person can read.
 */
import type { SheetTarget } from "@covey/web";

export type Routes = {
  /** Projects and their conversations. The screen with no parameters. */
  List: undefined;
  Thread: { machine: string; threadId: string };
  /** An issue or a pull request (#108), over the thread or the list it came from. */
  Item: { machine: string; projectId: string; number: number };
  Media: { src: string; alt: string };
  Settings: undefined;
  AddMachine: undefined;
  Sheet: { target: SheetTarget };
};
