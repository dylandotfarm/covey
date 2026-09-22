import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthFailure, fileStamp, fileExpiry, parseExpiry, parseKeychainStamp } from "./auth.js";

test("the failures that are about the credentials", () => {
  for (const text of [
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid bearer token\"}}",
    "OAuth token has expired. Please obtain a new token.",
    "Invalid API key · Please run /login",
    "API Error: 403 Forbidden — this credential is not authorized for this model",
  ]) assert.equal(isAuthFailure(text), true, text);
});

test("the failures that are about the work", () => {
  // Both halves have to be there. `401` alone is a page a tool fetched, and
  // `invalid` alone is most of what a model ever gets told.
  for (const text of [
    "API Error: 500 Internal server error",
    "API Error: 529 overloaded_error",
    "curl: the server answered 401 for https://example.com/private",
    "prompt is too long: 250000 tokens > 200000 maximum",
    "Invalid tool input: the field 'path' is required",
    "",
  ]) assert.equal(isAuthFailure(text), false, text);
  assert.equal(isAuthFailure(null), false);
  assert.equal(isAuthFailure(undefined), false);
});

test("the keychain stamp is the date, and nothing the token can be read from", () => {
  const dump = [
    "keychain: \"/Users/dylan/Library/Keychains/login.keychain-db\"",
    "class: \"genp\"",
    "attributes:",
    "    0x00000007 <blob>=\"Claude Code-credentials\"",
    "    \"acct\"<blob>=\"dylan\"",
    "    \"cdat\"<timedate>=0x32303236303531353033303831305A00  \"20260515030810Z\\000\"",
    "    \"mdat\"<timedate>=0x32303236303931393034303932305A00  \"20260919040920Z\\000\"",
  ].join("\n");
  assert.equal(parseKeychainStamp(dump), "keychain:20260919040920Z");
  // A rotation is a different stamp; that is the whole of what the daemon asks.
  assert.notEqual(parseKeychainStamp(dump.replace("040920Z", "120920Z")), parseKeychainStamp(dump));
  assert.equal(parseKeychainStamp("    \"mdat\"<timedate>=0x32303236303931393034303932305A00"), "keychain:32303236303931393034303932305A00");
  assert.equal(parseKeychainStamp("password: not found"), null);
});

test("the file stamp follows the file, and a missing file is not a failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "covey-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await fileStamp(dir), null, "no file: the watch stays off");

  writeFileSync(join(dir, ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"one\"}}");
  const first = await fileStamp(dir);
  assert.ok(first?.startsWith("file:"));

  writeFileSync(join(dir, ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"two-and-longer\"}}");
  assert.notEqual(await fileStamp(dir), first);
});

test("the expiry is one number out of the store, and nothing else is kept", async (t) => {
  assert.equal(parseExpiry("{\"claudeAiOauth\":{\"accessToken\":\"secret\",\"expiresAt\":1790000000000}}"), 1790000000000);
  // A store this daemon cannot read, a store without the field, and a store of
  // another shape all read as "unknown", never as "expired".
  assert.equal(parseExpiry(null), null);
  assert.equal(parseExpiry(""), null);
  assert.equal(parseExpiry("not json"), null);
  assert.equal(parseExpiry("{\"claudeAiOauth\":{\"accessToken\":\"secret\"}}"), null);
  assert.equal(parseExpiry("{\"claudeAiOauth\":{\"expiresAt\":\"soon\"}}"), null);

  const dir = mkdtempSync(join(tmpdir(), "covey-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await fileExpiry(dir), null, "no file: the expiry is unknown");
  writeFileSync(join(dir, ".credentials.json"), "{\"claudeAiOauth\":{\"accessToken\":\"secret\",\"expiresAt\":1790000000000}}");
  assert.equal(await fileExpiry(dir), 1790000000000);
});
