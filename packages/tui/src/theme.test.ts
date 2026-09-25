import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THEME, T, THEMES, asThemeId, connColor, contrastRatio, relativeLuminance,
  selectionSurfaces, setTheme, sidebarRowSurfaces, themeFor, themeGeneration, themeId,
  type Palette,
} from "./theme.js";

/**
 * The selection has to be visible, and so does every mark, in every theme.
 *
 * Every assertion here is a computed ratio, never a remembered hex. The
 * palettes will change again, and a test that named `#aab4dc` would go on
 * passing after the change took the contrast away — which is exactly the
 * failure it exists to catch.
 *
 * Each rule runs over `THEMES`, not over `T`: a theme that fails one of them
 * is a theme a reader cannot use, and the list is what makes the check
 * complete rather than a set of colours somebody remembered to test.
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

test("the themes are a list with no repeated id, and the default is in it", () => {
  assert.ok(THEMES.length >= 2, "a picker with one row is not a picker");
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  assert.equal(THEMES[0]!.id, DEFAULT_THEME, "the default is the row the picker opens on");
  for (const t of THEMES) assert.ok(t.label && t.hint, `${t.id} needs a name and a line under it`);
});

test("every theme fills every colour, with a hex the contrast maths can read", () => {
  const keys = Object.keys(THEMES[0]!.palette) as (keyof Palette)[];
  for (const t of THEMES) {
    for (const k of keys) {
      assert.match(t.palette[k], /^#[0-9a-f]{6}$/, `${t.id}.${String(k)} is not a #rrggbb colour`);
    }
    assert.equal(Object.keys(t.palette).length, keys.length, `${t.id} has a key the others do not`);
  }
});

test("the selection background clears 3:1 over every surface it can land on", () => {
  for (const t of THEMES) {
    const surfaces = selectionSurfaces(t.palette);
    assert.ok(surfaces.length >= 6, "the surface list is what makes this test complete");
    for (const surface of surfaces) {
      const ratio = contrastRatio(t.palette.selectionBg, surface);
      assert.ok(ratio >= VISIBLE, `${t.id}: the selection over ${surface} is ${ratio.toFixed(2)}:1, under ${VISIBLE}:1`);
    }
  }
});

test("selected text is readable on the selection background", () => {
  for (const t of THEMES) {
    const ratio = contrastRatio(t.palette.selectionText, t.palette.selectionBg);
    assert.ok(ratio >= READABLE, `${t.id}: selected text is ${ratio.toFixed(2)}:1 on the selection, under ${READABLE}:1`);
  }
});

/**
 * The second, quieter half of the defect. The old selection tinted the
 * background and left every span its own colour, so `faint` sat at 1.49:1
 * inside the highlight: the dimmest text became unreadable exactly where the
 * reader was looking.
 *
 * This is the measurement of the reported symptom, kept against the default
 * palette so the report and the fix are checked against the same number. That
 * `highlightLine` now repaints the colour rather than painting behind it is
 * asserted in `lines.test.ts`.
 */
test("the reported symptom: a tint over a near-black surface is not a boundary", () => {
  const p = themeFor(DEFAULT_THEME).palette;
  const tint = "#2a2f45";
  for (const surface of [p.surface, p.surfaceAlt, p.userBg]) {
    assert.ok(contrastRatio(tint, surface) < 1.5, `${surface} was never a boundary`);
  }
  assert.ok(contrastRatio(p.faint, tint) < VISIBLE, "and the dimmest tier on it was unreadable");
});

/**
 * A machine's mark has to be legible, and the offline one most of all (#68).
 *
 * The states the sidebar can paint, so the loop is complete rather than a list
 * of the ones somebody remembered. `default` stands for `disconnected` and
 * `error`, which share a colour.
 */
const CONN_STATES = ["connected", "connecting", "disconnected", "error", "offline"] as const;

test("every machine mark clears 3:1 on both backgrounds a sidebar row has", () => {
  for (const t of THEMES) {
    for (const conn of CONN_STATES) {
      for (const surface of sidebarRowSurfaces(t.palette)) {
        const ratio = contrastRatio(connColor(conn, t.palette), surface);
        assert.ok(ratio >= VISIBLE, `${t.id}: a ${conn} machine is ${ratio.toFixed(2)}:1 on ${surface}, under ${VISIBLE}:1`);
      }
    }
  }
});

/**
 * The cursor row is the harder surface, and the one the first version of the
 * offline mark failed on: it used `faint`, which the test above this one
 * measures at 1.49:1 on that tint. The reader moving the cursor onto an offline
 * machine to retry it is exactly the moment its mark disappeared.
 */
