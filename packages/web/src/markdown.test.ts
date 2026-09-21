import { test } from "node:test";
import assert from "node:assert/strict";
import { inline, markdownToHtml } from "./markdown.js";

test("markup in a reply is text, not markup", () => {
  assert.equal(markdownToHtml("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  assert.equal(inline("a `<b>` b"), "a <code>&lt;b&gt;</code> b");
});

test("fences, headers, lists and paragraphs", () => {
  const html = markdownToHtml("# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```ts\nconst x = 1 < 2;\n```\nafter");
  assert.equal(html,
    "<h1>Title</h1>" +
    "<p>Some <strong>bold</strong> and <code>code</code>.</p>" +
    "<ul><li>one</li><li>two</li></ul>" +
    "<ol><li>first</li><li>second</li></ol>" +
    '<pre data-lang="ts"><code>const x = 1 &lt; 2;</code></pre>' +
    "<p>after</p>");
});

test("a fence without a closing line runs to the end", () => {
  assert.equal(markdownToHtml("```\nopen"), "<pre><code>open</code></pre>");
});

test("links open in a new tab and bare urls become links", () => {
  assert.equal(inline("see [docs](https://x.y/z) or https://a.b/c."), 'see <a href="https://x.y/z" target="_blank" rel="noreferrer">docs</a> or <a href="https://a.b/c." target="_blank" rel="noreferrer">https://a.b/c.</a>');
});

test("lines inside a paragraph keep their breaks", () => {
  assert.equal(markdownToHtml("one\ntwo"), "<p>one<br>two</p>");
});

test("a #N in prose is a link into the page, and a hex colour or a heading is not (#108)", () => {
  assert.equal(inline("see #12 and (#345)."), 'see <a class="ref" href="#" data-number="12">#12</a> and (<a class="ref" href="#" data-number="345">#345</a>).');
  assert.equal(inline("colour #123456 and item#7"), "colour #123456 and item#7");
  assert.equal(inline("https://github.com/o/r/pull/12#issuecomment-1"), '<a href="https://github.com/o/r/pull/12#issuecomment-1" target="_blank" rel="noreferrer">https://github.com/o/r/pull/12#issuecomment-1</a>');
  assert.equal(inline("`#12` in code"), "<code>#12</code> in code");
  assert.equal(markdownToHtml("# Title\n\nCloses #108"), '<h1>Title</h1><p>Closes <a class="ref" href="#" data-number="108">#108</a></p>');
});

test("an image and a video are inline, through the mapper the renderer hands in (#110)", () => {
  const media = (u: string) => `/media?url=${encodeURIComponent(u)}`;
  const a = "https://github.com/user-attachments/assets/abc";
  // The markdown form covey and GitHub write for an image.
  assert.equal(inline(`before ![after.png](${a}) after`, { media }),
    `before <img class="media" src="${media(a)}" alt="after.png" data-full="${a}" loading="lazy"> after`);
  // GitHub's own form writes an <img> tag; only its src and alt survive.
  assert.equal(inline(`<img width="300" alt="shot" src="${a}" onerror="alert(1)">`, { media }),
    `<img class="media" src="${media(a)}" alt="shot" data-full="${a}" loading="lazy">`);
  assert.equal(inline('<img src="javascript:alert(1)">'), "&lt;img src=&quot;javascript:alert(1)&quot;&gt;", "a src that is not http stays text");
  // A bare attachment URL on its own line is a video, the way GitHub's form puts one in.
  assert.equal(markdownToHtml(`Watch:\n\n${a}\n\nend`, { media }),
    `<p>Watch:</p><p class="media-p"><video class="media" src="${media(a)}" controls playsinline preload="metadata"></video></p><p>end</p>`);
  // A bare image URL by its extension is an image, and any other bare URL is a link.
  assert.equal(markdownToHtml("https://x.example/a.png"), '<p class="media-p"><img class="media" src="https://x.example/a.png" alt="" data-full="https://x.example/a.png" loading="lazy"></p>');
  assert.equal(markdownToHtml("https://x.example/a.mp4"), '<p class="media-p"><video class="media" src="https://x.example/a.mp4" controls playsinline preload="metadata"></video></p>');
  assert.equal(markdownToHtml("https://x.example/page"), '<p><a href="https://x.example/page" target="_blank" rel="noreferrer">https://x.example/page</a></p>');
  // Without a mapper the URL is the src.
  assert.equal(inline("![a](https://x.example/a.png)"), '<img class="media" src="https://x.example/a.png" alt="a" data-full="https://x.example/a.png" loading="lazy">');
  // An image inside a code span is text.
  assert.equal(inline("`![a](https://x.example/a.png)`"), "<code>![a](https://x.example/a.png)</code>");
});
