/**
 * What a person typed, turned into an address this app can dial (issue #168).
 *
 * The page never needs this: it is served by a daemon, so it knows an address
 * before it runs a line. An app is typed into, and this is the one place that
 * guesses what somebody meant.
 *
 * No storage and no React Native in this file, so node tests it — which is the
 * point, because every rule here is a rule about somebody's fingers.
 */

/**
 * What a person typed, as a URL this app can dial, or an error to show them.
 *
 * A person types `pi`, or `pi:3790`, or `http://pi:3790`, or pastes the whole
 * link the TUI printed with a token on it. All of those mean the same machine,
 * and the one that must keep working is the paste: it is how a token gets onto
 * a phone without being typed by hand.
 */
export function parseAddress(input: string): { url: string; name: string; token?: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "Type the address of a machine running covey." };
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { error: `${text} is not an address.` }; }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return { error: `covey does not speak ${url.protocol.replace(":", "")}.` };
  if (!url.hostname) return { error: `${text} names no machine.` };
  // A pasted link carries the token on it, which is the whole point of pasting.
  const token = url.searchParams.get("token") ?? undefined;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  // `URL` drops a port that is the scheme's own default, so `wss://host:443`
  // arrives here with no port at all and a fallback of 3790 would send the app
  // somewhere nobody asked for.
  //
  // The daemon speaks no TLS, so a secure address is always a reverse proxy in
  // front of one, and 443 is the only reading. Anything else is the daemon
  // itself, where 3790 is its default and the number a reader knows.
  const port = url.port || (secure ? "443" : "3790");
  return {
    url: `${secure ? "wss" : "ws"}://${url.hostname}:${port}`,
    // The host is the name until the daemon says its own, which it does in its
    // first snapshot.
    name: url.hostname,
    ...(token ? { token } : {}),
  };
}
