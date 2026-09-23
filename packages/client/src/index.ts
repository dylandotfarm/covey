export { MachineClient, TRIES, type ClientEvents, type ClientOptions, type ConnState, type SocketLike, type Dial } from "./client.js";
export { uuid } from "./uuid.js";
export { acceptCommand, commandLabel, commandMenu, commandToken } from "./commands.js";
export { projectPool } from "./projects.js";
export {
  applyDrop, chipLabel, cutTag, keepTagged, makeTag, megabytes, spliceTags, tagAttachments, tagSpanAt,
  type FailedDrop, type TaggedAttachment,
} from "./attach.js";
