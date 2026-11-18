/**
 * The two lines above a list: what went wrong, and a machine that is not
 * answering.
 *
 * Its own component because there is more than one list screen now: a
 * reader inside a fleet has to be told that a command was refused exactly as a
 * reader on the home screen does, and a notice is the only channel a failure
 * has.
 */
import { Pressable, Text } from "react-native";
import { connectionSummary } from "@covey/web";
import { store } from "../store";
import { SIZE, T } from "../theme";
import { Notice } from "../ui";

export function TopLines() {
  const conn = connectionSummary(store.state);
  return (
    <>
      {store.notice ? <Notice text={store.notice} onDismiss={store.clearNotice} /> : null}
      {conn.state !== "connected" ? (
        <Pressable onPress={store.retry} style={{ backgroundColor: T.surfaceAlt, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text style={{ color: T.warning, fontSize: SIZE.small }}>{conn.text} — tap to retry</Text>
        </Pressable>
      ) : null}
    </>
  );
}