test("the offline mark is not the dim tier the selection defect was reported for", () => {
  const p = themeFor(DEFAULT_THEME).palette;
  assert.ok(contrastRatio(p.faint, p.selection) < VISIBLE, "the dim tier on the cursor row is still unreadable");
  assert.ok(contrastRatio(connColor("offline", p), p.selection) >= VISIBLE,
    "so the machine the reader has to find and press enter on must not be painted in it");
});

/**
 * The tiers have to stay four tiers in every theme: two that carry words, one
 * for meta — a count, a relative time — and one that marks a rule or a hint
 * the reader is not meant to read first.
 *
 * `faint` is measured against `subtle` rather than against one number, because
 * a theme brings its own dim colour with it: Dracula's comment grey is legible
 * by design and sits at 3.03:1, which is a fine rule and a poor tier. What
 * would be wrong is a `faint` that reads as body text, or one no dimmer than
 * the tier above it. The default palette keeps the harder number, which is the
 * one the Rust client pins against its own window background
 * (`covey-grid/src/theme.rs`).
 */
test("the text tiers read the same way in every theme", () => {
  for (const t of THEMES) {
    const p = t.palette;
    const on = (c: string) => contrastRatio(c, p.background);
    for (const tier of [p.text, p.muted]) {
      assert.ok(on(tier) >= READABLE, `${t.id}: a body tier is ${on(tier).toFixed(2)}:1 on its own ground`);
    }
    assert.ok(on(p.subtle) >= VISIBLE, `${t.id}: the meta tier is ${on(p.subtle).toFixed(2)}:1, under ${VISIBLE}:1`);
    assert.ok(on(p.faint) < READABLE, `${t.id}: faint is ${on(p.faint).toFixed(2)}:1 and reads as body text`);
    assert.ok(on(p.faint) < on(p.subtle), `${t.id}: faint is no dimmer than the tier above it`);
    assert.ok(on(p.muted) <= on(p.text), `${t.id}: the tiers are out of order`);
  }
  assert.ok(contrastRatio(themeFor(DEFAULT_THEME).palette.faint, themeFor(DEFAULT_THEME).palette.background) < VISIBLE,
    "and covey's own faint stays under the bar a mark has to clear");
});

/**
 * A message covey wrote is not the reader's, and the block that says so has to
 * be a block: its ground has to differ from the terminal's and from the
 * reader's own, and the colour on it has to be readable.
 */
test("a system message reads as its own block in every theme", () => {
  for (const t of THEMES) {
    const p = t.palette;
    assert.notEqual(p.systemBg, p.userBg, `${t.id}: covey's block is the reader's block`);
    assert.notEqual(p.systemBg, p.background, `${t.id}: covey's block has no ground of its own`);
    assert.ok(contrastRatio(p.system, p.systemBg) >= VISIBLE, `${t.id}: the mark on covey's block is under ${VISIBLE}:1`);
    assert.ok(contrastRatio(p.text, p.systemBg) >= READABLE, `${t.id}: the words on covey's block are under ${READABLE}:1`);
  }
});

test("setTheme rewrites the shared palette in place, and says when it did not", () => {
  const before = themeId();
  try {
    assert.equal(setTheme("gruvbox"), true);
    assert.equal(themeId(), "gruvbox");
    assert.equal(T.accent, themeFor("gruvbox").palette.accent);
    // Every pane holds this one object; a new object would leave them all on
    // the old colours.
    assert.equal(T.background, "#282828");
    const gen = themeGeneration();
    assert.equal(setTheme("no such theme"), false, "a name nothing knows changes nothing");
    assert.equal(themeId(), "gruvbox");
    assert.equal(themeGeneration(), gen, "and does not make the transcript lay itself out again");
    assert.equal(setTheme("gruvbox"), true);
    assert.equal(themeGeneration(), gen, "nor does picking the theme already painted");
    assert.equal(setTheme("nord"), true);
    assert.equal(themeGeneration(), gen + 1, "a real change is one the line cache can see");
  } finally {
    setTheme(before);
  }
});

test("asThemeId keeps a name a theme answers to and drops the rest", () => {
  assert.equal(asThemeId("nord"), "nord");
  assert.equal(asThemeId("Nord"), null, "ids are the stored form, not the label");
  assert.equal(asThemeId(undefined), null);
  assert.equal(asThemeId(7), null);
  assert.equal(themeFor("no such theme").id, DEFAULT_THEME, "an unknown name falls back rather than throwing");
});
