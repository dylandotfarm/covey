/**
 * Unwrap prose an agent hard-wrapped at a terminal's width (#189).
 *
 * GitHub renders one newline inside a paragraph of an issue, a pull request
 * or a comment as a line break. A model writes its prose wrapped at about
 * eighty columns, so a body that reads as paragraphs in the editor reaches
 * the reader broken after every eightieth character. This module joins those
 * lines back, one line per paragraph, before the body goes to `gh`.
 *
 * It is pure, and it is careful, because a line break the writer meant must
 * stay. A run of lines is joined only when it carries the signature of a
 * wrap: the widest line is between `MIN_WRAP` and `MAX_WRAP` columns, and
 * every line but the last is already too long to hold the first word of the
 * line under it. A column of short lines fails the first test; a column of
 * names, paths or URLs fails the second, because a line of one long word is
 * never a wrapped sentence. A fence, an indented block, a table, a heading,
 * a list marker, a blockquote marker, a rule and an explicit hard break each
 * end a run, so none of them is ever joined.
 *
 * One case stays ambiguous and this module joins it: two or more long lines
 * of several words each, meant as a column, with no list marker and no
 * fence. Nothing in the text tells that apart from wrapped prose. Write such
 * a column as a list or in a fenced block.
 */

/** The narrowest wrap column this module believes in. Below it, a column of lines is a column. */
const MIN_WRAP = 60;

/** The widest. Past it a long line is one the writer wrote, not a terminal's width. */
const MAX_WRAP = 120;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const INDENTED = /^(?: {4,}|\t)/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const BULLET = /^ {0,3}[-*+](?:\s|$)/;
const ORDERED = /^ {0,3}\d{1,9}[.)](?:\s|$)/;
const QUOTE = /^ {0,3}>/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** The `===` or `---` under a setext heading, and any other line of only those marks. */
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
const TABLE = /^ {0,3}\|/;
const HTML = /^ {0,3}</;
const LINK_DEF = /^ {0,3}\[[^\]]+\]:/;
/** Markdown's own hard break: two spaces or a backslash at the end of the line. */
const HARD_BREAK = /(?:\s{2,}|\\)$/;

const BLANK = /^\s*$/;

/** A line that starts a block of its own, so it can never be joined onto the line above. */
function startsBlock(line: string): boolean {
  return HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line)
    || RULE.test(line) || SETEXT.test(line) || TABLE.test(line) || HTML.test(line)
    || LINK_DEF.test(line) || FENCE.test(line);
}

/** A line the next line may be joined onto. A heading or a table row holds one line only. */
function canAccept(line: string): boolean {
  if (BLANK.test(line) || INDENTED.test(line) || HARD_BREAK.test(line)) return false;
  return !(HEADING.test(line) || RULE.test(line) || SETEXT.test(line) || TABLE.test(line)
    || HTML.test(line) || LINK_DEF.test(line) || FENCE.test(line));
}

/** A line that may be joined onto the line above: ordinary prose and nothing else. */
function canContinue(line: string): boolean {
  return !BLANK.test(line) && !INDENTED.test(line) && !startsBlock(line);
}

/** The whitespace-separated words of a line. An empty line has none. */
function words(line: string | undefined): string[] {
  const t = (line ?? "").trim();
  return t === "" ? [] : t.split(/\s+/);
}

/**
 * Does this run of lines read as one paragraph a terminal broke?
 *
 * A terminal of width C wrapped the run when every line fits in C and no line
 * but the last could hold one more word. The widest line is the smallest C
 * that can be true, so the test is that one: the widest line, against the
 * width each line would reach with the next line's first word on it.
 */
function looksWrapped(run: string[]): boolean {
  const widths = run.map((l) => l.replace(/\s+$/, "").length);
  const wrap = Math.max(...widths);
  if (wrap < MIN_WRAP || wrap > MAX_WRAP) return false;
  for (let i = 0; i < run.length - 1; i++) {
    // A line of one long word is an address or a path, not a wrapped sentence.
    if (words(run[i]).length < 2) return false;
    const word = words(run[i + 1])[0] ?? "";
    // The line had room for the next word and stopped anyway: the writer broke it.
    if ((widths[i] ?? 0) + 1 + word.length <= wrap) return false;
  }
  return true;
}

/** One line, with the first line's indentation and one space between the parts. */
function join(run: string[]): string {
  return run.map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : l.trim())).join(" ");
}

/** Does this line close the fence that `mark` opened? */
function closesFence(line: string, mark: string): boolean {
  const m = FENCE_CLOSE.exec(line)?.[1];
  return m !== undefined && m[0] === mark[0] && m.length >= mark.length;
}

/**
 * Join every paragraph of `text` that was wrapped at a terminal's width, and
 * leave every other line where it is. The text is returned unchanged when it
 * holds no wrap this module is sure of.
 */
export function unwrapMarkdown(text: string): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (fence !== null) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      i++;
      continue;
    }
    const open = FENCE.exec(line)?.[1];
    if (open !== undefined) {
      out.push(line);
      fence = open;
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && canAccept(lines[j] ?? "") && canContinue(lines[j + 1] ?? "")) j++;
    const run = lines.slice(i, j + 1);
    if (run.length > 1 && looksWrapped(run)) out.push(join(run));
    else out.push(...run);
    i = j + 1;
  }
  return out.join("\n");
}
