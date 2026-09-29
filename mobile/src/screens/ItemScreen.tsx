/**
 * An issue or a pull request (issue #168, and #108 for the screen itself).
 *
 * `itemStateLabel`, `checksLabel`, `itemActions` and `holderOf` are all
 * `@covey/web`'s and shared with the page. What the daemon does is read the item
 * with `gh` in the project's checkout and act on it there, each act on a host
 * built for that one write — so the client only has to ask.
 *
 * The checks come from the check runs and never from `mergeStateStatus`. That is
 * the daemon's rule; this screen just paints what it sent.
 */
import { useCallback, useLayoutEffect, useState } from "react";
import { KeyboardAvoidingView, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GitHubAction, MergeMethod } from "@covey/protocol";
import { checksLabel, holderOf, isGitHubAttachment, itemActions, itemStateLabel, mediaSrc, relTime } from "@covey/web";
import { store } from "../store";
import { useStore } from "../useStore";
import { SIZE, T } from "../theme";
import { Button, Empty, Notice, Pill, S, SectionTitle, Spinner, useContentInsets } from "../ui";
import { Markdown } from "../components/Markdown";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Item">;

const STATE_COLOUR = { open: T.success, closed: T.danger, merged: T.accent, draft: T.subtle } as const;

/** One colour per `CheckState`. */
const CHECK_COLOUR: Record<string, string> = {
  success: T.success,
  failure: T.danger,
  pending: T.warning,
  neutral: T.subtle,
};

