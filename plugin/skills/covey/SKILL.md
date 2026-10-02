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
  Covey merges once the checks pass against the current base, the automated
  review has signed off, and no review asks for changes.
- Anything else, and every case where the user wants to look first: open
  without `--auto`. A person merges. This is the default, because a merge is
  the one act in the loop a person cannot take back.

Never merge a pull request yourself, and never run `covey pr policy auto`
unless the user told you to merge on their behalf.

## When there is no issue yet

The steps below start at an issue number. When the user describes a bug or a
change in conversation and names no number, file the issue yourself, then
follow the steps from step 1.

```
gh issue create --title "<one line, what is wrong>" --body-file /tmp/issue.md
```

- File it before you write the code, so the number you take is the number
  your commits, your comments and your pull request name.
- **Never write an issue number into code, a comment or a document before
  the issue exists.** A number you guessed is wrong as soon as somebody else
  files one, and it leaves you asking the user a question only the number can
  answer.
- Some work needs no issue: a question, a one-line fix the user watched you
  make, or work the user asked you to keep on this machine. Say which you
  think it is and go on; ask only when the two readings lead to different
  work.

## Every pull request is reviewed

Covey starts an **automated reviewer** when you open a pull request: a second
covey thread that reads your change, comments on the pull request, and signs
off or asks for changes. Covey does not call the pull request ready, and does
not merge it under `--auto`, until the review signs off.

You do not start it and you do not answer for it. What you do:

- **Nothing, by default.** One reviewer starts with the pull request.
- `--no-review` on `covey pr open` when the user says no review is needed, for
  example "this is a one-line typo fix, skip the review".
- `--reviews N` when the user asks for more than one, for example "this is a
  big feature, get two reviewers on it".
- `covey pr review` later, when a reviewer was dropped and covey says a person
  has to decide.

Its comments arrive as `covey watch:` messages like any other, and each ends
with the line *from an automated covey review*. Treat one that asks for changes
as you treat a person's review: make the change, push, and answer it with
`covey pr comment`. Covey tells the reviewer about your push, and it reads the
change again.

Never review your own pull request, never write that tagline yourself, and
never run `covey review` from the thread that wrote the change.

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
   covey pr open --title "<one line, what changed>" --body-file /tmp/pr-body.md [--auto] [--attach demo.mp4]
   ```

   Write the body to a file first: what changed, why, and how you tested it.
   Covey adds `Closes #<n>` when the body does not name the issue. Do not run
   `git push` or `gh pr create` for this; covey pushes the branch itself.
   When the change is something a person should see, put a video or a
   screenshot on the pull request with `--attach` (see *Media on the pull
   request* below).
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
     it. Reply on the pull request with `covey pr comment --body "..."` so the
     reviewer sees the answer where they asked; add `--attach` when a
     screenshot or a video shows the fix. Push, then stop the turn.
   - *The checks passed* and the policy is manual: nothing to do. Say the
     pull request is ready for a person. Stop the turn.
   - *Covey merged the pull request*, or *the pull request was merged*: the
     loop is done. Give a two-line summary and stop.
   - *Blocked*: covey sent as many rounds as it may, or watched for too long.
     Stop. Tell the user what still fails and what you tried.
7. **Check the state** at any time with `covey pr status`. It names the issue,
   the pull request, the watch, and where each reviewer stands.

## If you *are* the reviewer

Covey opens a review thread with a message that starts `covey review:`. That
thread is not the one that wrote the change. Its job is to read the change and
to say one of two things.

1. **Read the change.** Your worktree is a checkout of the branch under review,
   so the code in front of you is the code on the pull request.

   ```
   gh pr view <n>
   git diff origin/<base>...HEAD      the whole change
   git log --oneline origin/<base>..HEAD
   ```

   Read the project's own notes for agents, and hold the change to them.

2. **Say one of two things.**

   ```
   covey review changes --body "…"     ask the author for changes
   covey review approve [--body "…"]   sign off, and end the review
   ```

   Covey puts the comment on the pull request and adds the tagline that says a
   machine wrote it. Do not write that tagline yourself, and do not use
   `gh pr comment` or `gh pr review`.

