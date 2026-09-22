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
import { acceptCommand, commandLabel } from "@covey/client";
import { questionAnswers, questionAsks, threadIsBusy, type ApprovalItem, type GitHubAction, type GitHubItem, type MergeMethod, type QuestionItem, type SlashCommandInfo, type Thread, type ThreadCommands, type TimelineItem, type ToolCallItem } from "@covey/protocol";
import { commandMenuFor, stepRow, type CommandMenu } from "./commandMenu.js";
import { clear, h, type Child } from "./dom.js";
import { markdownToHtml } from "./markdown.js";
import { addressLink, bindLabel, checksLabel, connectionSummary, findRefs, holderOf, isCurrentAddress, itemActions, itemStateLabel, mediaSrc, openHomes, orderedItems, primaryMachine, projectRows, relTime, sheetChoices, sheetKey, sheetNote, sheetRows, sheetTitle, threadRefs, threadStatusLabel, threadTone, updateLabel, type ItemView, type MachineSlot, type ProjectRow, type SheetTarget, type State, type ThreadRef, type View } from "./state.js";

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
  /** Take a thread off the list. The TUI can bring it back. */
  archiveThread(machine: string, threadId: string): void;
  /** Put an issue or a pull request on screen (#108). The URL names it. */
  openItem(machine: string, projectId: string, number: number): void;
  /** Read the item on screen again. */
  refreshItem(): void;
  /** One act on the item on screen: a review, a comment, a merge, a close or a reopen. */
  actItem(action: GitHubAction): void;
  setItemDraft(text: string): void;
  /** Open the settings sheet over the page, for a conversation or a machine. */
  openSheet(target: SheetTarget): void;
  closeSheet(): void;
  /** Show the choices of one setting, or `""` to go back to the list. */
  sheetPage(page: string): void;
  /** Take a choice on the page the sheet is on. The sheet then closes. */
  sheetChoose(id: string): void;
  /** Take a row that acts instead of opening choices: rename, archive. */
  sheetAct(id: string): void;
}

