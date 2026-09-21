import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaTarget, resolveMedia } from "./media.js";

test("only a GitHub user attachment is a media target (#110)", () => {
  assert.equal(mediaTarget("https://github.com/user-attachments/assets/e3f207ce-2c03-4bfe-af5a-8128b65b76e4"), "https://github.com/user-attachments/assets/e3f207ce-2c03-4bfe-af5a-8128b65b76e4");
  assert.equal(mediaTarget("https://github.com/user-attachments/assets/x#frag"), "https://github.com/user-attachments/assets/x");
  assert.equal(mediaTarget("https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=t"), "https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=t");
  assert.equal(mediaTarget("https://user-images.githubusercontent.com/1/2.png"), "https://user-images.githubusercontent.com/1/2.png");
  for (const bad of [null, "", "not a url", "http://github.com/user-attachments/assets/x", "https://github.com/dylandotfarm/covey", "https://github.com/login", "https://evil.example/user-attachments/assets/x", "https://github.com.evil.example/user-attachments/assets/x", "file:///etc/passwd", "https://127.0.0.1/user-attachments/assets/x"]) {
    assert.equal(mediaTarget(bad), null, String(bad));
  }
});

test("resolveMedia asks with the token and hands back GitHub's redirect, or its status", async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization });
    assert.equal(init?.redirect, "manual", "the redirect is the answer; it must not be followed");
    if (headers.Authorization === "Bearer secret") return new Response(null, { status: 302, headers: { location: "https://store.example/signed?X-Amz-Expires=300" } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const url = "https://github.com/user-attachments/assets/abc";
  assert.deepEqual(await resolveMedia(url, { fetch: fakeFetch, token: async () => "secret" }), { location: "https://store.example/signed?X-Amz-Expires=300" });
  assert.deepEqual(await resolveMedia(url, { fetch: fakeFetch, token: async () => null }), { status: 404 });
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer secret", undefined]);
  assert.equal(calls[0]!.url, url);
});
