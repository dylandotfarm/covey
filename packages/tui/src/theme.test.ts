import { test } from "node:test";
import assert from "node:assert/strict";
import { T, SELECTION_SURFACES, contrastRatio, relativeLuminance } from "./theme.js";

/**
 * The selection has to be visible.
 *
 * Every assertion here is a computed ratio, never a remembered hex. The
 * palette will change again, and a test that names `#aab4dc` would go on
 * passing after the change took the contrast away — which is exactly the
 * failure it exists to catch.
 */

/** Below this a boundary is not one a person can find. WCAG 2 non-text. */
const VISIBLE = 3;
/** Body text wants more than a boundary does. WCAG 2 AA for normal text. */
const READABLE = 4.5;

test("contrastRatio agrees with the two ends of the scale", () => {
  // The formula itself, so a wrong answer below is a wrong colour and not a
  // wrong function.
  assert.equal(Number(contrastRatio("#000000", "#ffffff").toFixed(2)), 21);
  assert.equal(contrastRatio("#7c87ff", "#7c87ff"), 1);
  assert.equal(Number(relativeLuminance("#ffffff").toFixed(4)), 1);
  assert.equal(relativeLuminance("#000000"), 0);
});

test("the selection background clears 3:1 over every surface it can land on", () => {
  assert.ok(SELECTION_SURFACES.length >= 5, "the surface list is what makes this test complete");
  for (const surface of SELECTION_SURFACES) {
    const ratio = contrastRatio(T.selectionBg, surface);
    assert.ok(ratio >= VISIBLE, `selection over ${surface} is ${ratio.toFixed(2)}:1, under ${VISIBLE}:1`);
  }
});

test("selected text is readable on the selection background", () => {
  const ratio = contrastRatio(T.selectionText, T.selectionBg);
  assert.ok(ratio >= READABLE, `selected text is ${ratio.toFixed(2)}:1 on the selection, under ${READABLE}:1`);
});

/**
 * The second, quieter half of the defect. The old selection tinted the
 * background and left every span its own colour, so `T.faint` sat at 1.49:1
 * inside the highlight: the dimmest text became unreadable exactly where the
 * reader was looking.
 *
 * This is the measurement of the reported symptom, kept so the report and the
 * fix are checked against the same number. That `highlightLine` now repaints
 * the colour rather than painting behind it is asserted in `lines.test.ts`.
 */
test("the reported symptom: a tint over a near-black surface is not a boundary", () => {
  const tint = "#2a2f45";
  for (const surface of [T.surface, T.surfaceAlt, T.userBg]) {
    assert.ok(contrastRatio(tint, surface) < 1.5, `${surface} was never a boundary`);
  }
  assert.ok(contrastRatio(T.faint, tint) < VISIBLE, "and the dimmest tier on it was unreadable");
});
