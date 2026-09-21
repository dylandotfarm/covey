import { test } from "node:test";
import assert from "node:assert/strict";
import { webAddresses, withToken } from "./addresses.js";

const ifaces = { lanIps: ["192.168.1.20"], host: "box" };

test("a daemon bound to the tailnet lists every address, and only the tailnet ones are reachable", () => {
  const list = webAddresses({ port: 3790, bind: "tailnet", tailnetName: "box.tail1.ts.net", tailnetIps: ["100.64.0.5", "fd7a:115c:a1e0::5"] }, ifaces);
  assert.deepEqual(list, [
    { kind: "tailnet", url: "http://box.tail1.ts.net:3790/", reachable: true },
    { kind: "tailnet", url: "http://100.64.0.5:3790/", reachable: true },
    { kind: "mdns", url: "http://box.local:3790/", reachable: false },
    { kind: "lan", url: "http://192.168.1.20:3790/", reachable: false },
  ]);
});

test("bound to all, the LAN addresses are reachable; bound to loopback, none are", () => {
  const all = webAddresses({ port: 3799, bind: "all", tailnetIps: ["100.64.0.5"] }, ifaces);
  assert.ok(all.every((a) => a.reachable));
  const lo = webAddresses({ port: 3799, bind: "loopback", tailnetIps: ["100.64.0.5"] }, ifaces);
  assert.ok(lo.every((a) => !a.reachable));
});

test("without tailscale and without a LAN there is nothing to list", () => {
  assert.deepEqual(webAddresses({ port: 3790, bind: "all" }, { lanIps: [], host: "box" }), []);
});

test("the token rides on every address but a tailnet one", () => {
  assert.equal(withToken({ kind: "tailnet", url: "http://t:1/", reachable: true }, "abc"), "http://t:1/");
  assert.equal(withToken({ kind: "lan", url: "http://l:1/", reachable: true }, "abc"), "http://l:1/?token=abc");
  assert.equal(withToken({ kind: "mdns", url: "http://box.local:1/", reachable: true }, "abc"), "http://box.local:1/?token=abc");
});
