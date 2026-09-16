import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@covey/protocol";
import type { TaggedAttachment } from "./attachments.js";

// A Store reads the config on construction. Point it at an empty directory so
// the test never sees the machine list of whoever runs it.
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-cfg-"));
const { Store } = await import("./store.js");

interface Sent { type: string; text: string; attachments?: Attachment[] }

/** A store with one thread open and a client that records what it is asked to send. */
function harness(pending: TaggedAttachment[]) {
  const sent: Sent[] = [];
  const store = new Store([]);
  const s = store as any;
  s.state.view = { machine: "m", threadId: "t", thread: null, items: new Map(), loading: false, error: null, hasMore: false, loadingOlder: false, seq: 0 };
  s.clients.set("m", { command: async (c: Sent) => { sent.push(c); return {}; } });
  store.setAttachments("t", pending);
  return { store, sent };
}

const tagged = (name: string, tag: string): TaggedAttachment => ({ name, path: `/a/${name}`, mimeType: "image/png", tag });

test("a file whose tag the user deleted does not go with the turn", async () => {
  const { store, sent } = harness([tagged("shot.png", "[shot.png]"), tagged("shot.png", "[shot.png 2]")]);
  await store.sendTurn("compare [shot.png] with what I said");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.attachments?.map((a) => a.name), ["shot.png"], "only the file whose tag survived should be sent");
  assert.equal(store.attachments("t").length, 0, "the send clears the pending list");
});

test("deleting every tag sends a turn with no attachments at all", async () => {
  const { store, sent } = harness([tagged("shot.png", "[shot.png]")]);
  await store.sendTurn("never mind");
  assert.equal(sent[0]!.attachments, undefined);
});

test("the tag stays in the client and never reaches the wire", async () => {
  const { store, sent } = harness([tagged("shot.png", "[shot.png]")]);
  await store.sendTurn("look at [shot.png]");
  const a = sent[0]!.attachments![0]!;
  assert.ok(!("tag" in a), `the wire attachment must carry no tag, got ${JSON.stringify(a)}`);
  assert.equal(a.path, "/a/shot.png", "the real path still goes, so the daemon can copy the file");
});
