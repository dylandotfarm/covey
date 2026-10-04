/**
 * The device, joined to covey (#178).
 *
 * This is the whole feature in one file: it keeps the device's menu in step
 * with the app's thread list, turns an utterance into a turn on a thread, and
 * sends back what the agent said. Everything it needs is already in the store,
 * so the device reaches a daemon exactly as the phone does — it has no socket,
 * no token and no idea which machine anything is on.
 *
 * **The menu is the app's list.** It is `projectRows` flattened, in the order
 * the list screen paints, so a thread is in the same place on the device as on
 * the phone. The device answers with a *position*, and the generation it
 * belonged to, so a pick against a list that has since changed is refused
 * rather than opening a thread nobody chose.
 *
 * **One thread at a time, and the device picks it.** A `MachineClient` holds
 * one thread subscription — `watchThread` drops the last one — so the device
 * and the phone cannot look at different threads. The device wins: picking on
 * the device opens that thread in the app as well. It is a remote control for
 * the phone rather than a second client of the daemon, and that is the whole
 * reason it needs no credentials of its own.
 *
 * **Nothing is sent to the screen while a turn runs.** A refresh costs the
 * reader 300 milliseconds and a streaming reply changes forty times a second,
 * so the reply goes once, when the turn ends. What the device shows during the
 * turn is one word in the status bar.
 */
import { uuid } from "@covey/client";
import {
  Down, TextKind, DeviceState as Paint, Up, loudness, pcmFromAdpcm, readAudio, readHello,
  readSelect, readStatus, writeAck, writeState, writeText, writeThreads, type DeviceMessage,
  type DeviceThread,
} from "@covey/client";
import { projectRows } from "@covey/web";
import { threadIsBusy, type AssistantMessageItem, type TimelineItem } from "@covey/protocol";
import { store } from "../store";
import { DeviceLink, type LinkState } from "./ble";
import { startLinkService, stopLinkService } from "../../modules/covey-link";
import { transcribeUtterance } from "./transcribe";

/** One row of the device's menu, and where it actually lives. */
interface Row extends DeviceThread {
  machine: string;
  threadId: string;
}

/** What the settings screen shows about the device. */
export interface DeviceInfo {
  state: LinkState;
  detail: string | null;
  /** The device's own name, once it has said hello. */
  name: string | null;
  firmware: string | null;
  battery: number | null;
  /** The thread the device is pointed at, by title. */
  pointedAt: string | null;
  /** What the bridge is doing, for a line under the switch. */
  doing: string | null;
  /**
   * What wrote the last words: the daemon's service, or this phone.
   *
   * Worth saying out loud. The two differ enough in quality that a reader who
   * sees a bad transcript should be able to tell which one made it, and a
   * daemon that quietly stopped answering would otherwise look like a
   * recogniser that suddenly got worse.
   */
  transcriber: string | null;
  /**
   * Whether anything is keeping the link alive with the screen off.
   *
   * False on a build made before the service existed, which a bundle delivered
   * over the air can land in. Worth saying out loud rather than leaving a
   * reader to find out by locking their phone.
   */
  held: boolean;
}

/**
 * The last thing the agent said, whole.
 *
 * `replyLead` in `@covey/client` answers the same question in one sentence,
 * for a row in a list. The device has a screen and pages, so it gets the lot —
 * but the rule for *which* item is the reply is that function's, not a second
 * one: the last item of kind `assistant` that has any prose. A turn ends with
 * tool calls as often as not, and the reader wants what was said.
 */
function lastReply(items: TimelineItem[]): AssistantMessageItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "assistant") continue;
    const reply = item as AssistantMessageItem;
    if (reply.text.trim()) return reply;
  }
  return null;
}

export class DeviceBridge {
  private readonly link: DeviceLink;
  private unsubscribe: (() => void) | null = null;

  private generation = 0;
  private rows: Row[] = [];
  /** What the device was last told, so an unchanged list costs no radio. */
  private sentMenu = "";
  private pointer = -1;

