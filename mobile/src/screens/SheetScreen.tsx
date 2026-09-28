/**
 * A settings sheet (issue #168).
 *
 * What the sheet *says* is `@covey/web`'s: `sheetRows`, `sheetChoices`,
 * `sheetTitle`, `sheetNote`, all pure and node-tested and read by the page too.
 * What a choice *means* is `sheet.ts`, because a command is the one thing a
 * client must say for itself. This file only paints.
 *
 * It is a screen, not a layer over another one. On the page the sheet is not a
 * route yet and has a known bug because of it: the sheet has pages of its own, so
 * back inside it means more than one thing. Here the stack holds the pages, so
 * back means one thing — go up a page, and out of the sheet from the top.
 */
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  machineSheetRows, sheetChoices, sheetMachine, sheetNote, sheetRows, sheetThread, sheetTitle, viewRowNumber,
} from "@covey/web";
import { store } from "../store";
import { useStore } from "../useStore";
import { SIZE, T } from "../theme";
import { Row, S } from "../ui";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Sheet">;

export function SheetScreen({ route, navigation }: Props) {
  useStore();
  const { target } = route.params;
  /**
   * Which page of the sheet is open. `""` is the list of settings.
   *
   * `rename` is this client's own page and is not one `sheetChoices` knows: the
   * page asks with `prompt()`, and React Native has no such thing on Android —
   * `Alert.prompt` is iOS only, so a rename there would silently do nothing.
   * Android is this client's platform, so the rename is a page with a field.
   */
  const [page, setPage] = useState("");
  const [rename, setRename] = useState("");
  const sheet = { target, page };
  const s = store.state;

  const renaming = page === "rename";
  const rows = sheetRows(s, sheet);
  const choices = renaming ? [] : page ? sheetChoices(s, sheet) : [];
  const title = renaming ? "Rename conversation" : sheetTitle(s, sheet);
  const note = renaming ? "" : sheetNote(s, sheet);

  const back = useCallback(() => {
    // Up a page first, out of the sheet only from the top. The stack would
    // otherwise shut the whole sheet on the first gesture.
    if (page) setPage("");
    else navigation.goBack();
  }, [page, navigation]);

  const act = (id: string) => {
    if (target.kind !== "thread") return;
    const { machine, threadId } = target;

    // A row that opens an issue or a pull request (#115). It needs no client:
    // the item screen reads the item itself.
    const number = viewRowNumber(id);
    if (number !== null) {
      const projectId = s.machines.get(machine)?.threads.get(threadId)?.projectId;
      if (!projectId) return;
      navigation.replace("Item", { machine, projectId, number });
      return;
    }

    if (id === "rename") {
      setRename(sheetThread(s, sheet)?.title ?? "");
      setPage("rename");
      return;
    }

    if (id === "archive") {
      Alert.alert("Archive this conversation?", "It leaves the list; the TUI brings it back.", [
        { text: "Keep", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: () => {
            store.archiveThread(machine, threadId);
            // Nothing is left on screen to archive, so the list comes back.
            navigation.navigate("List");
          },
        },
      ]);
    }
  };

  const choose = (id: string) => {
    // Turning the web server off on a machine takes the phone's *page* with it.
    // This app keeps working: it is not served by that daemon. Say so rather
    // than refuse, because on the page this row is hidden for a reason that does
    // not apply here.
    if (target.kind === "machine" && page === "web" && id === "off") {
      const name = sheetMachine(s, sheet)?.name ?? "that machine";
      Alert.alert(
        `Stop the web server on ${name}?`,
        "The browser client stops being served from there. This app does not need it.",
        [
          { text: "Keep it on", style: "cancel" },
          { text: "Stop it", style: "destructive", onPress: () => { store.sheetChoose(target, page, id); navigation.goBack(); } },
        ],
      );
      return;
    }
    store.sheetChoose(target, page, id);
    navigation.goBack();
  };

  return (
    <View style={[S.screen, { backgroundColor: T.bg }]}>
      <View style={S.bar}>
        <Pressable onPress={back} hitSlop={10} accessibilityLabel={page ? "Back" : "Close"}>
          <Text style={{ color: T.accent, fontSize: SIZE.body }}>{page ? "‹ Back" : "Close"}</Text>
        </Pressable>
        <Text style={[S.barTitle, { flex: 1, textAlign: "center" }]} numberOfLines={1}>{title}</Text>
        {/* Balances the control on the left so the title stays centred. */}
        <View style={{ width: 52 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {note ? <Text style={[S.subtle, { paddingHorizontal: 16, paddingVertical: 10 }]}>{note}</Text> : null}

        {renaming ? (
          <View style={{ gap: 12, padding: 12 }}>
            <TextInput
              value={rename}
              onChangeText={setRename}
              placeholder="A name for this conversation"
              placeholderTextColor={T.faint}
              autoFocus
              style={{ color: T.text, fontSize: SIZE.body, backgroundColor: T.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11 }}
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={S.grow} />
              <Pressable onPress={back} style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
                <Text style={{ color: T.muted, fontSize: SIZE.body }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (target.kind !== "thread") return;
                  const next = rename.trim();
                  const now = sheetThread(s, sheet)?.title ?? "";
                  // Nothing to send when the name did not change.
                  if (next && next !== now) store.renameThread(target.machine, target.threadId, next);
                  navigation.goBack();
                }}
                disabled={!rename.trim()}
                style={{ backgroundColor: T.accent, opacity: rename.trim() ? 1 : 0.4, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 }}
              >
                <Text style={{ color: "#ffffff", fontSize: SIZE.body, fontWeight: "600" }}>Rename</Text>
              </Pressable>
            </View>
          </View>
        ) : page ? (
          <View style={S.card}>
            {choices.map((c, i) => (
              <Row key={c.id} first={i === 0} onPress={() => choose(c.id)}>
                <View style={S.grow}>
                  <Text style={S.title}>{c.label}</Text>
                  {c.hint ? <Text style={S.subtle}>{c.hint}</Text> : null}
                </View>
                {c.current ? <Text style={{ color: T.accent, fontSize: 17 }}>✓</Text> : null}
              </Row>
            ))}
          </View>
        ) : (
          <View style={S.card}>
            {rows.map((r, i) => (
              <Row key={r.id} first={i === 0} onPress={() => (r.choices ? setPage(r.id) : act(r.id))}>
                <Text style={[S.title, r.tone === "danger" ? { color: T.danger } : null, S.grow]}>{r.label}</Text>
                {r.value ? <Text style={S.muted}>{r.value}</Text> : null}
                {r.choices ? <Text style={{ color: T.faint, fontSize: 17 }}>›</Text> : null}
              </Row>
            ))}
            {rows.length === 0 ? (
              <Row first><Text style={S.muted}>That machine is not connected.</Text></Row>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
