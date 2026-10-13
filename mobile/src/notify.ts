/**
 * The Android half of the notifications: the channel, the permission,
 * the one row per conversation, and the tap that opens it.
 *
 * Everything that decides *what* to say is in `notes.ts` and in `threadNews`
 * above it, both pure and node-tested. What is here cannot be tested in this
 * loop at all — it is a permission dialog, a notification channel and a tap on
 * glass — so it holds no rules: it posts what it is handed and reports what
 * Android answered.
 *
 * **These are local notifications and there is no push service.** Nothing
 * leaves the tailnet, no token is registered anywhere, and covey's own machines
 * are the only thing the phone talks to. The app hears a thread change on the
 * socket it already holds, and `modules/covey-link` is what keeps that socket
 * alive while the screen is off. The cost is a second ongoing row in the shade
 * and it is the honest one: a reader should be able to see that covey is
 * holding their phone awake, and to stop it.
 *
 * The import is static, as every Expo package here is. It can only be read by
 * an app built with this native module, which is why adding it moved the
 * runtime version — a bundle that reached an older app would throw on this line
 * before any of covey ran.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Note } from "./notes";

/**
 * The channel every thread notification goes to.
 *
 * One channel, not one per kind. A reader who wants to be told an agent needs
 * them wants to be told it is done as well, and Android lets them change the
 * sound, the importance and the sleep of this one row themselves — which is
 * better than covey guessing twice.
 *
 * **A channel's settings are fixed the moment it is first created on a device,
 * and only its name and description can be changed after.** So a change of
 * importance here reaches nobody who has already run covey: it would want a new
 * channel id, and that would arrive as a second row in Android's own settings
 * with the reader's choices left on the first. Decide it once.
 */
export const CHANNEL = "covey-threads";

/** Where a tap on a notification goes. */
export interface NoteTarget {
  machine: string;
  threadId: string;
}

/** Only Android has been built and tested. The page is the client elsewhere. */
export const notesAvailable = Platform.OS === "android";

/**
 * Make the channel and say whether covey may post.
 *
 * It asks and never prompts: a dialog at launch, about a feature the reader has
 * not switched on, is the kind nobody reads. The prompt belongs to the switch
 * (`askNotes`).
 */
export async function startNotes(): Promise<boolean> {
  if (!notesAvailable) return false;
  // A notification that arrives while covey is the screen in front of the
  // reader is still worth showing: it is about the conversation they are *not*
  // reading. `notes.ts` is what drops the one they are.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Conversations",
      description: "When a thread needs you, or has finished.",
      // HIGH, which is what puts the notification on the screen rather than
      // only in the shade. The whole point is to reach somebody who is in
      // another app or not holding the phone at all; `DEFAULT` makes a sound
      // and waits to be found, which is barely better than the app being open.
      // It is also what the reader asked for by turning this on, and Android's
      // own settings are where they turn it down.
      importance: Notifications.AndroidImportance.HIGH,
      enableVibrate: true,
    });
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Whether Android allows covey to show a notification, asking nobody. */
export async function notesGranted(): Promise<boolean> {
  if (!notesAvailable) return false;
  try {
    return (await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * Ask the reader for the permission, from the switch that needs it.
 *
 * Android 13 and later refuse to show a notification until this is granted,
 * and the dialog is shown once in the life of an install — so it is asked at
 * the moment the reader turns the feature on, where the question has an answer
 * they can see the point of. Before 13 it is granted already and this is a call
 * that says yes.
 */
export async function askNotes(): Promise<boolean> {
  if (!notesAvailable) return false;
  try {
    const held = await Notifications.getPermissionsAsync();
    if (held.granted) return true;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Put one conversation's row in the shade, replacing its own. */
export async function postNote(note: Note): Promise<void> {
  if (!notesAvailable) return;
  try {
    await Notifications.scheduleNotificationAsync({
      // The identifier is the notification's tag on Android, so posting again
      // under it replaces the row rather than adding a second one. That is the
      // whole of "one row per conversation".
      identifier: note.id,
      content: {
        title: note.title,
        body: note.body,
        data: { machine: note.machine, threadId: note.threadId },
      },
      // A null trigger means "now" and carries no channel with it, so the row
      // would land in Android's own `Miscellaneous`. This is the same "now".
      trigger: { channelId: CHANNEL },
    });
  } catch {
    /*
     * Swallowed, and deliberately. A notification is covey telling the reader
     * about something else; a notice about the notification would be covey
     * talking about itself, over the top of the screen they are using.
     */
  }
}

/** Take one conversation's row down. */
export async function dismissNote(id: string): Promise<void> {
  if (!notesAvailable) return;
  try {
    await Notifications.dismissNotificationAsync(id);
  } catch {
    /* as above */
  }
}

/** Read the conversation a notification names, or null if it names none. */
function targetOf(response: Notifications.NotificationResponse | null): NoteTarget | null {
  const data = response?.notification.request.content.data;
  const machine = data?.machine;
  const threadId = data?.threadId;
  return typeof machine === "string" && typeof threadId === "string" ? { machine, threadId } : null;
}

/**
 * Open the conversation a tapped notification names.
 *
 * Two routes, because a tap means the same thing whether or not covey was
 * running: a listener for the app that was already up, and the response Android
 * handed the launch for the app that was not. The second is cleared once it has
 * been acted on, or every later launch would reopen that thread.
 */
export function onNoteTap(open: (to: NoteTarget) => void): () => void {
  if (!notesAvailable) return () => {};
  const cold = targetOf(Notifications.getLastNotificationResponse());
  if (cold) {
    Notifications.clearLastNotificationResponse();
    open(cold);
  }
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const to = targetOf(response);
    if (to) open(to);
  });
  return () => sub.remove();
}
