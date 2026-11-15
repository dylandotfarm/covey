/**
 * Taking a secret value back out of what a session said — issue #126.
 *
 * The environment keeps the value out of the conversation until something
 * prints it. These hold the rules of what happens then: which values are
 * looked for, what a match becomes, and what the walk must not touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepFilePaths, redactDeep, redactor, unredactor, WHOLE_TOKEN_BELOW } from "./redact.js";
import { repositoryNames } from "./git.js";

test("a value becomes a marker that names no secret, wherever it stands", () => {
  const r = redactor({ STRIPE_KEY: "sk_live_0123456789" })!;
  assert.equal(r("curl -H 'Authorization: Bearer sk_live_0123456789'"), "curl -H 'Authorization: Bearer [secret]'");
  // Twice in one line is twice replaced: `split`/`join`, not a single pass.
  assert.equal(r("sk_live_0123456789 sk_live_0123456789"), "[secret] [secret]");
  assert.equal(r("nothing to see"), "nothing to see");
});

test("the marker names no secret, so a reader who knows the words cannot read a value out of it", () => {
  // The marker is positional: it says a value stood in this exact place. A
  // reader who can work out what stood there — a URL anybody can look up, a
  // word they read two lines above — learns the value, and the name used to
  // tell them which secret it was. What is left is that a string is a secret.
  const r = redactor({ MODAL_PROFILE: "dylandotfarm" })!;
  assert.equal(r("the account is dylandotfarm"), "the account is [secret]");
  assert.doesNotMatch(r("the account is dylandotfarm"), /MODAL_PROFILE/);
});

test("a thread with no secret gets no redactor at all, and pays nothing", () => {
  assert.equal(redactor({}), null);
});

test("a short value is replaced where it stands as a whole token, and nowhere else", () => {
  // A short value turns up by chance inside a word, a path, a file name. The
  // piece of a path is never the value the reader meant, and replacing it
  // would cost a line they need. A value they set is still a value covey does
  // not write down, so where it stands alone it goes.
  const r = redactor({ PIN: "1234" })!;
  assert.equal(r("some/path/1234/world"), "some/path/1234/world");
  assert.equal(r("v1.1234.0"), "v1.1234.0");
  assert.equal(r("a1234b"), "a1234b");
  assert.equal(r("PIN=1234"), "PIN=[secret]");
  assert.equal(r("the pin is 1234"), "the pin is [secret]");
  assert.equal(r('{"pin":"1234"}'), '{"pin":"[secret]"}');
  assert.equal(r("1234"), "[secret]");
  // Every occurrence is judged on its own.
  assert.equal(r("x/1234/y and 1234"), "x/1234/y and [secret]");
});

test("a value long enough to be a credential is replaced wherever it stands", () => {
  // Nothing of this length turns up by chance, and a token glued to a quote or
  // sitting in the middle of a URL is exactly where one is printed.
  const long = "x".repeat(WHOLE_TOKEN_BELOW);
  const r = redactor({ LONG: long })!;
  assert.equal(r(`a/${long}/b`), "a/[secret]/b");
  assert.equal(r(`pre${long}post`), "pre[secret]post");
});

test("every value is looked for: a short one is no longer passed over in silence", () => {
  // The panel promises the reader covey takes a value back out of the
  // transcript. It used to keep that promise only above eight characters, and
  // said nothing about the rest.
  assert.notEqual(redactor({ SHORT: "abc" }), null);
  assert.equal(redactor({ SHORT: "abc" })!("abc"), "[secret]");
  // Whitespace alone is no credential, and a value of one space would make a
  // marker of every gap between two words.
  assert.equal(redactor({ BLANK: "   " }), null);
  assert.equal(redactor({ EMPTY: "" }), null);
});

test("the longest value goes first, so a value that contains another is replaced whole", () => {
  const r = redactor({ SHORT_TOKEN: "abcdefgh", LONG_TOKEN: "abcdefgh-ijklmnop" })!;
  assert.equal(r("abcdefgh-ijklmnop"), "[secret]");
  assert.equal(r("abcdefgh"), "[secret]");
});

test("every string in an item is redacted, and its bookkeeping is not", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  const item = {
    id: "tool:1", threadId: "t1", kind: "tool", createdAt: "2026-01-01T00:00:00Z",
    input: { command: "echo sk_live_0123456789", env: ["A=sk_live_0123456789"] },
    output: "sk_live_0123456789\n",
  };
  const out = redactDeep(item, r);
  assert.equal(out.output, "[secret]\n");
  assert.equal(out.input.command, "echo [secret]");
  assert.deepEqual(out.input.env, ["A=[secret]"]);
  // The id, the thread and the time are covey's own and are never rewritten.
  assert.equal(out.id, "tool:1");
  assert.equal(out.threadId, "t1");
  assert.equal(out.createdAt, "2026-01-01T00:00:00Z");
});

test("an item that holds no secret comes back as the same object", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  const item = { id: "a", text: "an ordinary reply", parts: [{ text: "and another" }] };
  assert.equal(redactDeep(item, r), item, "no new object for the common case");
});

test("numbers, nulls and booleans pass through untouched", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  assert.deepEqual(redactDeep({ n: 1, b: true, z: null }, r), { n: 1, b: true, z: null });
});

test("a marker is final: a value that is part of one is not found inside it", () => {
  // `[secret]` is eight characters, so the floor used to make this impossible.
  // The marker is covey's own text and no value of the reader's.
  const r = redactor({ A: "sk_live_0123456789", B: "secret" })!;
  assert.equal(r("sk_live_0123456789"), "[secret]");
  // The same word in the reader's own prose still goes.
  assert.equal(r("the secret is out"), "the [secret] is out");
});

// ---- covey's own bookkeeping ----------------------------------------------

test("the remote URL is never vouched for, because it may be the credential", () => {
  // `remoteForms` answers `null` for a token in an https URL, so
  // `Project.remoteUrl` records that URL whole — and `git remote -v` in the
  // thread's shell prints it. What covey vouches for is the host and the path.
  const keep = repositoryNames("github.com/org/repo", "https://ghp_abcdefghijklmnop@github.com/org/repo.git");
  const r = redactor({ GH_TOKEN: "ghp_abcdefghijklmnop" }, keep)!;
  assert.equal(
    r("origin\thttps://ghp_abcdefghijklmnop@github.com/org/repo.git (push)"),
    "origin\thttps://[secret]@github.com/org/repo.git (push)",
  );
});

test("the repository's two spellings are what covey vouches for, in the URL's own case", () => {
  // `normaliseRemote` lowercases the identity, so a repository named `Acme/Api`
  // needs the remote's own spelling beside it.
  assert.deepEqual(repositoryNames("github.com/org/repo"), ["github.com/org/repo", "github.com:org/repo"]);
  assert.deepEqual(
    repositoryNames("github.com/acme/api", "git@github.com:Acme/Api.git"),
    ["github.com/acme/api", "github.com:acme/api", "github.com/Acme/Api", "github.com:Acme/Api"],
  );
  // A local project has neither, and a URL covey cannot name adds nothing.
  assert.deepEqual(repositoryNames(null, null), []);
  assert.deepEqual(repositoryNames(null, "/srv/repos/thing.git"), []);
});


test("a string covey already stores in the clear keeps the value inside it", () => {
  // The `projects` table holds `github.com/owner/repo` whole, so redacting the
  // owner out of a URL covey itself wrote writes nothing new away. It cost the
  // reader a link that opens, and it was the marker at its plainest: anybody
  // can look the repository up and read the owner back out of the gap.
  const r = redactor({ MODAL_PROFILE: "dylandotfarm" }, ["github.com/dylandotfarm/app"])!;
  assert.equal(
    r("covey watch: news on pull request #37 (https://github.com/dylandotfarm/app/pull/37)."),
    "covey watch: news on pull request #37 (https://github.com/dylandotfarm/app/pull/37).",
  );
});

test("the same value outside that string is redacted all the same", () => {
  const r = redactor({ MODAL_PROFILE: "dylandotfarm" }, ["github.com/dylandotfarm/app"])!;
  assert.equal(
    r("dylandotfarm owns github.com/dylandotfarm/app, and dylandotfarm again"),
    "[secret] owns github.com/dylandotfarm/app, and [secret] again",
  );
});

test("an ssh remote is kept too, because it spells the owner another way", () => {
  // `github.com/owner/repo` is no substring of `git@github.com:owner/repo.git`.
  const r = redactor({ OWNER: "dylandotfarm" }, ["github.com/dylandotfarm/app", "git@github.com:dylandotfarm/app.git"])!;
  assert.equal(r("origin\tgit@github.com:dylandotfarm/app.git (push)"), "origin\tgit@github.com:dylandotfarm/app.git (push)");
});

test("a project with nothing to vouch for redacts exactly as it did", () => {
  const r = redactor({ OWNER: "dylandotfarm" }, [])!;
  assert.equal(r("github.com/dylandotfarm/app"), "github.com/[secret]/app");
});

// ---- the files covey stored itself ----------------------------------------

/** The thread's own file store, which is where a path covey kept must be. */
const STORE = "/p/github.com/dylandotfarm/app/t1/.covey/threads/t1/files";
const held = (path: string) => path.startsWith(STORE + "/");

