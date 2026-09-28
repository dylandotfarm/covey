/**
 * The store, as React reads it (issue #168).
 *
 * `useSyncExternalStore` over a version counter, not a copy of the state. The
 * state is one mutable object — the same one `@covey/web` mutates on the page —
 * and copying it per frame would cost more than the paint does. What React
 * needs is only to be told that *something* changed, and `store.schedule()`
 * tells it once per frame however many events arrived.
 */
import { useSyncExternalStore } from "react";
import { store } from "./store";

/** Re-render this component on the next frame that changed anything. */
export function useStore(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}