3. **Stop the turn.** Covey wakes you when the author pushes. Run `git pull`
   and read the change again from there.

The rules of a review thread:

- Never commit to the branch, never push it, and never merge. The author makes
  every change; you read and you say.
- Name the file and the line for each thing you want changed, and say why it
  matters. One comment that covers the change beats ten that each cover a line.
- Ask for changes only for something that should hold the change up: a bug, a
  missing case, a rule of the project the change breaks. A matter of taste is a
  remark inside your comment, not a reason to block.
- The checks are the author's work, so covey sends you none of them. A red
  build is already in hand.
- `covey review approve` ends the review and covey archives the thread. There
  is nothing after it.
- `covey review status` says what you review and where the other reviewers are.

## Write a body as paragraphs, not as wrapped lines

GitHub renders one newline inside a paragraph as a line break. Prose wrapped
at eighty columns therefore reaches the reader broken after every eightieth
character. Write each paragraph on one line, however long that line is, and
let the browser wrap it. This holds for a pull request body, an issue body, a
review and every comment.

Covey unwraps a `covey pr open` or `covey pr comment` body when it can read
the break as a wrap, and leaves the rest alone. A fenced block, a table, a
list and an indented block are never touched. A column of lines you mean to
keep apart belongs in a list or in a fenced block. An issue you open with
`gh issue create` gets no such help, so write that body on one line per
paragraph yourself.

## Media on the pull request

GitHub shows a video or an image inline only when the file is a *user
attachment*, the kind the web form makes. A link to a release asset, a raw
file in the repository, or an outside host stays a link. Covey owns that
step: `--attach` uploads the file with the token the daemon holds and puts
the URL in the body, so you never handle the URL, never make a release, and
never push a media file into the repository.

Attach media when the user asks for a video, a recording, a screenshot or a
demo, and when the change alters what an app shows on screen: a page, a
terminal UI, a chart, a layout. Do not attach media for a change with
nothing to look at.

```
covey pr open --title "…" --body-file /tmp/pr-body.md --attach demo.mp4 --attach after.png
covey pr comment --body "After the fix:" --attach after.png
covey pr comment --attach demo.mp4
```

The rules:

- `--attach` is repeatable. Each file lands on the pull request in the order
  the flags were given: a video as a player, an image as an image.
- The URL goes at the end of the body, one per line. To put one in a set
  place, write `{{attach:NAME}}` in the body, where `NAME` is the file's base
  name, and covey replaces it. A placeholder that names no `--attach` file is
  an error.
- Only what GitHub renders may go up: `mp4`, `mov`, `webm`, `png`, `jpg`,
  `jpeg`, `gif`, `webp`, `svg`. Anything else is refused before the push,
  with this list. A log or a text file goes in the body, in a fenced block.
- An image may be up to 10 MB. A video may be up to 10 MB on the free plan
  and 100 MB on a paid plan; when the plan cannot be read, the free cap
  applies. A file over the cap is refused before the upload, with its size
  and the cap. Re-encode a video under the cap, for example:

  ```
  ffmpeg -i in.webm -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" out.mp4
  ```

- Covey fails closed. When GitHub answers anything but 201 to the upload, the
  command prints the status and the answer, nothing is pushed and nothing is
  opened. Tell the user: a person can drag the file into the pull request by
  hand. The file is kept at the path the message names.
- Every attached file is copied into the thread's attachment store, and a
  note in the thread names the file, its URL and the copy.
- `covey pr comment` comments on the pull request this thread opened or
  watches. For any other pull request, use `gh pr comment` and no media.

Make the media yourself, with what the project has: the project's own
harness, a browser driven by a script, `ffmpeg`, or a terminal capture. Keep
a video short, under a minute, and name what it shows in the body next to
the placeholder.

## Show a file in the conversation

