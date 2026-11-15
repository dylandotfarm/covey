/**
 * `POST /upload`: the way in for a file too big to carry inline.
 *
 * A real `node:http` server against a real socket, because the rules worth
 * holding here are about a body arriving over time: a cap counted as the bytes
 * come rather than believed from a header, and a half-written file that never
 * outlives the request that failed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { MAX_UPLOAD_BYTES } from "@covey/protocol";
import { serveThreadUpload, uploadFailure } from "./threadUpload.js";
import { reserveUploadPath, threadFilesDir } from "./attachments.js";

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

/**
 * A daemon with one thread, `t`, working in a scratch directory. `reserve` is
 * the engine's own answer, so the store's naming rules are the real ones.
 */
async function daemon(cap?: number): Promise<{ url: string; cwd: string; store: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "covey-upload-"));
  const server = createServer((req, res) => {
    void serveThreadUpload(req, res, {
      reserve: (id, name) => (id === "t" ? reserveUploadPath(cwd, id, name) : null),
      cap,
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/upload`, cwd, store: threadFilesDir(cwd, "t") };
}

/** Everything in a thread's store, so a test can say what is and is not there. */
const inStore = (store: string) => (existsSync(store) ? readdirSync(store).sort() : []);

test("a file arrives, lands in the thread's own store, and the answer names it", async () => {
  const d = await daemon();
  const res = await fetch(`${d.url}?thread=t&name=clip.mp4`, { method: "POST", body: "hello there" });
  assert.equal(res.status, 200);
  const answer = await res.json() as { path: string; name: string; bytes: number };
  assert.equal(answer.name, "clip.mp4");
  assert.equal(answer.bytes, 11);
  assert.equal(answer.path, join(d.store, "clip.mp4"));
  assert.equal(readFileSync(answer.path, "utf8"), "hello there");
  // The store is in git's blind spot wherever the thread works, or the first
  // thing a reader committed would be a video.
  assert.equal(readFileSync(join(d.cwd, ".covey", ".gitignore"), "utf8"), "*\n");
});

test("a second file of one name gets a name of its own, never the first one's bytes", async () => {
  const d = await daemon();
  await fetch(`${d.url}?thread=t&name=clip.mp4`, { method: "POST", body: "first" });
  const res = await fetch(`${d.url}?thread=t&name=clip.mp4`, { method: "POST", body: "second" });
  const answer = await res.json() as { name: string };
  assert.equal(answer.name, "clip-2.mp4");
  assert.deepEqual(inStore(d.store), ["clip-2.mp4", "clip.mp4"]);
  assert.equal(readFileSync(join(d.store, "clip.mp4"), "utf8"), "first");
});

test("a name cannot write outside the store, however it is spelled", async () => {
  const d = await daemon();
  for (const name of ["../../escaped.txt", "/etc/passwd", "a/b/c.txt", "..", "C:\\x.txt"]) {
    const res = await fetch(`${d.url}?thread=t&name=${encodeURIComponent(name)}`, { method: "POST", body: "x" });
    assert.equal(res.status, 200, name);
    const { path } = await res.json() as { path: string };
    assert.ok(path.startsWith(d.store), `${name} landed at ${path}`);
  }
  assert.equal(existsSync(join(d.cwd, "escaped.txt")), false);
});

test("a thread this daemon does not hold is a 404 and writes nothing", async () => {
  const d = await daemon();
  const res = await fetch(`${d.url}?thread=elsewhere&name=clip.mp4`, { method: "POST", body: "x" });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no such thread on this machine/);
  assert.deepEqual(inStore(d.store), []);
});

test("the thread and the name are both asked for by name", async () => {
  const d = await daemon();
  assert.equal((await fetch(`${d.url}?name=a`, { method: "POST", body: "x" })).status, 400);
  const res = await fetch(`${d.url}?thread=t`, { method: "POST", body: "x" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /name the file/);
});

test("a GET is not how a file is sent", async () => {
  const d = await daemon();
  const res = await fetch(`${d.url}?thread=t&name=a`);
  assert.equal(res.status, 405);
  assert.match(await res.text(), /sent with POST/);
});

test("a content-length over the ceiling is refused before a byte is read", async () => {
  const d = await daemon();
  // A raw socket, because `fetch` will not send a body shorter than the header
  // claims — and the whole point is that the route answers a reader who picked
  // a 2 GB file at once, rather than after the 2 GB.
  const port = Number(new URL(d.url).port);
  const answer = await new Promise<string>((done, fail) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write([
        "POST /upload?thread=t&name=film.mov HTTP/1.1",
        "Host: 127.0.0.1",
        `Content-Length: ${MAX_UPLOAD_BYTES + 1}`,
        "", "",
      ].join("\r\n"));
    });
    let said = "";
    sock.on("data", (b) => { said += b.toString(); if (said.includes("\r\n\r\n")) { sock.destroy(); done(said); } });
    sock.on("error", fail);
    sock.setTimeout(5000, () => { sock.destroy(); fail(new Error("the route never answered")); });
  });
  assert.match(answer, /^HTTP\/1\.1 413 /);
  assert.match(answer, /over the 512 MB limit/);
  assert.deepEqual(inStore(d.store), []);
});

test("the body is counted as it arrives, so a header that lies decides nothing", async () => {
  // The real check. `content-length` is the client's claim about the body, and
  // a route that trusted it would take any number of bytes a liar wanted to
  // send. A chunked body carries no such header at all, so only the count can
  // stop this one. The cap is lowered rather than the body raised: half a
  // gigabyte through a machine's disk is not what this is asking about.
  const d = await daemon(1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (sent >= 64 * 1024) { c.close(); return; } sent += 1024; c.enqueue(new Uint8Array(1024)); },
  });
  const res = await fetch(`${d.url}?thread=t&name=film.mov`, { method: "POST", body, duplex: "half" } as RequestInit)
    .catch((e: Error) => e);
  // undici may surface the refusal as the answer, or as a broken pipe on the
  // body it was still writing. Either is the route having stopped it.
  if (res instanceof Response) assert.equal(res.status, 413);
  // What matters either way: nothing half-written is left for the agent to
  // read as whole, and for `/file` to serve.
  assert.deepEqual(inStore(d.store), []);
});

test("a body exactly at the cap still lands: the refusal is for over it", async () => {
  const d = await daemon(1024);
  const res = await fetch(`${d.url}?thread=t&name=exact.bin`, { method: "POST", body: new Uint8Array(1024) });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { bytes: number }).bytes, 1024);
});

test("an upload cut short takes its half-written file with it", async () => {
  const d = await daemon();
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(1024)); },
    pull() { throw new Error("the link went away"); },
  });
  await fetch(`${d.url}?thread=t&name=clip.mp4`, { method: "POST", body, duplex: "half" } as RequestInit).catch(() => {});
  // The request ended with a file the client never finished. A store holding
  // it would hand the agent a truncated video with nothing saying so.
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(inStore(d.store), []);
});

test("two uploads handed one path do not land on each other", async () => {
  // `reserveUploadPath` creates nothing, so two clients uploading one name to
  // one thread at the same moment are both handed `clip.mp4` — `unique` sees
  // no file for either. Under the default `w` the second write would truncate
  // the first, which breaks the one promise this route makes: a file in the
  // store is whole. The hook here is that race, held still.
  const cwd = mkdtempSync(join(tmpdir(), "covey-upload-race-"));
  const store = threadFilesDir(cwd, "t");
  const fixed = reserveUploadPath(cwd, "t", "clip.mp4");
  const server = createServer((req, res) => {
    void serveThreadUpload(req, res, { reserve: () => fixed });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/upload?thread=t&name=clip.mp4`;
  const both = await Promise.all([
    fetch(url, { method: "POST", body: "first" }),
    fetch(url, { method: "POST", body: "second" }),
  ]);
  const codes = both.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409], "one lands, the other is told to send it again");
  // And what is on disk is one whole file, not one file with the other's bytes
  // written over it.
  assert.deepEqual(readdirSync(store), ["clip.mp4"]);
  assert.ok(["first", "second"].includes(readFileSync(fixed, "utf8")));
});

test("four problems, four answers (#132)", () => {
  // Each wants something different from the person holding the phone: a file
  // they can do something about, a link to try again, a machine that is full,
  // and anything else.
  assert.equal(uploadFailure(Object.assign(new Error("x"), { code: "ERR_STREAM_PREMATURE_CLOSE" })).status, 400);
  assert.match(uploadFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })).why, /stopped before the file was whole/);
  assert.match(uploadFailure(Object.assign(new Error("x"), { code: "ENOSPC" })).why, /no room left/);
  assert.match(uploadFailure(Object.assign(new Error("x"), { code: "EEXIST" })).why, /took that name first/);
  const other = uploadFailure(new Error("the disk is on fire"));
  assert.equal(other.status, 500);
  assert.match(other.why, /the disk is on fire/);
});