  /** The turn in flight, so the reply that ends it can be told apart. */
  private awaiting: { machine: string; threadId: string } | null = null;
  private sentReplyId: string | null = null;
  private wasBusy = false;

  info: DeviceInfo = {
    state: "off", detail: null, name: null, firmware: null, battery: null,
    pointedAt: null, doing: null, transcriber: null, held: false,
  };

  /** Called whenever `info` changed, so the settings screen repaints. */
  onChange: (() => void) | null = null;

  constructor() {
    this.link = new DeviceLink({
      onState: (state, detail) => {
        this.info.state = state;
        this.info.detail = detail ?? null;
        if (state !== "ready") {
          this.info.name = null;
          this.info.firmware = null;
          this.info.battery = null;
          this.sentMenu = "";
        }
        this.changed();
      },
      onMessage: (m) => void this.receive(m),
    });
  }

  private changed(): void {
    this.onChange?.();
  }

  private say(doing: string | null): void {
    this.info.doing = doing;
    this.changed();
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = store.subscribe(() => this.push());
    /*
     * The service goes up first and comes down last.
     *
     * It is what lets the scan find the device with the screen off, so starting
     * it after the scan would mean the first scan runs under the restriction
     * the service exists to lift.
     */
    this.info.held = startLinkService();
    this.changed();
    await this.link.start();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.link.stop();
    stopLinkService();
    this.info.held = false;
    this.changed();
  }

  running(): boolean {
    return this.unsubscribe !== null;
  }

  // ---- what the phone sends ------------------------------------------------

  /**
   * Work out the menu and send it when it has changed.
   *
   * Runs on every frame the store changed, which during a turn is many a
   * second, so the list is compared as the text the device would be sent. The
   * radio is only used when a title, an order or a busy mark actually moved.
   */
  private push(): void {
    if (!this.link.connected()) return;

    const rows: Row[] = [];
    for (const group of projectRows(store.state))
      for (const t of group.threads)
        rows.push({
          machine: t.machine,
          threadId: t.thread.id,
          title: t.thread.title,
          busy: threadIsBusy(t.thread),
        });

    const signature = rows.map((r) => `${r.threadId}:${r.busy ? 1 : 0}:${r.title}`).join("\n");
    if (signature !== this.sentMenu) {
      this.sentMenu = signature;
      // Keep the device pointed at the same thread it was pointed at.
      const was = this.rows[this.pointer]?.threadId;
      this.rows = rows;
      const moved = rows.findIndex((r) => r.threadId === was);
      this.pointer = moved >= 0 ? moved : rows.length ? 0 : -1;
      this.generation = (this.generation + 1) & 0xffff;
      this.info.pointedAt = this.rows[this.pointer]?.title ?? null;
      void this.link.send(Down.threads, writeThreads(this.generation, rows));
      this.changed();
    }

    this.pushTurn();
  }

  /** Follow the open thread: say when it starts working, and what it said. */
  private pushTurn(): void {
    const view = store.state.view;
    const target = this.awaiting;
    if (!view || !target || view.threadId !== target.threadId) return;

    const thread = view.thread;
    const busy = thread ? threadIsBusy(thread) : false;
    if (busy && !this.wasBusy) {
      this.wasBusy = true;
      void this.link.send(Down.state, writeState(Paint.busy));
      this.say("the agent is working");
      return;
    }
    if (!busy && this.wasBusy) {
      this.wasBusy = false;
      const reply = lastReply([...view.items.values()]);
      void this.link.send(Down.state, writeState(Paint.idle));
      if (reply && reply.id !== this.sentReplyId) {
        this.sentReplyId = reply.id;
        void this.link.send(Down.text, writeText(TextKind.reply, reply.text));
        this.say(null);
      } else {
        this.say(null);
      }
      this.awaiting = null;
    }
  }

  // ---- what the device sends -----------------------------------------------

