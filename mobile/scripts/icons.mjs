/**
 * The app's icons, rendered from covey's one mark.
 *
 * `packages/web/static/icon.svg` is that mark — three circles in covey's accent
 * on covey's background, which the page has installed with since it was
 * installable. The app wears the same one. It is not *copied* here, because a
 * second drawing of a logo is a logo that goes out of step the first time
 * somebody moves a circle: this script reads that file and writes the PNGs
 * Android needs from it.
 *
 *   node scripts/icons.mjs        # rewrites mobile/assets/*.png
 *
 * Run it when the mark changes, and never otherwise — the PNGs are committed,
 * because `expo prebuild` and the gradle build both want them on disk and
 * neither is going to run a renderer. CI does not run this.
 *
 * There is no SVG library and no `rsvg-convert` here, and neither is worth a
 * dependency for one file of four shapes: this reads the handful of attributes
 * that file actually uses and samples the shapes directly. It is deliberately
 * *not* a renderer — an SVG feature the mark does not use is one this script is
 * entitled to ignore, and it says so by failing rather than by drawing
 * something wrong.
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(app, "..", "packages", "web", "static", "icon.svg");

// ---- reading the mark -------------------------------------------------------

/**
 * One attribute of a tag.
 *
 * The space in front of the name is load-bearing: without it `x` matches the
 * `x="14"` inside `rx="14"`, and the whole mark is drawn fourteen units to the
 * right of where it belongs. It was, and `centred` below is what now says so.
 */
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const num = (tag, name, fallback) => {
  const got = attr(tag, name);
  if (got === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is missing from ${tag}`);
  }
  return Number(got);
};
const text = (tag, name, fallback) => attr(tag, name) ?? fallback;

/** `#rrggbb` as three bytes. The mark uses no other colour notation. */
function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`${hex} is not a #rrggbb colour: this script reads no other kind`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The shapes of the mark, in the order they are painted.
 *
 * A rounded rectangle for the ground and circles for the birds. Anything else
 * in the file throws, because silently dropping a shape is how an icon ends up
 * missing a bird on one client and not the other.
 */
function readMark(svg) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!viewBox) throw new Error("the mark has no `viewBox=\"0 0 w h\"`");
  const shapes = [];
  for (const [tag, kind] of svg.matchAll(/<(rect|circle)\b[^>]*>/g).map((m) => [m[0], m[1]])) {
    const fill = rgb(text(tag, "fill", "#000000"));
    const alpha = num(tag, "opacity", 1);
    if (kind === "rect") {
      shapes.push({ kind, x: num(tag, "x", 0), y: num(tag, "y", 0), w: num(tag, "width"), h: num(tag, "height"), r: num(tag, "rx", 0), fill, alpha });
    } else {
      shapes.push({ kind, cx: num(tag, "cx"), cy: num(tag, "cy"), r: num(tag, "r"), fill, alpha });
    }
  }
  const unknown = svg.replace(/<(svg|\/svg|rect|circle)\b[^>]*>/g, "").trim();
  if (unknown) throw new Error(`the mark holds a shape this script cannot read: ${unknown.slice(0, 60)}`);
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), shapes };
}

// ---- drawing ----------------------------------------------------------------

/** Whether a point in the mark's own coordinates is inside one shape. */
function covers(s, x, y) {
  if (s.kind === "circle") return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  // A rounded rectangle: inside the cross, or inside one of the four corners.
  const l = s.x + s.r, r = s.x + s.w - s.r, t = s.y + s.r, b = s.y + s.h - s.r;
  if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
  const cx = x < l ? l : x > r ? r : x;
  const cy = y < t ? t : y > b ? b : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= s.r * s.r;
}

/** The box the shapes actually occupy, which is not the viewBox. */
function bounds(shapes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of shapes) {
    const [a, b, c, d] = s.kind === "circle"
      ? [s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r]
      : [s.x, s.y, s.x + s.w, s.y + s.h];
    x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d);
  }
  return { x1, y1, x2, y2 };
}

