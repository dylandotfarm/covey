/**
 * Paint the state. Two screens: the list of projects and threads, and one
 * open thread. Only one is on a phone screen at a time.
 *
 * The list is rebuilt whole on every paint: a few hundred rows is cheap, and
 * nothing on it holds the reader's input. The thread screen is not — its
 * composer holds text the reader typed and the keyboard that is open on it,
 * so the skeleton is built once and kept, and each timeline row is keyed by
 * item id and rebuilt only when the daemon re-sent that item.
 */
import { questionAnswers, questionAsks, threadIsBusy, type ApprovalItem, type QuestionItem, type Thread, type TimelineItem, type ToolCallItem } from "@covey/protocol";
import { clear, h } from "./dom.js";
import { markdownToHtml } from "./markdown.js";
import { addressLink, bindLabel, connectionSummary, isCurrentAddress, openHomes, orderedItems, primaryMachine, projectRows, relTime, threadStatusLabel, threadTone, updateLabel, type MachineSlot, type ProjectRow, type State, type ThreadRef, type View } from "./state.js";

export interface Actions {
  openThread(machine: string, threadId: string): void;
  back(): void;
  send(text: string): void;
  interrupt(): void;
  respondApproval(item: ApprovalItem, behavior: "allow" | "deny", always: boolean): void;
  respondQuestion(item: QuestionItem, answers: string[]): void;
  newThread(machine: string, projectId: string): void;
  /** A project on more than one machine: show the reader which, or hide it again. */
  chooseMachine(rowKey: string): void;
  toggleFold(rowKey: string): void;
  retry(): void;
  setDraft(machine: string, threadId: string, text: string): void;
  toggleAddresses(): void;
  /** Pull, rebuild and restart the daemon on `machine`. Asks first. */
  updateMachine(machine: string): void;
  restartMachine(machine: string): void;
  /** Where `machine` listens from now on: `tailnet`, `all`, or `loopback`. */
  setBind(machine: string, bind: string): void;
}

/** Whether a tap is the reader's pointer. Enter sends on a keyboard and breaks a line on a phone. */
const coarse = () => globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;

export class Renderer {
  private list: HTMLElement;
  private threadScreen: HTMLElement;
  private header: HTMLElement;
  private timeline: HTMLElement;
  private composer: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private banner: HTMLElement;
  private rows = new Map<string, { item: TimelineItem; el: HTMLElement }>();
  private activity: HTMLElement;
  /** `machine:thread` of the view the skeleton holds. */
  private shownThread: string | null = null;
  /** The reader is at the end, so a new row scrolls into view. */
  private atBottom = true;