  private async receive(message: DeviceMessage): Promise<void> {
    switch (message.type) {
      case Up.hello: {
        const hello = readHello(message.body);
        if (hello) {
          this.info.name = hello.name;
          this.info.firmware = hello.firmware;
          this.changed();
        }
        // Say the list again: a device that just said hello has nothing.
        this.sentMenu = "";
        this.push();
        break;
      }
      case Up.status: {
        const status = readStatus(message.body);
        if (status) {
          this.info.battery = status.battery === 0xff ? null : status.battery;
          this.changed();
        }
        break;
      }
      case Up.select: {
        const pick = readSelect(message.body);
        if (!pick || pick.generation !== this.generation) return;
        const row = this.rows[pick.index];
        if (!row) return;
        this.pointer = pick.index;
        this.info.pointedAt = row.title;
        this.changed();
        // The device picks the thread the app has open: one subscription.
        store.showThread(row.machine, row.threadId);
        break;
      }
      case Up.audio:
        await this.hear(message);
        break;
      default:
        break;
    }
  }

  /**
   * An utterance: make words of it and start a turn.
   *
   * Every failure says which of the things went wrong on the device's own
   * screen, because the phone is very likely in a pocket. A recording covey
   * could not read must never become a turn: an agent asked a question nobody
   * checked is worse than an agent asked nothing.
   */
  private async hear(message: DeviceMessage): Promise<void> {
    const row = this.rows[this.pointer];
    const utterance = readAudio(message.body);
    if (!utterance) return;

    if (!row) {
      await this.link.send(Down.ack, writeAck(false, "No thread is chosen."));
      await this.link.send(Down.text, writeText(TextKind.notice, "No thread is chosen."));
      return;
    }

    await this.link.send(Down.state, writeState(Paint.hearing));
    this.say("writing out what was said");

    /*
     * The samples are decoded here even though the daemon is sent the blocks.
     * They are what `loudness` reads, and loudness is what tells a microphone
     * that heard nothing from a recogniser that understood nothing - the same
     * blank screen and two different things to fix (#132).
     */
    const pcm = pcmFromAdpcm(utterance.audio, utterance.blockBytes, utterance.samples);
    const loud = loudness(pcm);
    const { text, error, backend } = await transcribeUtterance(
      store.client(row.machine), store.machineInfo(row.machine), utterance, pcm,
    );

    if (!text) {
      /*
       * Say which silence this was.
       *
       * A microphone that heard nothing and a recogniser that understood
       * nothing are the same blank screen and two different things to fix, so
       * the loudness decides the words. This is the #132 rule, kept.
       */
      const why = loud < 0.01
        ? "The microphone heard nothing. Hold the talk button while you speak."
        : error ?? "The words could not be made out.";
      await this.link.send(Down.state, writeState(Paint.idle));
      await this.link.send(Down.text, writeText(TextKind.notice, why));
      await this.link.send(Down.ack, writeAck(false, why));
      this.say(null);
      return;
    }

    await this.link.send(Down.text, writeText(TextKind.heard, text));
    await this.link.send(Down.ack, writeAck(true, "Sent."));
    this.info.transcriber = backend;

    const client = store.client(row.machine);
    if (!client) {
      await this.link.send(Down.state, writeState(Paint.away));
      await this.link.send(Down.text, writeText(TextKind.notice, "The machine that holds that thread is not connected."));
      this.say(null);
      return;
    }

    store.showThread(row.machine, row.threadId);
    this.awaiting = { machine: row.machine, threadId: row.threadId };
    this.wasBusy = false;
    this.say("sending to covey");
    try {
      await client.command({ type: "turn.send", threadId: row.threadId, turnId: uuid(), text });
      await this.link.send(Down.state, writeState(Paint.busy));
      this.wasBusy = true;
      this.say("the agent is working");
    } catch (e) {
      this.awaiting = null;
      const why = (e as Error).message || "covey would not take the message.";
      await this.link.send(Down.state, writeState(Paint.idle));
      await this.link.send(Down.text, writeText(TextKind.notice, why));
      this.say(null);
    }
  }
}

/** One bridge for the app. The settings screen turns it on and off. */
export const bridge = new DeviceBridge();