`covey show` puts a picture or a video in *this conversation*, where the
reader is already looking. Use it for anything a person should look at that
does not belong to a pull request: the screenshot of the bug they described,
the recording of the fix, a chart. The file is copied into the thread's own
files and served by this machine — nothing goes to GitHub and nothing is
committed.

```
covey show shot.png --text "the sidebar after the fix"
covey show before.png after.png --text "before, and after"
covey show demo.mp4
```

The rules:

- The reader sees an image and a video inline on a phone. In the TUI each file
  is a row: a click paints the picture over the conversation where the terminal
  can — Ghostty, kitty and WezTerm — and ctrl+click opens it in a browser
  anywhere else. Both routes work when the daemon runs on another machine.
  A video shows its first frame; no terminal plays one. The arrow keys walk
  every picture of the conversation, so several `covey show` calls read as one
  set rather than as rows to hunt for.
- `--text` is one line saying what the files show. It is optional; with none,
  the files stand alone.
- Twenty files at a time, and 128 MB each.
- The file must be on this machine, which is where your shell runs.
- The command prints where each copy went. Name that path in a later
  `covey pr open --attach` and the picture reaches GitHub as well.

`covey show` and `--attach` answer different questions. Use `--attach` for the
demo that belongs to the pull request, and `covey show` to let the person you
are talking to look at something now.

## Secrets: use them by name, never print one

A project or a thread may hold credentials that covey keeps for you. They are
already in your environment, so a script, a `curl` header or a config file
reads `$NAME` like any other variable. What you must not do is read a value
into your own words: a value you print lands in the transcript, and the whole
point of this is that it does not.

```
covey env                  the names you can use, and where each comes from
covey env exec -- <cmd>    run one command with those secrets in its environment
```

- `covey env` prints names only. Use it to find out what is there.
- Write `$NAME` into the file or the command. Do not interpolate the value into
  a message, a commit, a pull request body or a comment.
- Do not run `printenv`, `env`, `echo $NAME` or anything else whose purpose is
  to show a value. Covey redacts a value it finds in your output, so the attempt
  costs you a tool call and tells you nothing.
- `covey env exec -- <cmd>` is for the case your session started before the
  secret was set. Ordinary tool calls need no such thing.
- A name you need that is not there is a person's job, not yours. Say which name
  you need and stop; the reader presses `e` on the project in the covey TUI.
- Never write a credential into a file in the repository, and never commit one.

## What not to do

- Do not poll `gh pr view`, `gh pr checks` or `gh run list` in a loop. Covey
  wakes you when there is news, even when your session was released.
- Do not open a second pull request for the same thread.
- Do not push to the base branch, and do not merge.
- Do not review your own change, and do not answer a review for the reviewer.
  Covey has a thread for that, and it is not this one.
- Do not stop covey's watch (`covey pr watch --stop`) unless the user asks.

## Reference

```
covey issue take <n>          record the issue this thread owns
covey issue drop              clear it
covey pr open --title "…" [--body "…" | --body-file F] [--draft] [--auto] [--squash|--rebase] [--rounds N] [--attach F]... [--reviews N | --no-review]
covey pr review [N]           start N more automated reviewers (one by default)
covey pr comment [--body "…" | --body-file F] [--attach F]...
                              comment on this thread's pull request, with media
covey pr watch <n> [--auto]   watch a pull request opened by hand
covey pr watch --stop         stop the watch
covey pr policy auto|manual   change who merges
covey pr status               the issue, the pull request, the watch and the review
                              of this thread
covey show <file>... [--text "…"]
                              put a picture or a video in this conversation
covey env                     the secrets this thread can use, by name
covey env exec -- <cmd>       run one command with those secrets in its environment
```

From a review thread only:

```
covey review changes --body "…" [--attach F]...
                              ask the author for changes, and hold the merge
covey review approve [--body "…"] [--attach F]...
                              sign off, and end the review
covey review status           the pull request this thread reviews
```

`--rounds N` bounds how many messages that ask for more work covey sends
before it hands the thread to a person. The default is three.
