/**
 * Projects and their conversations (issue #168).
 *
 * `projectRows` in `@covey/web` decides what a row is and what order the rows come
 * in — a repository on one base branch, wherever it is checked out, with two
 * machines holding the same repository on the same base folded into one row. That
 * is shared with the page on purpose: `projectPool` is what makes two projects
 * one row, and keying it anywhere else would start a thread from the wrong commit.
 *
 * A row is one target (#115). The chips are text, and a hold opens the
 * conversation's sheet — a thumb aimed at a row must not hit a chip inside it.
 */
import { useCallback } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { threadIsBusy } from "@covey/protocol";
import {
  connectionSummary, openHomes, projectRows, relTime, threadRefs, threadStatusLabel, threadTone,
  type ProjectRow, type ThreadRef,
} from "@covey/web";
import { store } from "../store";
import { useStore } from "../useStore";
import { SIZE, T, TONE } from "../theme";
import { Dot, Empty, Notice, Pill, Row, S, useContentInsets } from "../ui";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "List">;

export function ListScreen({ navigation }: Props) {
  useStore();
  // A camera punch is inside the screen on Android 15 and later, and on a
  // Razr's cover display it is inside the only screen there is.
  const insets = useContentInsets();
  const s = store.state;
  const rows = projectRows(s);
  const conn = connectionSummary(s);

  const openThread = useCallback((t: ThreadRef) => {
    navigation.navigate("Thread", { machine: t.machine, threadId: t.thread.id });
  }, [navigation]);

  const newThread = useCallback((row: ProjectRow) => {
    const homes = openHomes(row);
    if (homes.length === 0) return;
    // More than one machine can hold this project, so the reader picks. One and
    // there is nothing to ask.
    if (homes.length > 1) { store.chooseMachine(row.key); return; }
    const home = homes[0]!;
    const threadId = store.newThread(home.machine, home.project.id);
    navigation.navigate("Thread", { machine: home.machine, threadId });
  }, [navigation]);

  if (!store.loaded) return <View style={S.screen} />;

  if (s.machines.size === 0) {
    return (
      <View style={S.screen}>
        <Empty
          title="No machines yet."
          hint="Add the machine that runs covey. In the TUI, press enter on a machine row to see its address."
        />
        <View style={{ padding: 16 }}>
          <Pressable
            onPress={() => navigation.navigate("AddMachine")}
            style={{ backgroundColor: T.accent, borderRadius: 10, padding: 14, alignItems: "center" }}
          >
            <Text style={{ color: "#ffffff", fontSize: SIZE.body, fontWeight: "600" }}>Add a machine</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={S.screen}>
      {store.notice ? <Notice text={store.notice} onDismiss={store.clearNotice} /> : null}
      {conn.state !== "connected" ? (
        <Pressable onPress={store.retry} style={{ backgroundColor: T.surfaceAlt, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text style={{ color: T.warning, fontSize: SIZE.small }}>{conn.text} — tap to retry</Text>
        </Pressable>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        refreshControl={<RefreshControl refreshing={false} onRefresh={store.retry} tintColor={T.accent} />}
        ListHeaderComponent={
          <Pressable onPress={() => navigation.navigate("Settings")} style={[S.row, { paddingBottom: 4 }]}>
            <Text style={{ color: T.accent, fontSize: SIZE.small }}>⚙ Machines and settings</Text>
          </Pressable>
        }
        ListEmptyComponent={<Empty title="No projects yet." hint="Start one in the TUI, and it appears here." />}
        renderItem={({ item: row }) => {
          const folded = s.folded.has(row.key);
          const homes = openHomes(row);
          const choosing = s.choosing === row.key;
          return (
            <View style={S.card}>
              <Row first onPress={() => store.toggleFold(row.key)}>
                <Text style={{ color: T.faint, fontSize: 11 }}>{folded ? "▸" : "▾"}</Text>
                <View style={S.grow}>
                  <Text style={[S.title, { fontWeight: "600" }]} numberOfLines={1}>{row.title}</Text>
                  <Text style={S.subtle} numberOfLines={1}>
                    {/* The base branch, because two rows of one repository differ
                        only by it and the reader must see which base a thread
                        starts from. */}
                    {row.base ?? "default branch"}
                    {row.homes.length > 1 ? ` · ${row.homes.length} machines` : ""}
                  </Text>
                </View>
                {row.waiting > 0 ? <Pill text={`${row.waiting} waiting`} colour={T.awaiting} /> : null}
                {row.active > 0 ? <Pill text={`${row.active} busy`} colour={T.working} /> : null}
                {homes.length > 0 ? (
                  <Pressable onPress={() => newThread(row)} hitSlop={10} style={{ paddingHorizontal: 6 }}>
                    <Text style={{ color: T.accent, fontSize: 21 }}>＋</Text>
                  </Pressable>
                ) : null}
              </Row>

              {choosing ? (
                <View style={{ backgroundColor: T.surfaceAlt, paddingVertical: 4 }}>
                  <Text style={[S.subtle, { paddingHorizontal: 14, paddingVertical: 4 }]}>Start it on…</Text>
                  {homes.map((h) => (
                    <Row
                      key={h.machine}
                      onPress={() => {
                        const threadId = store.newThread(h.machine, h.project.id);
                        navigation.navigate("Thread", { machine: h.machine, threadId });
                      }}
                    >
                      <Text style={S.title}>{h.machineName}</Text>
                    </Row>
                  ))}
                </View>
              ) : null}

              {folded ? null : row.threads.map((t) => {
                const tone = threadTone(t.thread);
                const refs = threadRefs(t.thread);
                return (
                  <Row
                    key={`${t.machine}:${t.thread.id}`}
                    onPress={() => openThread(t)}
                    // A hold is the way to this conversation's settings (#115),
                    // because the chips on the row are text and not targets.
                    onLongPress={() => navigation.navigate("Sheet", { target: { kind: "thread", machine: t.machine, threadId: t.thread.id } })}
                  >
                    <Dot colour={TONE[tone]} />
                    <View style={S.grow}>
                      <Text style={S.title} numberOfLines={1}>{t.thread.title || "Untitled"}</Text>
                      <Text style={S.subtle} numberOfLines={1}>
                        {threadStatusLabel(t.thread)}
                        {refs.length ? ` · ${refs.map((r) => r.label).join(" ")}` : ""}
                        {row.homes.length > 1 ? ` · ${t.machineName}` : ""}
                      </Text>
                    </View>
                    {threadIsBusy(t.thread) ? null : (
                      <Text style={{ color: T.faint, fontSize: 10 }}>{relTime(t.thread.lastMessageAt ?? t.thread.updatedAt)}</Text>
                    )}
                  </Row>
                );
              })}
            </View>
          );
        }}
        contentContainerStyle={{ paddingBottom: 28 + insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}
      />
    </View>
  );
}