/** How far a row slides to show the button under it, in CSS pixels. Matches `.swipe .archive` in app.css. */
const SWIPE_REVEAL = 88;
/** A drag past this is a swipe; short of it the row goes back. */
const SWIPE_COMMIT = SWIPE_REVEAL / 2;
/** Fingers wobble. Less than this is a tap, or the start of a scroll. */
const SWIPE_SLOP = 8;
/** A finger that rests this long on a thread row holds it, and the sheet comes up (#115). */
const HOLD_MS = 450;

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
  /** The `/` popover over the bottom of the timeline. */
  private menuEl: HTMLElement;
  /** What the popover shows, while it is open. */
  private menu: CommandMenu | null = null;
  private menuIndex = 0;
  /** The token the reader dismissed with escape; the popover stays shut until the token changes. */
  private menuClosedFor: string | null = null;
  /** The open thread's commands, as of the last paint. */
  private commands: ThreadCommands = null;
  private rows = new Map<string, { item: TimelineItem; el: HTMLElement }>();
  private activity: HTMLElement;
  /** `machine:thread` of the view the skeleton holds. */
  private shownThread: string | null = null;
  /** The reader is at the end, so a new row scrolls into view. */
  private atBottom = true;
  /** The `machine:thread` whose row is slid open, showing its button. */
  private swiped: string | null = null;
  /** A drag or a hold just ended, so the click that follows it is not a tap. */
  private suppressClick = false;
  /** The issue or pull request screen (#108): a header, a scrolling body, and the bar of acts. */
  private itemScreen: HTMLElement;
  private itemHeader: HTMLElement;
  private itemBody: HTMLElement;
  private itemBar: HTMLElement;
  private itemDraft: HTMLTextAreaElement;
  /** The item the body was built from, so a paint that changed nothing keeps the scroll. */
  private shownItem: { key: string; item: GitHubItem | null; error: string | null; loading: boolean } | null = null;
  /** How the Merge button merges. A select beside it changes this. */
  private mergeMethod: MergeMethod = "merge";
  /** The item's act was in flight at the last paint, so the paint that ends it takes the draft the state holds. */
  private itemWasBusy = false;
  /** An image full size over the page (#110). A tap anywhere shuts it. */
  private lightbox: HTMLElement;
  private lightboxImg: HTMLImageElement;
  /** How markdown loads its media: a GitHub attachment through the daemon, with the page's token. */
  private markdown: { media: (url: string) => string };
  /** The settings sheet over the page (#117): a scrim, and a panel at the foot. */
  private sheet: HTMLElement;
  private sheetPanel: HTMLElement;
  /** What the panel was built from, so a paint mid-turn leaves the sheet alone. */
  private shownSheet: string | null = null;

  /**
   * `token` is the one the page holds for a LAN address, so the media route
   * can authenticate an `<img>` request; a tailnet or a loopback page holds
   * none and needs none.
   */
  constructor(private root: HTMLElement, private a: Actions, token: string | undefined = undefined) {
    this.markdown = { media: (url) => mediaSrc(url, token) };
    this.banner = h("div", { class: "banner hidden", onclick: () => this.a.retry() });
    this.list = h("main", { class: "list" });
    this.header = h("header", { class: "thread-header" });
    this.timeline = h("div", { class: "timeline" });
    this.activity = h("div", { class: "activity" }, h("span", { class: "spinner" }), " working");
    this.composer = h("textarea", { class: "composer", rows: "1", placeholder: "Message", enterkeyhint: "send" });
    this.sendBtn = h("button", { class: "send", type: "button", "aria-label": "Send" }, "↑");
    this.stopBtn = h("button", { class: "stop", type: "button", "aria-label": "Stop" }, "■");
    // A tap on a row must not take the focus, and with it the keyboard, off the composer.
    this.menuEl = h("div", { class: "cmd-menu hidden", role: "listbox", onmousedown: (ev) => ev.preventDefault() });
    this.threadScreen = h("main", { class: "thread hidden" }, this.header, this.timeline, h("div", { class: "composer-bar" }, this.menuEl, this.composer, this.stopBtn, this.sendBtn));
    this.itemHeader = h("header", { class: "thread-header" });
    this.itemBody = h("div", { class: "item-body" });
    this.itemDraft = h("textarea", { class: "composer", rows: "2", placeholder: "Comment, or the text of a review" });
    this.itemDraft.addEventListener("input", () => this.a.setItemDraft(this.itemDraft.value));
    this.itemBar = h("div", { class: "item-bar" });
    this.itemScreen = h("main", { class: "item hidden" }, this.itemHeader, this.itemBody, this.itemBar);
    this.lightboxImg = h("img", { alt: "" });
    this.lightbox = h("div", { class: "lightbox hidden", onclick: () => this.closeLightbox() }, this.lightboxImg);
    this.sheetPanel = h("div", { class: "sheet-panel", role: "dialog", "aria-modal": "true" });
    // A tap on the scrim, and only on the scrim, shuts the sheet.
    this.sheet = h("div", { class: "sheet hidden", onclick: (ev) => { if (ev.target === this.sheet) this.a.closeSheet(); } }, this.sheetPanel);
    root.append(this.banner, this.list, this.threadScreen, this.itemScreen, this.lightbox, this.sheet);
    // A `#N` anywhere in the transcript, or in an item's own text, opens that
    // item, and an inline image opens full size. One listener per surface;
    // the anchor carries only the number, the image its own source.
    this.timeline.addEventListener("click", (ev) => this.refClick(ev));
    this.itemBody.addEventListener("click", (ev) => this.refClick(ev));
    addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!this.lightbox.classList.contains("hidden")) { this.closeLightbox(); return; }
      if (!this.sheet.classList.contains("hidden")) this.a.closeSheet();
    });

    this.timeline.addEventListener("scroll", () => {
      const t = this.timeline;
      this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 48;
    });
    this.composer.addEventListener("input", () => this.draftChanged());
    this.composer.addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      // While the popover is open it takes the keys that mean "choose", and
      // nothing else: every other key edits the draft, and editing the draft
      // is what filters the list.
      if (this.menu) {
        if (ev.key === "Escape") { ev.preventDefault(); this.menuClosedFor = this.menu.token; this.paintMenu(); return; }
        if (this.menu.commands.length > 0) {
          if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { ev.preventDefault(); this.menuIndex = stepRow(this.menuIndex, ev.key === "ArrowUp" ? -1 : 1, this.menu.commands.length); this.paintMenu(); return; }
          if ((ev.key === "Tab" && !ev.shiftKey) || (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey)) {
            ev.preventDefault();
            this.takeCommand(this.menu.commands[this.menuIndex]!);
            return;
          }
        }
      }
      if (ev.key !== "Enter") return;
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
    this.draftChanged();
    this.atBottom = true;
  }

  /** The draft is different: size the box, keep the text, and refilter the popover. */
  private draftChanged() {
    this.grow();
    if (this.shownThread) { const [machine, threadId] = splitKey(this.shownThread); this.a.setDraft(machine, threadId, this.composer.value); }
    this.paintMenu();
  }

  /**
   * Take a row: the draft becomes the name and a space, which is no longer a
   * bare name, so the popover closes. The reader goes on to the arguments.
   */
  private takeCommand(c: SlashCommandInfo) {
    const { value, caret } = acceptCommand(c);
    this.composer.value = value;
    this.composer.setSelectionRange(caret, caret);
    this.composer.focus();
    this.draftChanged();
  }

  /**
   * Paint the popover for the draft in the box. Called on every keystroke,
   * and again when the thread's list changes under an open popover: the SDK
   * pushes a new one when it finds more skills.
   */
  private paintMenu() {
    const next = commandMenuFor(this.composer.value, this.commands);
    if (!next || next.token === this.menuClosedFor) {
      this.menu = null;
      this.menuEl.classList.add("hidden");
      clear(this.menuEl);
      return;
    }
    // A new token starts at the top, and forgets the escape that shut the old one.
    if (this.menu?.token !== next.token) { this.menuIndex = 0; this.menuClosedFor = null; }
    this.menuIndex = stepRow(this.menuIndex, 0, next.commands.length);
    this.menu = next;
    clear(this.menuEl);
    this.menuEl.classList.remove("hidden");
    if (next.commands.length === 0) {
      this.menuEl.append(h("div", { class: "cmd-empty" }, next.empty));
      return;
    }
    let chosen: HTMLElement | null = null;
    next.commands.forEach((c, i) => {
      const selected = i === this.menuIndex;
      const row = h("div", { class: `cmd-row${selected ? " selected" : ""}`, role: "option", "aria-selected": selected ? "true" : "false", onclick: () => this.takeCommand(c) },
        h("span", { class: "name" }, commandLabel(c)),
        c.description ? h("span", { class: "hint" }, c.description) : null,
      );
      this.menuEl.append(row);
      if (selected) chosen = row;
    });
    // The list scrolls; the highlighted row stays on screen.
    (chosen as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }

  private grow() {
    const c = this.composer;
    c.style.height = "auto";
    c.style.height = `${Math.min(c.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  paint(s: State) {
    this.paintBanner(s);
    // The sheet sits over every screen, so it is painted before the one under
    // it is chosen and it survives a move between them.
    this.paintSheet(s);
    // The item sits over whatever it was opened from. The thread under it is
    // not painted meanwhile; its rows are keyed, so the return folds in what
    // arrived. A thread that is no longer on screen loses its skeleton, so a
    // return to it starts clean.
    this.itemScreen.classList.toggle("hidden", !s.item);
    if (!s.view) { this.shownThread = null; this.commands = null; }
    if (s.item) { this.list.classList.add("hidden"); this.threadScreen.classList.add("hidden"); this.paintItem(s, s.item); return; }
    this.shownItem = null;
    if (s.view) { this.list.classList.add("hidden"); this.threadScreen.classList.remove("hidden"); this.paintThread(s, s.view); }
    else { this.threadScreen.classList.add("hidden"); this.list.classList.remove("hidden"); this.paintList(s); }
  }

  /** A tap on an inline image: the same image, full size, over the page. */
  private openLightbox(img: HTMLImageElement) {
    this.lightboxImg.src = img.currentSrc || img.src;
    this.lightboxImg.alt = img.alt;
    this.lightbox.classList.remove("hidden");
  }

  private closeLightbox() {
    this.lightbox.classList.add("hidden");
    this.lightboxImg.removeAttribute("src");
  }

  /** A click on a `#N` anchor opens the item of the thread on screen, or of the item on screen; one on an image opens it full size. */
  private refClick(ev: Event) {
    const target = ev.target as HTMLElement | null;
    if (target instanceof HTMLImageElement && target.classList.contains("media")) { ev.preventDefault(); this.openLightbox(target); return; }
    const a = target?.closest?.("a.ref") as HTMLElement | null;
    if (!a) return;
    ev.preventDefault();
    const number = Number(a.dataset.number);
    if (!number) return;
    const scope = this.refScope?.();
    if (scope) this.a.openItem(scope.machine, scope.projectId, number);
  }

  /** Where a `#N` points: set by the paint of the surface that holds the anchor. */
  private refScope: (() => { machine: string; projectId: string } | null) | null = null;

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
          // A row that works from a named branch says which. Two rows of one
          // repository differ only in the base, and the reader has to see
          // whether this thread starts from `main` or from a feature branch.
          h("span", { class: "title" }, row.title,
            row.base ? h("small", { class: "base" }, ` · ${row.base}`) : null,
            showMachine && row.homes.length ? h("small", { class: "homes" }, ` ${row.homes.map((x) => x.machineName).join(" · ")}`) : null),
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
        // The defaults every new thread on this machine inherits (#117).
        h("button", { class: "opts", type: "button", "aria-label": `Settings for ${m.name}`, disabled: !connected, onclick: () => this.a.openSheet({ kind: "machine", machine: m.key }) }, "⋮"),
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

  /**
   * A thread row slides left under a finger to show the button beneath it.
   *
   * The browser keeps vertical scrolling for itself (`touch-action: pan-y`),
   * so a drag reaches here only when it is more sideways than up. A tap on
   * a row that is slid open closes it; a tap anywhere else closes whatever
   * is open. The list is rebuilt on every paint, so which row is open lives
   * on the renderer, not on the element.
   */
  private threadRow(ref: ThreadRef, showMachine: boolean): HTMLElement {
    const t = ref.thread;
    const key = `${ref.machine}:${t.id}`;
    const tone = threadTone(t);
    const front = h("div", { class: `thread-row tone-${tone}`, onclick: () => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (this.swiped) { this.closeSwipe(); return; }
      this.a.openThread(ref.machine, t.id);
    } },
      h("span", { class: "dot" }),
      h("div", { class: "text" },
        h("div", { class: "title" }, t.pinnedAt ? "★ " : "", t.title),
        h("div", { class: "sub" }, showMachine ? `${ref.machineName} · ` : "", threadStatusLabel(t), t.branch ? ` · ${t.branch}` : "", this.refChips(ref.machine, t, false)),
      ),
      h("span", { class: "when" }, relTime(t.lastMessageAt ?? t.updatedAt)),
    );
    const wrap = h("div", { class: `swipe${this.swiped === key ? " open" : ""}` },
      h("button", { class: "archive", type: "button", onclick: () => { this.swiped = null; this.a.archiveThread(ref.machine, t.id); } }, "Archive"),
      front,
    );
    this.attachSwipe(wrap, front, key, () => this.a.openSheet({ kind: "thread", machine: ref.machine, threadId: t.id }));
    return wrap;
  }

  // ---- the settings sheet (#117) ---------------------------------------

  /**
   * The sheet at the foot of the page: a list of settings, or the choices of
   * one of them. It is rebuilt only when what it says changes, because a paint
   * runs on every frame of a running turn and a panel rebuilt under a finger
   * loses the tap that was on its way.
   */
  private paintSheet(s: State) {
    const sh = s.sheet;
    this.sheet.classList.toggle("hidden", !sh);
    if (!sh) {
      if (this.shownSheet === null) return;
      // The class goes with the content, so the next open animates again.
      clear(this.sheetPanel);
      this.sheetPanel.classList.remove("opening");
      this.shownSheet = null;
      return;
    }
    const key = sheetKey(s, sh);
    if (key === this.shownSheet) return;
    const fresh = this.shownSheet === null;
    this.shownSheet = key;
    clear(this.sheetPanel);
    this.sheetPanel.append(h("div", { class: "sheet-head" },
      sh.page ? h("button", { class: "back", type: "button", "aria-label": "Back", onclick: () => this.a.sheetPage("") }, "‹") : null,
      h("span", { class: "title" }, sheetTitle(s, sh)),
      h("button", { class: "close", type: "button", "aria-label": "Close", onclick: () => this.a.closeSheet() }, "✕"),
    ));
    const note = sheetNote(s, sh);
    if (note) this.sheetPanel.append(h("p", { class: "sheet-note" }, note));
    if (sh.page) {
      for (const c of sheetChoices(s, sh)) {
        this.sheetPanel.append(h("button", { class: `sheet-row${c.current ? " current" : ""}`, type: "button", onclick: () => this.a.sheetChoose(c.id) },
          h("span", { class: "text" }, h("span", { class: "label" }, c.label), c.hint ? h("span", { class: "hint" }, c.hint) : null),
          h("span", { class: "tick" }, c.current ? "✓" : ""),
        ));
      }
    } else {
      for (const r of sheetRows(s, sh)) {
        this.sheetPanel.append(h("button", { class: `sheet-row${r.tone ? ` ${r.tone}` : ""}`, type: "button", onclick: () => (r.choices ? this.a.sheetPage(r.id) : this.a.sheetAct(r.id)) },
          h("span", { class: "text" }, h("span", { class: "label" }, r.label)),
          r.value ? h("span", { class: "value" }, r.value) : null,
          r.choices ? h("span", { class: "chevron" }, "›") : null,
        ));
      }
    }
    // A sheet that has just opened slides up from the foot. A page inside it
    // does not: the panel is already there and only its rows changed.
    this.sheetPanel.classList.toggle("opening", fresh);
  }

  /**
   * The issue a thread took and the pull request it opened (#108). On the
   * header of the open thread each chip is a button that opens the item. In
   * the list it is text: the whole row is one target there, and a thumb that
   * meant the row used to hit the chip (#115). A hold on the row opens the
   * sheet instead, and the sheet names each item in full.
   */
  private refChips(machine: string, t: Thread, interactive: boolean): HTMLElement | null {
    const refs = threadRefs(t);
    if (refs.length === 0) return null;
    if (!interactive) return h("span", { class: "refs" }, ...refs.map((r) => h("span", { class: `ref ${r.kind}` }, r.label)));
    return h("span", { class: "refs" }, ...refs.map((r) => h("button", { type: "button", class: `ref ${r.kind}`, onclick: (ev) => { ev.stopPropagation(); this.a.openItem(machine, t.projectId, r.number); } }, r.label)));
  }

  /**
   * The gestures on one thread row: a drag left reveals the archive button,
   * and a finger that rests calls `hold`. Every row holds, so a slow tap
   * never opens a thread on one row and a sheet on the next.
   */
  private attachSwipe(wrap: HTMLElement, front: HTMLElement, key: string, hold: () => void) {
    let startX = 0, startY = 0, base = 0, offset = 0;
    let pointer: number | null = null;
    /** Null until the drag has said which way it goes. */
    let sideways: boolean | null = null;
    /** The timer that runs while a finger rests on the row. */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    /** The hold fired, so the tap that ends it must not open the thread. */
    let held = false;
    const dropHold = () => { if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; } };
    const place = (x: number) => { front.style.transform = x ? `translateX(${x}px)` : ""; };
    front.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      pointer = ev.pointerId; startX = ev.clientX; startY = ev.clientY; sideways = null;
      base = wrap.classList.contains("open") ? -SWIPE_REVEAL : 0; offset = base;
      held = false;
      dropHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        held = true;
        // The drag is over: a finger that now moves must not slide the row.
        pointer = null;
        navigator.vibrate?.(8);
        hold();
      }, HOLD_MS);
    });
    front.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== pointer) return;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (sideways === null) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
        // The finger moved, so this is a drag or a scroll, and not a hold.
        dropHold();
        sideways = Math.abs(dx) > Math.abs(dy);
        if (!sideways) { pointer = null; return; }
        front.setPointerCapture(ev.pointerId);
        front.classList.add("dragging");
        if (this.swiped && this.swiped !== key) this.closeSwipe();
      }
      offset = Math.max(-SWIPE_REVEAL, Math.min(0, base + dx));
      place(offset);
    });
    const end = (ev: PointerEvent) => {
      dropHold();
      // The click after a hold would open the thread the finger only held.
      if (held) { held = false; this.suppressClick = true; setTimeout(() => { this.suppressClick = false; }, 0); return; }
      if (ev.pointerId !== pointer) return;
      pointer = null;
      if (!sideways) return;
      front.classList.remove("dragging");
      place(0);
      const open = offset < -SWIPE_COMMIT;
      wrap.classList.toggle("open", open);
      this.swiped = open ? key : null;
      // The click after a drag would open the thread the finger only slid.
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 0);
    };
    front.addEventListener("pointerup", end);
    front.addEventListener("pointercancel", end);
    // A right click on a desktop, and the browser's own hold on a phone.
    front.addEventListener("contextmenu", (ev) => { ev.preventDefault(); dropHold(); held = true; hold(); });
  }

  /** Slide the open row back, without a paint. */
  private closeSwipe() {
    this.swiped = null;
    for (const el of this.list.querySelectorAll(".swipe.open")) el.classList.remove("open");
  }

  private paintThread(s: State, v: View) {
    const t = v.thread;
    clear(this.header);
    this.header.append(
      h("button", { class: "back", type: "button", "aria-label": "Back", onclick: () => this.a.back() }, "‹"),
      h("div", { class: "text" },
        h("div", { class: "title" }, t?.title ?? "…"),
        h("div", { class: `sub tone-${t ? threadTone(t) : "idle"}` }, s.machines.size > 1 ? `${s.machines.get(v.machine)?.name ?? ""} · ` : "", v.loading ? "loading…" : v.error ? v.error : t ? threadStatusLabel(t) : "", t ? this.refChips(v.machine, t, true) : null),
      ),
      // The settings of this conversation (#117): the model it runs, the mode
      // it runs in, and the two things a reader does to a conversation itself.
      h("button", { class: "opts", type: "button", "aria-label": "Conversation settings", disabled: !t, onclick: () => this.a.openSheet({ kind: "thread", machine: v.machine, threadId: v.threadId }) }, "⋮"),
    );
    this.refScope = () => (t ? { machine: v.machine, projectId: t.projectId } : null);
    const busy = t ? threadIsBusy(t) : false;
    this.stopBtn.classList.toggle("hidden", !busy || (t?.pendingApprovals ?? 0) > 0);
    this.composer.placeholder = busy ? "Message (queues behind the turn)" : "Message";

    const key = `${v.machine}:${v.threadId}`;
    const switched = this.shownThread !== key;
    if (switched) {
      this.shownThread = key;
      this.rows.clear();
      clear(this.timeline);
      this.atBottom = true;
      this.composer.value = s.drafts.get(key) ?? "";
      this.menuClosedFor = null;
      this.grow();
    }
    // A draft kept from before may be a command name, and the list may have changed.
    if (switched || this.commands !== v.commands) { this.commands = v.commands; this.paintMenu(); }
    // Keyed rows: only an item the daemon re-sent is rebuilt.
    const items = orderedItems(v);
    const seen = new Set<string>();
    let cursor: Node | null = this.timeline.firstChild;
    for (const item of items) {
      seen.add(item.id);
      let row = this.rows.get(item.id);
      if (!row || row.item !== item) {
        const el = renderItem(item, this.a, this.markdown);
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

  // ---- one issue or pull request (#108) --------------------------------

  /**
   * The item screen. The header and the bar are cheap and rebuilt on every
   * paint, so a button follows `busy`. The body is rebuilt only when the
   * item the daemon answered with changed, so a paint for a thread event
   * elsewhere does not move the reader's scroll.
   */
  private paintItem(s: State, iv: ItemView) {
    const item = iv.item;
    const key = `${iv.machine}:${iv.projectId}:${iv.number}`;
    this.refScope = () => ({ machine: iv.machine, projectId: iv.projectId });
    clear(this.itemHeader);
    const label = item ? itemStateLabel(item) : null;
    this.itemHeader.append(
      h("button", { class: "back", type: "button", "aria-label": "Back", onclick: () => this.a.back() }, "‹"),
      h("div", { class: "text" },
        h("div", { class: "title" }, item ? `#${item.number} ${item.title}` : `#${iv.number}`),
        h("div", { class: "sub" },
          item ? h("span", { class: `chip ${label}` }, label!) : null,
          item ? ` ${item.kind === "pull" ? "pull request" : "issue"}` : iv.loading ? "loading…" : "",
          item?.author ? ` · by ${item.author}` : "",
          item?.createdAt ? ` · ${relTime(item.createdAt)}` : "",
          s.machines.size > 1 ? ` · ${s.machines.get(iv.machine)?.name ?? ""}` : "",
        ),
      ),
      h("button", { class: "refresh", type: "button", "aria-label": "Refresh", disabled: iv.loading || iv.busy, onclick: () => this.a.refreshItem() }, "↻"),
    );
    const shown = this.shownItem;
    // An act that went through empties the box; one that failed keeps the
    // text, so the reader can try again. The state says which.
    if (this.itemWasBusy && !iv.busy) this.itemDraft.value = iv.draft;
    this.itemWasBusy = iv.busy;
    if (!shown || shown.key !== key || shown.item !== item || shown.error !== iv.error || shown.loading !== iv.loading) {
      this.shownItem = { key, item, error: iv.error, loading: iv.loading };
      clear(this.itemBody);
      if (shown?.key !== key) { this.itemBody.scrollTop = 0; this.itemDraft.value = iv.draft; }
      if (iv.error) this.itemBody.append(h("div", { class: "note error" }, iv.error));
      if (item) this.itemBody.append(...this.itemSections(s, iv, item));
      else if (iv.loading) this.itemBody.append(h("div", { class: "activity" }, h("span", { class: "spinner" }), " reading…"));
    }
    clear(this.itemBar);
    if (!item) return;
    const busy = iv.busy || iv.loading;
    const acts = itemActions(item);
    const buttons = h("div", { class: "buttons" });
    for (const act of acts) {
      const isMerge = act.action.kind === "merge";
      buttons.append(h("button", { type: "button", class: act.tone, disabled: busy, onclick: () => this.act(s, iv, item, act) }, act.label));
      if (isMerge) {
        const sel = h("select", { "aria-label": "Merge method", disabled: busy });
        for (const m of ["merge", "squash", "rebase"] as const) sel.append(h("option", { value: m, selected: m === this.mergeMethod }, m));
        sel.addEventListener("change", () => { this.mergeMethod = sel.value as MergeMethod; });
        buttons.append(sel);
      }
    }
    this.itemBar.append(
      this.itemDraft,
      buttons,
      h("div", { class: "who" }, iv.busy ? "working…" : item.viewer ? `as ${item.viewer}` : "gh is not logged in on that machine", " · ", h("a", { href: item.url, target: "_blank", rel: "noreferrer" }, "open on GitHub")),
    );
    this.itemDraft.disabled = busy;
  }

  /** One act from the bar. A merge and a close ask first; the rest are a review or a comment, which GitHub keeps and shows. */
  private act(s: State, iv: ItemView, item: GitHubItem, act: ReturnType<typeof itemActions>[number]) {
    const body = this.itemDraft.value.trim();
    if (act.needsBody && !body) { this.itemDraft.focus(); this.itemDraft.placeholder = act.action.kind === "comment" ? "A comment needs text" : "Say what should change"; return; }
    let action: GitHubAction = act.action;
    if (action.kind === "review") action = { ...action, body: body || undefined };
    if (action.kind === "comment") action = { kind: "comment", body };
    if (action.kind === "merge") {
      const holder = holderOf(s, iv.machine, iv.projectId, iv.number);
      const running = holder && threadIsBusy(holder) ? ` The thread "${holder.title}" is still working on it and may push more.` : "";
      if (item.kind === "pull" && !confirm(`Merge #${item.number} into ${item.baseRefName} (${this.mergeMethod})?${running}`)) return;
      action = { kind: "merge", method: this.mergeMethod };
    }
    if (action.kind === "close" && !confirm(`Close #${item.number}?`)) return;
    this.a.actItem(action);
  }

  /** The body of the item screen, top to bottom. */
  private itemSections(s: State, iv: ItemView, item: GitHubItem): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (item.kind === "pull") {
      const checks = checksLabel(item);
      const decision = item.reviewDecision === "APPROVED" ? "approved" : item.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : item.reviewDecision === "REVIEW_REQUIRED" ? "review required" : "";
      out.push(h("div", { class: "meta" },
        h("code", {}, item.headRefName), " → ", h("code", {}, item.baseRefName),
        h("span", { class: "adds" }, `+${item.additions}`), h("span", { class: "dels" }, `−${item.deletions}`),
        `${item.files.length} file${item.files.length === 1 ? "" : "s"}`,
        item.mergeable === "CONFLICTING" ? h("span", { class: "chip closed" }, "conflicts") : null,
        decision ? h("span", { class: `chip ${item.reviewDecision === "APPROVED" ? "open" : "closed"}` }, decision) : null,
      ));
      const box = h("div", { class: "checks" }, h("div", { class: `row head ${checks.state}` }, h("span", { class: `dot ${checks.state}` }), checks.text));
      for (const c of item.checks) {
        box.append(h("div", { class: "row" }, h("span", { class: `dot ${c.state}` }), c.url ? h("a", { href: c.url, target: "_blank", rel: "noreferrer" }, c.name) : c.name, c.workflow ? h("small", {}, ` ${c.workflow}`) : null));
      }
      out.push(box);
    }
    if (item.labels.length) out.push(h("div", { class: "meta" }, ...item.labels.map((l) => h("span", { class: "chip" }, l))));
    const body = h("div", { class: "markdown" });
    body.innerHTML = item.body.trim() ? markdownToHtml(item.body, this.markdown) : "<p class=\"empty-body\">no description</p>";
    out.push(body);
    const holder = holderOf(s, iv.machine, iv.projectId, iv.number);
    if (holder) {
      out.push(h("div", { class: "holder", onclick: () => this.a.openThread(iv.machine, holder.id) },
        h("span", { class: `dot tone-${threadTone(holder)}` }), h("span", { class: "title" }, holder.title), h("span", { class: "sub" }, ` · ${threadStatusLabel(holder)}`),
        holder.watch?.state === "watching" ? h("span", { class: "sub" }, ` · covey ${holder.watch.merge === "auto" ? "merges when green" : "watches; a person merges"}`) : null,
      ));
    }
    if (item.kind === "pull" && item.reviews.length) {
      out.push(h("h3", {}, "Reviews"));
      for (const r of item.reviews) {
        const word = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : r.state === "DISMISSED" ? "dismissed" : "commented";
        const entry = h("div", { class: `entry review ${r.state.toLowerCase()}` }, h("div", { class: "who" }, h("b", {}, r.author), ` ${word}`, r.submittedAt ? ` · ${relTime(r.submittedAt)}` : ""));
        if (r.body.trim()) { const md = h("div", { class: "markdown" }); md.innerHTML = markdownToHtml(r.body, this.markdown); entry.append(md); }
        out.push(entry);
      }
    }
    if (item.comments.length) {
      out.push(h("h3", {}, "Comments"));
      for (const c of item.comments) {
        const md = h("div", { class: "markdown" });
        md.innerHTML = markdownToHtml(c.body, this.markdown);
        out.push(h("div", { class: "entry" }, h("div", { class: "who" }, h("b", {}, c.author), c.createdAt ? ` · ${relTime(c.createdAt)}` : ""), md));
      }
    }
    return out;
  }
}

/** Plain text with each `#N` as an anchor the surface's click listener takes (#108). */
function refNodes(text: string): Child[] {
  const refs = findRefs(text);
  if (refs.length === 0) return [text];
  const out: Child[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(h("a", { class: "ref", href: "#", "data-number": String(r.number) }, text.slice(r.start, r.end)));
    at = r.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** `machine:thread` back into its two parts. The machine is a URL, so split at the last colon. */
function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

function renderItem(item: TimelineItem, a: Actions, markdown: { media: (url: string) => string }): HTMLElement {
  switch (item.kind) {
    case "user":
      return h("div", { class: `msg user${item.queued ? " queued" : ""}` }, h("div", { class: "body" }, ...refNodes(item.text)), item.queued ? h("span", { class: "tag" }, "queued") : null);
    case "assistant": {
      const el = h("div", { class: `msg assistant${item.streaming ? " streaming" : ""}` });
      el.innerHTML = markdownToHtml(item.text, markdown);
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
      return h("div", { class: `note ${item.tone}` }, ...refNodes(item.text));
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
