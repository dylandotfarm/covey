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