test("a file covey stored keeps the path covey gave it", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "note:1", threadId: "t1", kind: "note", text: "the sidebar after the fix",
    files: [{ name: "shot.png", path: `${STORE}/shot.png`, mimeType: "image/png" }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  // The path names a file in the thread's own store, and the `/file` route
  // refuses everything else — so a path rewritten here is a picture nobody can
  // open. The directory is already in the `projects` table as it stands.
  assert.equal(out.files[0]!.path, raw.files[0]!.path);
  assert.equal(out.files[0]!.name, "shot.png");
  assert.equal(out.text, "the sidebar after the fix");
});

test("the words around a kept path are redacted all the same", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "user:1", threadId: "t1", kind: "user", text: "here is dylandotfarm",
    attachments: [{ name: "a.png", path: `${STORE}/a.png` }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  assert.equal(out.text, "here is [secret]");
  assert.equal(out.attachments[0]!.path, raw.attachments[0]!.path);
});

test("an attachment covey left where it was keeps the marker", () => {
  // An attachment sent with no inline bytes keeps the path it came with
  // (`materialiseAttachments`), and that path is anywhere on the machine. The
  // route refuses it whatever it is spelled with, so keeping the value would
  // write one down for no picture at all.
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "user:2", threadId: "t1", kind: "user", text: "look at this",
    attachments: [{ name: "notes.txt", path: "/home/dylandotfarm/notes.txt" }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  assert.equal(out.attachments[0]!.path, "/home/[secret]/notes.txt");
});

test("an item with no files of its own is the object redaction made", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = { id: "a", text: "ordinary" };
  const red = redactDeep(raw, r);
  assert.equal(keepFilePaths(red, raw, held), red);
  assert.equal(keepFilePaths("a string" as unknown, "a string" as unknown, held), "a string");
});

// ---- putting a value back into a path -------------------------------------

test("a path covey redacted is spelled back from the thread's own secrets", () => {
  const back = unredactor({ OWNER: "dylandotfarm", SHORT: "abc" })!;
  assert.equal(back("/p/github.com/[secret OWNER]/app/files/shot.png"), "/p/github.com/dylandotfarm/app/files/shot.png");
  // A name this thread does not hold stays as it is, and so does a value too
  // short for `redactor` to have replaced.
  assert.equal(back("/p/[secret GONE]/x.png"), "/p/[secret GONE]/x.png");
  assert.equal(back("/p/[secret SHORT]/x.png"), "/p/[secret SHORT]/x.png");
  assert.equal(back("/p/app/files/shot.png"), "/p/app/files/shot.png");
  assert.equal(unredactor({}), null);
});

test("the values go back in one pass, so a value holding a marker is not read again", () => {
  const back = unredactor({ A: "[secret B]x", B: "0123456789" })!;
  assert.equal(back("/p/[secret A]/f.png"), "/p/[secret B]x/f.png");
});