export function ItemScreen({ route, navigation }: Props) {
  useStore();
  const { machine, projectId, number } = route.params;
  const [body, setBody] = useState("");
  const [method, setMethod] = useState<MergeMethod>("merge");

  const insets = useContentInsets();
  const headerHeight = useHeaderHeight();
  const iv = store.state.item;
  const mine = iv && iv.machine === machine && iv.projectId === projectId && iv.number === number ? iv : null;

  // Reading the item is the screen's own business, and the thread under it keeps
  // its subscription: the item is a look aside and the return must cost nothing.
  useLayoutEffect(() => { store.showItem(machine, projectId, number); }, [machine, projectId, number]);

  const item = mine?.item ?? null;
  const slot = store.state.machines.get(machine);

  useLayoutEffect(() => {
    navigation.setOptions({ title: item ? `#${item.number}` : `#${number}` });
  }, [navigation, item, number]);

  const act = useCallback((action: GitHubAction) => {
    store.actItem(action);
    setBody("");
  }, []);

  if (!mine || (mine.loading && !item)) {
    return <View style={[S.screen, { alignItems: "center", justifyContent: "center" }]}><Spinner /></View>;
  }
  if (mine.error && !item) {
    return (
      <View style={S.screen}>
        <Empty title={`#${number} would not open.`} hint={mine.error} />
        <View style={{ padding: 16, alignItems: "center" }}>
          <Button label="Try again" onPress={store.loadItem} />
        </View>
      </View>
    );
  }
  if (!item) return <Empty title="Nothing to show." />;

  const state = itemStateLabel(item);
  const checks = item.kind === "pull" ? checksLabel(item) : null;
  const holder = holderOf(store.state, machine, projectId, number);
  const actions = itemActions(item);
  const src = (url: string) => (isGitHubAttachment(url) ? mediaSrc(url, slot?.token) : url);

  return (
    <KeyboardAvoidingView style={S.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {store.notice ? <Notice text={store.notice} onDismiss={store.clearNotice} /> : null}
      <ScrollView
        refreshControl={<RefreshControl refreshing={mine.loading} onRefresh={store.loadItem} tintColor={T.accent} />}
        contentContainerStyle={{ paddingBottom: 28 + insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ padding: 14, gap: 8 }}>
          <Text style={{ color: T.text, fontSize: SIZE.heading, fontWeight: "700" }}>{item.title}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pill text={state} colour={STATE_COLOUR[state]} />
            {checks && checks.state !== "none" ? (
              <Pill
                text={checks.text}
                colour={checks.state === "success" ? T.success : checks.state === "failure" ? T.danger : T.warning}
              />
            ) : null}
            {item.kind === "pull" ? <Pill text={`${item.baseRefName} ← ${item.headRefName}`} /> : null}
            {item.author ? <Text style={S.subtle}>{item.author}</Text> : null}
            {item.createdAt ? <Text style={S.subtle}>{relTime(item.createdAt)}</Text> : null}
          </View>
          {item.labels.length ? (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {item.labels.map((l) => <Pill key={l} text={l} colour={T.muted} />)}
            </View>
          ) : null}
          {item.kind === "pull" && item.mergeable === "CONFLICTING" ? (
            <Text style={{ color: T.warning, fontSize: SIZE.small }}>This branch conflicts with its base.</Text>
          ) : null}
          {holder ? (
            <Pressable onPress={() => navigation.navigate("Thread", { machine, threadId: holder.id })}>
              <Text style={{ color: T.accent, fontSize: SIZE.small }}>Held by “{holder.title || "a conversation"}” — open it</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void Linking.openURL(item.url).catch(() => {})}>
            <Text style={{ color: T.accent, fontSize: SIZE.small }}>Open on GitHub</Text>
          </Pressable>
        </View>

        {item.body.trim() ? (
          <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            <Markdown text={item.body} ctx={{ src }} />
          </View>
        ) : null}

        {item.kind === "pull" && item.checks.length ? (
          <>
            <SectionTitle text="Checks" />
            <View style={S.card}>
              {item.checks.map((c, i) => (
                <View key={i} style={[S.row, i === 0 ? null : S.rowDivider]}>
                  <View style={S.grow}>
                    <Text style={S.title} numberOfLines={1}>{c.name}</Text>
                    {c.workflow ? <Text style={S.subtle}>{c.workflow}</Text> : null}
                  </View>
                  <Text style={{ color: CHECK_COLOUR[c.state] ?? T.warning, fontSize: SIZE.small }}>{c.state}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {item.comments.length ? (
          <>
            <SectionTitle text={`${item.comments.length} comment${item.comments.length === 1 ? "" : "s"}`} />
            {item.comments.map((c, i) => (
              <View key={i} style={[S.card, { padding: 12, gap: 4 }]}>
                <Text style={S.subtle}>{c.author} · {relTime(c.createdAt)}</Text>
                <Markdown text={c.body} ctx={{ src }} />
              </View>
            ))}
          </>
        ) : null}

        {mine.error ? <Text style={{ color: T.danger, fontSize: SIZE.small, padding: 14 }}>{mine.error}</Text> : null}

        <SectionTitle text="Act" />
        <View style={{ paddingHorizontal: 12, gap: 10 }}>
          {/*
            The field the acts below write with. It was missing on the first
            build, which left "Comment" and "Request changes" permanently
            disabled — both are gated on there being something written, and
            there was nowhere to write it.
          */}
          {actions.some((a) => a.needsBody) ? (
            <>
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder="Write a comment, or the reason for requesting changes"
                placeholderTextColor={T.faint}
                multiline
                style={{
                  color: T.text, fontSize: SIZE.body, backgroundColor: T.surface,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 84,
                }}
              />
              <Text style={S.subtle}>A review that asks for changes, and a comment, both need something written.</Text>
            </>
          ) : null}
          {item.kind === "pull" && item.state === "OPEN" ? (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Text style={S.subtle}>Merge by</Text>
              {(["merge", "squash", "rebase"] as MergeMethod[]).map((m) => (
                <Pressable key={m} onPress={() => setMethod(m)} hitSlop={6}>
                  <Text style={{ color: method === m ? T.accent : T.subtle, fontSize: SIZE.small, fontWeight: method === m ? "700" : "400" }}>{m}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {actions.map((a) => (
              <Button
                key={`${a.action.kind}:${"event" in a.action ? a.action.event : ""}`}
                label={a.label}
                tone={a.tone === "danger" ? "danger" : a.tone === "primary" ? "primary" : "normal"}
                busy={mine.busy}
                disabled={a.needsBody && !body.trim()}
                onPress={() => {
                  const action = a.action;
                  if (action.kind === "merge") { act({ kind: "merge", method }); return; }
                  if (action.kind === "comment") { act({ kind: "comment", body }); return; }
                  if (action.kind === "review") { act({ ...action, ...(body.trim() ? { body } : {}) }); return; }
                  act(action);
                }}
              />
            ))}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
