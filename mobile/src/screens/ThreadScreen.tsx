/**
 * One conversation (issue #168).
 *
 * Two things about the bottom of this screen are Android's, not React Native's,
 * and both were wrong on the first build.
 *
 * **The keyboard does not move the window.** The manifest asks for
 * `adjustResize` and it is ignored: an edge-to-edge app on Android 15 and later
 * keeps its window the full height of the screen and hands the keyboard over as
 * an inset instead. So the composer sat *behind* the keyboard. A
 * `KeyboardAvoidingView` with `behavior="padding"` is what moves it, and it is
 * safe precisely because the window does not resize — were it resizing too, the
 * padding would be counted twice and the composer would float.
 *
 * **The gesture bar is inside the window.** Edge-to-edge again: the app draws
 * under the navigation bar, so the composer has to hold `insets.bottom` itself
 * or the home bar sits on top of it. That inset goes away when the keyboard is
 * up, because the keyboard covers the gesture bar and the padding would
 * otherwise become a gap.
 *
 * The transcript is an **inverted** `FlatList`, and that is the answer to #114.
 * A streaming item is re-sent whole and longer, so the bottom moves under the
 * reader; the page keeps a count of lines from the bottom and an anchor to
 * survive it. An inverted list is anchored to the bottom by construction — row
 * zero is the newest — so a reply that grows pushes nothing and the reader who
 * scrolled up stays where they were.
 *
 * `viewRows` decides the rows, at this device's level of detail, and it is
 * `timelineRows` underneath: the same fold as the TUI and the page (#149).
 *
 * The level itself is chosen on the settings screen and not here. A row of
 * choices above the transcript costs a line on every conversation to answer a
 * question a reader asks about twice a month — and it costs it on the screen
 * that has fewest lines to give. The web client puts the same choice in the
 * same place, at the head of its settings page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, Keyboard, KeyboardAvoidingView, Pressable, Text, useWindowDimensions, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { threadIsBusy } from "@covey/protocol";
import { isGitHubAttachment, mediaSrc, orderedItems, threadFileSrc, viewRows, type MediaRef } from "@covey/web";
import { store } from "../store";
import { useStore } from "../useStore";
import { T } from "../theme";
import { Empty, Notice, S, Spinner, useContentInsets } from "../ui";
import { TimelineRowView, type RowContext } from "../components/TimelineRowView";
import { Composer } from "../components/Composer";
import { UltraView } from "./UltraView";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Thread">;

export function ThreadScreen({ route, navigation }: Props) {
  const { machine, threadId } = route.params;
  useStore();
  const insets = useContentInsets();
  /**
   * What `KeyboardAvoidingView` must be told about the header.
   *
   * It measures its own frame, and that frame starts *below* the navigation
   * header — so without this the padding it adds is short by exactly the
   * header's height and the composer stays under the keyboard's toolbar. That
   * is what a first attempt shipped: the composer moved, and not far enough.
   */
  const headerHeight = useHeaderHeight();
  /**
   * A cover screen is a few lines tall. 420 points is comfortably below any
   * phone held open and comfortably above every cover screen, and the reader's
   * own choice always wins — `suggestUltra` does nothing once they have chosen.
   */
  const { height } = useWindowDimensions();
  useEffect(() => { store.suggestUltra(height < 420); }, [height]);
  /** The keyboard covers the gesture bar, so its inset must not be held twice. */
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardUp(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardUp(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const s = store.state;
  const slot = s.machines.get(machine);
  const thread = slot?.threads.get(threadId);

  // The screen owns the subscription for as long as it is in front. Leaving it
  // unwatches, so a daemon stops sending a transcript nobody is reading.
  useFocusEffect(useCallback(() => {
    store.showThread(machine, threadId);
    return () => store.leaveThread();
  }, [machine, threadId]));

  useLayoutEffect(() => {
    navigation.setOptions({
      title: thread?.title || "Conversation",
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate("Sheet", { target: { kind: "thread", machine, threadId } })}
          hitSlop={10}
          accessibilityLabel="Conversation settings"
        >
          <Text style={{ color: T.text, fontSize: 21 }}>⋮</Text>
        </Pressable>
      ),
    });
  }, [navigation, thread?.title, machine, threadId]);

  const view = s.view?.machine === machine && s.view.threadId === threadId ? s.view : null;

  /**
   * Everything a row needs from this screen.
   *
   * Memoised on the identities that actually change it, because
   * `TimelineRowView` compares it by reference: a new object every frame would
   * rebuild every row in the transcript and lose whatever the reader was
   * touching.
   */
  const ctx = useMemo<RowContext>(() => ({
    src: (url) => (isGitHubAttachment(url) ? mediaSrc(url, slot?.token) : url),
    fileSrc: (path) => threadFileSrc(slot, threadId, path),
    onRef: (number) => {
      const projectId = thread?.projectId;
      if (projectId) navigation.navigate("Item", { machine, projectId, number });
    },
    onMedia: (src, alt) => navigation.navigate("Media", { src, alt }),
    onToggle: store.toggleRow,
    onApproval: store.respondApproval,
    onQuestion: store.respondQuestion,
  }), [slot, threadId, thread?.projectId, machine, navigation]);

  const rows = view ? viewRows(s, view) : [];
  // Inverted: row zero is the newest. See the note at the top of the file.
  const data = useMemo(() => [...rows].reverse(), [rows]);

  const busy = thread ? threadIsBusy(thread) : false;

  /**
   * One chip per file waiting to go, deduplicated by tag.
   *
   * Deliberately not memoised. `state.attachments` is a `Map` that is mutated in
   * place, so its identity never changes and a `useMemo` keyed on it would hand
   * back the first render's chips for ever. The loop is over a handful of files
   * and the render already happened.
   */
  const seen = new Set<string>();
  const tags: { tag: string; name: string; failed?: boolean }[] = [];
  for (const a of store.attachments(machine, threadId)) {
    if (seen.has(a.tag)) continue;
    seen.add(a.tag);
    tags.push({ tag: a.tag, name: a.name, ...(a.failed ? { failed: true } : {}) });
  }

  return (
    <KeyboardAvoidingView style={S.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {store.notice ? <Notice text={store.notice} onDismiss={store.clearNotice} /> : null}


      {store.ultra ? (
        <View style={S.grow}>
          <UltraView
            thread={thread ?? null}
            items={view ? orderedItems(view) : []}
            srcOf={(m: MediaRef) => (m.source.at === "file" ? ctx.fileSrc(m.source.path) : ctx.src(m.source.url))}
            onMedia={(src, label) => navigation.navigate("Media", { src, alt: label })}
            onExpand={() => store.setDetail(s.lod)}
          />
        </View>
      ) : view?.loading && rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner /></View>
      ) : view?.error ? (
        <Empty title="That conversation would not open." hint={view.error} />
      ) : rows.length === 0 ? (
        <Empty title="Nothing here yet." hint="Send the first message." />
      ) : (
        <FlatList
          inverted
          data={data}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) => <TimelineRowView row={item} ctx={ctx} />}
          // A transcript is long and a phone has one thread for the paint and
          // the keyboard, so rows off screen are not kept mounted.
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews
          keyboardDismissMode="interactive"
          contentContainerStyle={{ paddingVertical: 8, paddingLeft: insets.left, paddingRight: insets.right }}
        />
      )}

      {view?.hasMore ? (
        <Text style={[S.subtle, { textAlign: "center", paddingBottom: 4 }]}>Older messages are on the machine.</Text>
      ) : null}

      <Composer
        machine={machine}
        threadId={threadId}
        initial={store.draft(machine, threadId)}
        tags={tags}
        attaching={s.attaching}
        busy={busy}
        onDraft={(t) => store.setDraft(machine, threadId, t)}
        onSend={store.send}
        onInterrupt={store.interrupt}
        onAttach={store.attachFiles}
        bottomInset={keyboardUp ? 0 : insets.bottom}
        leftInset={insets.left}
        rightInset={insets.right}
        // The cover screen: the lenses take the bottom-right corner and the
        // device reports nothing about them, so the controls move left.
        compact={store.ultra}
      />
    </KeyboardAvoidingView>
  );
}