/**
 * Draw `shapes` into a square of `size` pixels.
 *
 * `fill` is how much of the square the shapes are to occupy, which is the whole
 * reason this takes a number rather than scaling the viewBox: an adaptive icon
 * is masked to a circle and only its middle two thirds are promised to survive,
 * and a status bar icon wants the opposite — the artwork out to the edges.
 *
 * `mono` paints every shape white and keeps its opacity as alpha, which is what
 * Android reads a notification icon as: it throws the colour away and tints
 * what is left, so a coloured icon arrives as a featureless blob.
 *
 * Sixteen samples a pixel. There are four shapes and no gradients, so the only
 * thing that costs anything is the edge of a circle — and a circle's edge is
 * the whole mark.
 */
function draw(shapes, size, { fill = 1, mono = false } = {}) {
  const b = bounds(shapes);
  const span = Math.max(b.x2 - b.x1, b.y2 - b.y1);
  const scale = (size * fill) / span;
  const ox = size / 2 - ((b.x1 + b.x2) / 2) * scale;
  const oy = size / 2 - ((b.y1 + b.y2) / 2) * scale;
  const SUB = 4;

  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, bl = 0, a = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          // The sample, back in the mark's own coordinates.
          const mx = (x + (sx + 0.5) / SUB - ox) / scale;
          const my = (y + (sy + 0.5) / SUB - oy) / scale;
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (const s of shapes) {
            if (!covers(s, mx, my)) continue;
            const [cr, cg, cb] = mono ? [255, 255, 255] : s.fill;
            // Source-over, which is what the painter's order in the file means.
            sr = cr * s.alpha + sr * (1 - s.alpha);
            sg = cg * s.alpha + sg * (1 - s.alpha);
            sb = cb * s.alpha + sb * (1 - s.alpha);
            sa = s.alpha + sa * (1 - s.alpha);
          }
          r += sr; g += sg; bl += sb; a += sa;
        }
      }
      const n = SUB * SUB;
      const at = (y * size + x) * 4;
      px[at] = Math.round(r / n);
      px[at + 1] = Math.round(g / n);
      px[at + 2] = Math.round(bl / n);
      px[at + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ---- a PNG, by hand ---------------------------------------------------------

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** 8-bit RGBA, one filter byte per row, which deflate handles well enough. */
function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- what Android is handed -------------------------------------------------

const mark = readMark(readFileSync(source, "utf8"));
const birds = mark.shapes.filter((s) => s.kind === "circle");
if (birds.length === 0) throw new Error("the mark has no circles: this is not covey's mark");

const files = [
  // The whole mark, ground and all. The launcher's fallback, and what a device
  // too old for an adaptive icon shows.
  ["icon.png", draw(mark.shapes, 1024, { fill: 1 })],
  // The foreground of the adaptive icon, over `backgroundColor` in app.config.
  // Android masks it to a shape of the device's choosing and promises only the
  // middle two thirds, so the birds sit inside that.
  ["adaptive-icon.png", draw(birds, 1024, { fill: 0.6 })],
  // The status bar, where Android keeps the alpha and throws the colour away.
  ["notification-icon.png", draw(birds, 96, { fill: 0.86, mono: true })],
];

/**
 * What was actually drawn is centred in what it was drawn into.
 *
 * Cheap, and it is the check that catches the mistake this script is most
 * likely to make: a misread attribute moves or stretches the mark, and every
 * one of those shows up here as content that is no longer in the middle. The
 * alternative is noticing it on a phone's home screen a week later.
 */
function centred(px, size, name) {
  let x1 = size, y1 = size, x2 = -1, y2 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (px[(y * size + x) * 4 + 3] < 8) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) throw new Error(`${name} came out empty`);
  const off = Math.max(Math.abs(x1 - (size - 1 - x2)), Math.abs(y1 - (size - 1 - y2)));
  if (off > 2) throw new Error(`${name} is off centre by ${off}px (${x1}..${x2} × ${y1}..${y2} of ${size}): an attribute was read wrong`);
}

for (const [name, px] of files) {
  const size = Math.sqrt(px.length / 4);
  centred(px, size, name);
  const out = join(app, "assets", name);
  writeFileSync(out, encodePng(px, size));
  console.log(`wrote assets/${name} (${size}×${size})`);
}
console.log(`from ${source.replace(join(app, ".."), ".")}`);