  constructor(private root: HTMLElement, private a: Actions) {
    this.banner = h("div", { class: "banner hidden", onclick: () => this.a.retry() });
    this.list = h("main", { class: "list" });
    this.header = h("header", { class: "thread-header" });
    this.timeline = h("div", { class: "timeline" });
    this.activity = h("div", { class: "activity" }, h("span", { class: "spinner" }), " working");
    this.composer = h("textarea", { class: "composer", rows: "1", placeholder: "Message", enterkeyhint: "send" });
    this.sendBtn = h("button", { class: "send", type: "button", "aria-label": "Send" }, "↑");
    this.stopBtn = h("button", { class: "stop", type: "button", "aria-label": "Stop" }, "■");
    this.threadScreen = h("main", { class: "thread hidden" }, this.header, this.timeline, h("div", { class: "composer-bar" }, this.composer, this.stopBtn, this.sendBtn));
    root.append(this.banner, this.list, this.threadScreen);

    this.timeline.addEventListener("scroll", () => {
      const t = this.timeline;
      this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 48;
    });
    this.composer.addEventListener("input", () => {
      this.grow();
      if (this.shownThread) { const [machine, threadId] = splitKey(this.shownThread); this.a.setDraft(machine, threadId, this.composer.value); }
    });
    this.composer.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.isComposing) return;
      const sends = (ev.ctrlKey || ev.metaKey) || (!ev.shiftKey && !coarse());
      if (sends) { ev.preventDefault(); this.submit(); }
    });
    this.sendBtn.addEventListener("click", () => this.submit());
    this.stopBtn.addEventListener("click", () => this.a.interrupt());
  }

  private submit() {
    const text = this.composer.value.trim();
    if (!text) return;
    this.a.send(text);
    this.composer.value = "";
    this.grow();
    this.atBottom = true;
  }

  private grow() {
    const c = this.composer;
    c.style.height = "auto";
    c.style.height = `${Math.min(c.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  paint(s: State) {
    this.paintBanner(s);
    if (s.view) { this.list.classList.add("hidden"); this.threadScreen.classList.remove("hidden"); this.paintThread(s, s.view); }
    else { this.threadScreen.classList.add("hidden"); this.list.classList.remove("hidden"); this.shownThread = null; this.paintList(s); }
  }

  private paintBanner(s: State) {
    const b = this.banner;
    const c = connectionSummary(s);
    if (c.state === "connected") { b.classList.add("hidden"); return; }
    b.classList.remove("hidden");
    b.className = `banner ${c.state}`;
    b.textContent = c.text;
  }

  private paintList(s: State) {
    clear(this.list);
    const primary = primaryMachine(s);
    const name = primary?.info?.name ?? location.hostname;
    const others = s.machines.size - 1;
    this.list.append(h("header", { class: "list-header" },
      h("span", { class: "brand" }, "covey"),
      h("span", { class: "machine" }, name, others > 0 ? ` +${others}` : ""),
      h("button", { class: "settings-btn", type: "button", "aria-label": "Settings", onclick: () => this.a.toggleAddresses() }, "⚙"),
    ));
    if (s.showAddresses) { this.list.append(this.settingsPanel(s)); return; }
    const rows = projectRows(s);
    if (rows.length === 0) {
      this.list.append(h("p", { class: "empty" }, primary?.info ? "No projects on any machine yet. Add one from the TUI." : "Waiting for the machine…"));
      return;
    }
    const showMachine = s.machines.size > 1;
    for (const row of rows) {
      const folded = s.folded.has(row.key);
      const count = row.waiting > 0 ? h("span", { class: "count waiting" }, String(row.waiting)) : row.active > 0 ? h("span", { class: "count busy" }, String(row.active)) : null;
      const homes = openHomes(row);
      this.list.append(h("div", { class: "project" },
        h("div", { class: "project-row", onclick: () => this.a.toggleFold(row.key) },
          h("span", { class: "chevron" }, folded ? "›" : "⌄"),
          h("span", { class: "title" }, row.title, showMachine && row.homes.length ? h("small", { class: "homes" }, ` ${row.homes.map((x) => x.machineName).join(" · ")}`) : null),
          count,
          homes.length === 0 ? null : h("button", { class: "new", type: "button", "aria-label": "New thread", onclick: (ev) => {
            ev.stopPropagation();
            if (homes.length === 1) this.a.newThread(homes[0]!.machine, homes[0]!.project.id); else this.a.chooseMachine(row.key);
          } }, "+"),
        ),
        s.choosing === row.key ? this.chooser(row) : null,
        folded ? null : h("div", { class: "threads" },
          ...(row.threads.length === 0 ? [h("div", { class: "none" }, "no threads")] : row.threads.map((t) => this.threadRow(t, showMachine))),
        ),
      ));
    }
  }

  /** Which machine a new thread on a shared project goes to. */
  private chooser(row: ProjectRow): HTMLElement {
    return h("div", { class: "chooser" },
      h("span", { class: "label" }, "New thread on"),
      ...openHomes(row).map((x) => h("button", { type: "button", onclick: () => this.a.newThread(x.machine, x.project.id) }, x.machineName)),
    );
  }

  /**
   * The other ways to reach this daemon. Each one is a link that carries the
   * token, because the address the reader is on now cannot hand its token to
   * another: the browser keeps it per address. One tap on the LAN address
   * from the tailnet page, and the LAN address keeps the token from then on.
   */
  private settingsPanel(s: State): HTMLElement {
    const panel = h("div", { class: "settings" }, h("h2", {}, "Settings"), h("h3", {}, "Machines"));
    for (const m of s.machines.values()) panel.append(this.machineCard(m));
    if (s.machines.size === 1) panel.append(h("p", { class: "hint" }, "Other machines appear here once the TUI starts the web server on this one; it hands over the list."));
    panel.append(h("h3", {}, "Get LAN address"));
    if (!s.access) { panel.append(h("p", { class: "empty" }, primaryMachine(s)?.conn === "connected" ? "asking the machine…" : "connect first")); return panel; }
    panel.append(h("p", { class: "hint" }, "A tailnet address needs no token. Open another address from here one time and it keeps the token."));
    const label = { tailnet: "tailnet", lan: "LAN", mdns: "LAN name" } as const;
    for (const a of s.access.addresses) {
      const current = isCurrentAddress(a.url, location.origin);
      const row = h("div", { class: `address${a.reachable ? "" : " unreachable"}${current ? " current" : ""}` },
        h("span", { class: "kind" }, label[a.kind]),
        current ? h("span", { class: "url" }, a.url, h("small", {}, " · this one")) : h("a", { class: "url", href: addressLink(a, s.access.token) }, a.url),
        a.reachable ? null : h("small", { class: "why" }, "the daemon does not listen here; start it with --bind all"),
      );
      panel.append(row);
    }
    if (s.access.addresses.length === 0) panel.append(h("p", { class: "empty" }, "This machine has no tailnet and no LAN address."));
    return panel;
  }

  /**
   * One machine on the settings page: what it runs, where it listens, and
   * the two things a person at a desk does from the control panel — update
   * it from git, and restart it. Both interrupt the turns it runs, so both
   * ask first.
   */
  private machineCard(m: MachineSlot): HTMLElement {
    const connected = m.conn === "connected";
    const bind = m.info?.settings?.bind;
    const web = m.info?.settings?.webEnabled ? "web server on" : "web server off";
    const progress = updateLabel(m.update);
    return h("div", { class: `machine-card conn-${m.conn}` },
      h("div", { class: "head" },
        h("span", { class: "name" }, m.name),
        h("span", { class: "kind" }, m.primary ? "this page" : "fleet"),
        h("span", { class: `conn` }, m.conn),
      ),
      h("div", { class: "meta" }, m.info ? `${m.info.os}/${m.info.arch} · build ${m.info.daemonVersion} · ${web}` : m.connError ?? m.key),
      progress ? h("div", { class: `progress ${m.update?.state ?? ""}` }, progress) : null,
      bind !== undefined ? h("div", { class: "bind" },
        h("span", { class: "label" }, "Reachable on"),
        ...(["tailnet", "all", "loopback"] as const).map((b) => h("button", { type: "button", class: b === bind ? "chosen" : "", disabled: !connected, onclick: () => this.a.setBind(m.key, b) }, bindLabel(b))),
        ["tailnet", "all", "loopback"].includes(bind) ? null : h("small", {}, `now: ${bind}`),
      ) : null,
      h("div", { class: "buttons" },
        h("button", { type: "button", disabled: !connected, onclick: () => this.a.updateMachine(m.key) }, "Update and restart"),
        h("button", { type: "button", disabled: !connected, onclick: () => this.a.restartMachine(m.key) }, "Restart"),
      ),
    );
  }

  private threadRow(ref: ThreadRef, showMachine: boolean): HTMLElement {
    const t = ref.thread;
    const tone = threadTone(t);
    return h("div", { class: `thread-row tone-${tone}`, onclick: () => this.a.openThread(ref.machine, t.id) },
      h("span", { class: "dot" }),
      h("div", { class: "text" },
        h("div", { class: "title" }, t.pinnedAt ? "★ " : "", t.title),
        h("div", { class: "sub" }, showMachine ? `${ref.machineName} · ` : "", threadStatusLabel(t), t.branch ? ` · ${t.branch}` : ""),
      ),
      h("span", { class: "when" }, relTime(t.lastMessageAt ?? t.updatedAt)),
    );
  }

  private paintThread(s: State, v: View) {
    const t = v.thread;
    clear(this.header);
    this.header.append(
      h("button", { class: "back", type: "button", "aria-label": "Back", onclick: () => this.a.back() }, "‹"),
      h("div", { class: "text" },
        h("div", { class: "title" }, t?.title ?? "…"),
        h("div", { class: `sub tone-${t ? threadTone(t) : "idle"}` }, s.machines.size > 1 ? `${s.machines.get(v.machine)?.name ?? ""} · ` : "", v.loading ? "loading…" : v.error ? v.error : t ? threadStatusLabel(t) : ""),
      ),
    );
    const busy = t ? threadIsBusy(t) : false;
    this.stopBtn.classList.toggle("hidden", !busy || (t?.pendingApprovals ?? 0) > 0);
    this.composer.placeholder = busy ? "Message (queues behind the turn)" : "Message";

    const key = `${v.machine}:${v.threadId}`;
    if (this.shownThread !== key) {
      this.shownThread = key;
      this.rows.clear();
      clear(this.timeline);
      this.atBottom = true;
      this.composer.value = s.drafts.get(key) ?? "";
      this.grow();
    }
    // Keyed rows: only an item the daemon re-sent is rebuilt.
    const items = orderedItems(v);
    const seen = new Set<string>();
    let cursor: Node | null = this.timeline.firstChild;
    for (const item of items) {
      seen.add(item.id);
      let row = this.rows.get(item.id);
      if (!row || row.item !== item) {
        const el = renderItem(item, this.a);
        if (row) row.el.replaceWith(el); else this.timeline.insertBefore(el, cursor);
        row = { item, el };
        this.rows.set(item.id, row);
      }
      if (row.el !== cursor) this.timeline.insertBefore(row.el, cursor);
      else cursor = cursor.nextSibling;
    }
    for (const [id, row] of this.rows) if (!seen.has(id)) { row.el.remove(); this.rows.delete(id); }
    // A turn that runs with nothing streaming yet shows that it runs.
    const last = items[items.length - 1];
    const streaming = last && (last.kind === "assistant" || last.kind === "thinking") && last.streaming;
    const showActivity = !!t && t.latestTurn?.state === "running" && !streaming && t.pendingApprovals === 0;
    this.activity.remove();
    if (showActivity) this.timeline.append(this.activity);
    if (this.atBottom) this.timeline.scrollTop = this.timeline.scrollHeight;
  }
}

/** `machine:thread` back into its two parts. The machine is a URL, so split at the last colon. */
function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

function renderItem(item: TimelineItem, a: Actions): HTMLElement {
  switch (item.kind) {
    case "user":
      return h("div", { class: `msg user${item.queued ? " queued" : ""}` }, h("div", { class: "body" }, item.text), item.queued ? h("span", { class: "tag" }, "queued") : null);
    case "assistant": {
      const el = h("div", { class: `msg assistant${item.streaming ? " streaming" : ""}` });
      el.innerHTML = markdownToHtml(item.text);
      return el;
    }
    case "thinking":
      return h("details", { class: "thinking" }, h("summary", {}, item.streaming ? "thinking…" : "thinking"), h("div", { class: "body" }, item.text));
    case "tool":
      return toolRow(item);
    case "approval":
      return approvalCard(item, a);
    case "question":
      return questionCard(item, a);
    case "note":
      return h("div", { class: `note ${item.tone}` }, item.text);
    case "error":
      return h("div", { class: "note error" }, item.text);
  }
}

function toolRow(item: ToolCallItem): HTMLElement {
  const bg = item.background;
  const status = bg ? `bg-${bg.state}` : item.status;
  const meta = bg ? (bg.state === "running" ? "in the background" : bg.summary ?? bg.state) : item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : "";
  const out = item.output ?? "";
  return h("details", { class: `tool ${status}` },
    h("summary", {}, h("span", { class: "glyph" }, ">_"), " ", h("span", { class: "summary" }, item.summary || item.toolName), meta ? h("span", { class: "meta" }, meta) : null),
    h("pre", { class: "input" }, shortJson(item.input)),
    out ? h("pre", { class: "output" }, out.length > 4000 ? `${out.slice(0, 4000)}\n… (${out.length - 4000} more)` : out) : null,
  );
}

function approvalCard(item: ApprovalItem, a: Actions): HTMLElement {
  const pending = item.status === "pending";
  return h("div", { class: `card approval ${item.status}` },
    h("div", { class: "card-title" }, pending ? "Allow?" : `${item.status}`),
    h("div", { class: "summary" }, item.summary || item.toolName),
    h("pre", { class: "input" }, shortJson(item.input)),
    pending ? h("div", { class: "buttons" },
      h("button", { type: "button", class: "primary", onclick: () => a.respondApproval(item, "allow", false) }, "Allow"),
      item.suggestions?.length ? h("button", { type: "button", onclick: () => a.respondApproval(item, "allow", true) }, "Always") : null,
      h("button", { type: "button", class: "danger", onclick: () => a.respondApproval(item, "deny", false) }, "Deny"),
    ) : null,
  );
}

function questionCard(item: QuestionItem, a: Actions): HTMLElement {
  const asks = questionAsks(item);
  const given = questionAnswers(item);
  const pending = item.status === "pending";
  const answers: string[] = asks.map((_, i) => given[i] ?? "");
  const card = h("div", { class: `card question ${item.status}` });
  asks.forEach((ask, i) => {
    const block = h("div", { class: "ask" });
    if (ask.header) block.append(h("span", { class: "chip" }, ask.header));
    block.append(h("div", { class: "prompt" }, ask.question));
    if (!pending) { block.append(h("div", { class: "answer" }, given[i] ?? "—")); card.append(block); return; }
    const opts = h("div", { class: "options" });
    for (const o of ask.options ?? []) {
      const b = h("button", { type: "button", onclick: () => {
        answers[i] = o.label;
        for (const x of opts.querySelectorAll("button")) x.classList.toggle("chosen", x === b);
        // One question with options answers on the tap. More than one waits for the send.
        if (asks.length === 1) a.respondQuestion(item, answers);
      } }, o.label, o.description ? h("small", {}, o.description) : null);
      opts.append(b);
    }
    const free = h("input", { type: "text", placeholder: ask.options ? "Or type an answer" : "Your answer" });
    free.addEventListener("input", () => { answers[i] = free.value; });
    free.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && answers.every(Boolean)) a.respondQuestion(item, answers); });
    block.append(opts, free);
    card.append(block);
  });
  if (pending && (asks.length > 1 || asks.every((x) => !x.options))) {
    card.append(h("div", { class: "buttons" }, h("button", { type: "button", class: "primary", onclick: () => { if (answers.every(Boolean)) a.respondQuestion(item, answers); } }, "Answer")));
  }
  return card;
}

function shortJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
    return s.length > 1200 ? `${s.slice(0, 1200)}…` : s;
  } catch { return String(v); }
}
