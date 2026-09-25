export { MachineClient, TRIES, type ClientEvents, type ClientOptions, type ConnState, type SocketLike, type Dial } from "./client.js";
export { uuid } from "./uuid.js";
export { acceptCommand, commandLabel, commandMenu, commandToken } from "./commands.js";
export { projectPool } from "./projects.js";
export {
  IDLE_CHOICES, LIVE_CHOICES, budgetValue, idleChoices, idleLabel, idleValueLabel,
  liveChoices, liveValueLabel, sessionMemoryLabel, type BudgetChoice,
} from "./sessionBudget.js";
export { tableAt, tableCells, type Align, type Table } from "./markdown.js";
export {
  chainLabel, chainsOf, foldsChains, timelineRows,
  type ChainRow, type FoldOpts, type ItemRow, type SaidRow, type TimelineRow,
} from "./timeline.js";
export {
  applyDrop, chipLabel, cutTag, keepTagged, makeTag, megabytes, spliceTags, tagAttachments, tagSpanAt,
  type FailedDrop, type TaggedAttachment,
} from "./attach.js";
