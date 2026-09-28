/**
 * What somebody meant when they typed an address.
 *
 * Every case here is a rule about fingers, and the one that must never break is
 * the paste: a token reaches a phone by pasting the link the TUI printed, not by
 * being typed forty-eight characters at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "./address";

const ok = (input: string) => {
  const r = parseAddress(input);
  assert.ok(!("error" in r), `expected ${JSON.stringify(input)} to parse, got ${JSON.stringify(r)}`);
  return r;
};

test("a bare host is a daemon on the default port", () => {
  assert.deepEqual(ok("pi"), { url: "ws://pi:3790", name: "pi" });
  assert.deepEqual(ok("192.168.1.9"), { url: "ws://192.168.1.9:3790", name: "192.168.1.9" });
  assert.deepEqual(ok("pi.tail1234.ts.net"), { url: "ws://pi.tail1234.ts.net:3790", name: "pi.tail1234.ts.net" });
});

test("a port is kept, and a scheme is not needed", () => {
  assert.deepEqual(ok("pi:3799"), { url: "ws://pi:3799", name: "pi" });
  assert.deepEqual(ok("http://pi:3799"), { url: "ws://pi:3799", name: "pi" });
});

test("https and wss both mean a secure socket, on 443 and not on 3790", () => {
  // The daemon speaks no TLS, so a secure address is a reverse proxy in front
  // of one. `URL` drops the default port, and a fallback of 3790 here would
  // dial a port nobody named.
  assert.equal(ok("https://covey.example.com").url, "wss://covey.example.com:443");
  assert.equal(ok("wss://covey.example.com").url, "wss://covey.example.com:443");
  assert.equal(ok("wss://covey.example.com:443").url, "wss://covey.example.com:443");
  assert.equal(ok("https://covey.example.com:8443").url, "wss://covey.example.com:8443");
  // And a plain address is the daemon itself, on the port a reader knows.
  assert.equal(ok("ws://pi").url, "ws://pi:3790");
  assert.equal(ok("http://pi").url, "ws://pi:3790");
});

test("a pasted link brings its token, which is how a token reaches a phone", () => {
  const r = ok("http://pi.tail1234.ts.net:3790/?token=abc123def456");
  assert.deepEqual(r, { url: "ws://pi.tail1234.ts.net:3790", name: "pi.tail1234.ts.net", token: "abc123def456" });
});

test("whitespace around a paste is not an address problem", () => {
  assert.equal(ok("  pi:3790  ").url, "ws://pi:3790");
});

test("what cannot be dialled says so, in words about the input", () => {
  for (const [input, match] of [
    ["", /Type the address/],
    ["   ", /Type the address/],
    ["ftp://pi", /does not speak ftp/],
    ["http://", /not an address|names no machine/],
  ] as const) {
    const r = parseAddress(input);
    assert.ok("error" in r, `expected ${JSON.stringify(input)} to fail`);
    assert.match(r.error, match);
  }
});

test("the same machine typed four ways is one address", () => {
  const forms = ["pi:3790", "http://pi:3790", "http://pi:3790/", "ws://pi:3790"];
  const urls = new Set(forms.map((f) => ok(f).url));
  assert.equal(urls.size, 1, `four spellings gave ${[...urls].join(", ")}`);
});
