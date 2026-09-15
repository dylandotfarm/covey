# Security

## Report a vulnerability

Do not open a public issue for a vulnerability.

Use GitHub's private report form instead: go to the **Security** tab of this repository and
select **Report a vulnerability**. Only the maintainer sees that report.

Please include:

- what an attacker can do, and what they need first;
- the steps to reproduce the problem;
- the commit you tested.

The maintainer tries to send a first answer within 7 days. This is a small project with one
maintainer, and there is no bounty.

## What covey exposes

Do not bind the daemon to `all` on a network you do not trust. Any client that authenticates
can start Claude Code threads on that machine, read the files it can read, and run the tools
the permission mode allows.

The daemon listens on one TCP port (3790 by default) and accepts a WebSocket connection in
three cases:

1. the connection comes from loopback, so it is already on the same machine;
2. the request carries a `?token=` parameter, or an `Authorization: Bearer` header, that
   matches the token in the daemon's config;
3. the source is a Tailscale address and `tailscale whois` says the peer belongs to the same
   tailnet user as the daemon.

The token is a random 24-byte value. `covey info` prints it. Treat it as a password: anyone
who holds it reaches the daemon from any network.

## Supported versions

The project is early and there are no releases yet. Fixes land on `main`. Update with
`covey update`, or with `git pull` and a rebuild.

## Out of scope

- **The permission mode you choose.** covey runs Claude Code with the model and permission
  mode you set. A permissive mode lets a thread change files and run commands. That is the
  purpose of the tool, not a flaw in it.
- **Claude Code and the Claude Agent SDK.** Report those to Anthropic. covey is a client.
- **A dependency advisory with no path to covey.** Please say which call in this repository
  reaches the weak code.
