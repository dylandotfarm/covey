---
name: covey
description: Take a GitHub issue to completion inside a covey thread. Take the issue, do the work on the thread's branch, open the pull request through covey, and act on each checks verdict, review and comment that covey sends back as a message, until the pull request merges. Use when the user types /covey, names an issue to take or finish, or asks for a pull request that covey should watch or merge.
---

# The covey loop

You run inside a covey thread when the environment holds `COVEY_THREAD_ID`.
The thread has its own git worktree on its own branch, and the covey daemon
on this machine can push that branch, open a pull request for it, watch the
pull request, and merge it. You ask with the `covey` command. Everything
GitHub says about the pull request comes back to you as a new message that
starts with `covey watch:`. You never poll.

If `COVEY_THREAD_ID` is not set, you are not in a covey thread. Say so and do
the work the ordinary way, with `gh`.

## The user's words decide who merges

- "merge when you're done", "automerge", "land it": open with `--auto`.
  Covey merges once the checks pass against the current base and no review
  asks for changes.
- Anything else, and every case where the user wants to look first: open
  without `--auto`. A person merges. This is the default, because a merge is
  the one act in the loop a person cannot take back.

Never merge a pull request yourself, and never run `covey pr policy auto`
unless the user told you to merge on their behalf.

## Steps

1. **Take the issue.** Run `covey issue take <n>`. If covey answers that
   another thread holds it, stop and tell the user: two agents must not work
   one issue. A run member already holds its issue; the command then says so
   and changes nothing.
2. **Read the issue** with `gh issue view <n> --comments`. Read the code it
   names. Do the work on the branch you are on. Commit as you go, with a
   message that says what changed and why.
3. **Prove it.** Run the project's tests and build before you open anything.
   Read the repository's `CLAUDE.md` or `CONTRIBUTING.md` for the command.
4. **Open the pull request** through covey, not by hand:

   ```
   covey pr open --title "<one line, what changed>" --body-file /tmp/pr-body.md [--auto]
   ```

   Write the body to a file first: what changed, why, and how you tested it.
   Covey adds `Closes #<n>` when the body does not name the issue. Do not run
   `git push` or `gh pr create` for this; covey pushes the branch itself.
5. **Stop the turn.** Say which pull request you opened and what you are
   waiting for. Covey sends the next answer as a message.
6. **Act on each message from covey.** Each starts with `covey watch:` and
   lists what happened. Then:
   - *The checks failed.* Read the failure: `gh run view <run id> --log-failed`
     with the run id from the URL, or `gh pr checks`. Fix it, run the tests
     locally, commit, and `git push`. Covey watches the new checks. Say what
     you changed and stop the turn.
   - *The branch conflicts with the base*, or *the checks passed against an
     older base*: `git fetch origin && git merge origin/<base>`, resolve,
     test, commit, `git push`.
   - *A review asks for changes*, or *a comment*: make the change or answer
     it. Reply on the pull request with `gh pr comment <n> --body "..."` so the
     reviewer sees the answer where they asked. Push, then stop the turn.
   - *The checks passed* and the policy is manual: nothing to do. Say the
     pull request is ready for a person. Stop the turn.
   - *Covey merged the pull request*, or *the pull request was merged*: the
     loop is done. Give a two-line summary and stop.
   - *Blocked*: covey sent as many rounds as it may, or watched for too long.
     Stop. Tell the user what still fails and what you tried.
7. **Check the state** at any time with `covey pr status`.

## What not to do

- Do not poll `gh pr view`, `gh pr checks` or `gh run list` in a loop. Covey
  wakes you when there is news, even when your session was released.
- Do not open a second pull request for the same thread.
- Do not push to the base branch, and do not merge.
- Do not stop covey's watch (`covey pr watch --stop`) unless the user asks.

## Reference

```
covey issue take <n>          record the issue this thread owns
covey issue drop              clear it
covey pr open --title "…" [--body "…" | --body-file F] [--draft] [--auto] [--squash|--rebase] [--rounds N]
covey pr watch <n> [--auto]   watch a pull request opened by hand
covey pr watch --stop         stop the watch
covey pr policy auto|manual   change who merges
covey pr status               the issue, the pull request and the watch of this thread
```

`--rounds N` bounds how many messages that ask for more work covey sends
before it hands the thread to a person. The default is three.
