/**
 * Machines, and this app's own updates (issue #168).
 *
 * The machine rows are the page's settings page: every machine of the fleet, what
 * it is doing, and a way into its defaults. Two things here are the app's alone.
 *
 * **The machines a person added.** They can be forgotten, which the page has no
 * need of — it is served by one daemon and learns the others. A fleet member is
 * not on this list: the TUI owns that, and a copy here would go stale.
 *
 * **The bundle this app is running.** Where it came from, when it was built, and
 * whether the machine has a newer one. Taking it is a tap and never automatic: a
 * reload throws away what the reader was typing.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LOD_LABEL, LOD_ORDER, type Lod } from "@covey/protocol";
import { bindLabel, relTime, updateLabel } from "@covey/web";
import { store, ULTRA } from "../store";
import { useStore } from "../useStore";
import { SIZE, T } from "../theme";
import { Button, Dot, Notice, Pill, Row, S, SectionTitle, useContentInsets } from "../ui";
import { applyUpdate, fetchUpdate, updateInconsistency, updateMachineName, updateStatus, updatesEnabled, type UpdateStatus } from "../ota";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Settings">;

/** The colour a connection state reads as. */
const CONN: Record<string, string> = {
  connected: T.success,
  connecting: T.warning,
  offline: T.subtle,
  error: T.danger,
};

export function SettingsScreen({ navigation }: Props) {
  useStore();
  const insets = useContentInsets();
  const s = store.state;
  const [ota, setOta] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [ready, setReady] = useState(false);
  const [otaWord, setOtaWord] = useState<string | null>(null);

  useEffect(() => {
    void updateMachineName().then((name) => setOta(updateStatus(name)));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setOtaWord(null);
    try {
      const r = await fetchUpdate();
      if (r.ready) { setReady(true); setOtaWord("A newer bundle is ready."); }
      else setOtaWord(r.message);
    } finally {
      setChecking(false);
    }
  }, []);

  const forget = (url: string, name: string) => {
    Alert.alert(`Forget ${name}?`, "Its address and its token leave this device. The machine is untouched.", [
      { text: "Keep", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => void store.forget(url) },
    ]);
  };

  const update = (url: string, name: string) => {
    const busy = store.busyThreads(url);
    Alert.alert(
      `Update ${name}?`,
      `It pulls, rebuilds and restarts the daemon.${busy ? ` ${busy} running turn${busy === 1 ? "" : "s"} will be interrupted.` : ""}`,
      [{ text: "Cancel", style: "cancel" }, { text: "Update", onPress: () => store.updateMachine(url) }],
    );
  };

  const restart = (url: string, name: string) => {
    Alert.alert(`Restart the daemon on ${name}?`, "Running turns will be interrupted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Restart", style: "destructive", onPress: () => store.restartMachine(url) },
    ]);
  };

  return (
    <View style={S.screen}>
      {store.notice ? <Notice text={store.notice} onDismiss={store.clearNotice} /> : null}
      <ScrollView
        refreshControl={<RefreshControl refreshing={false} onRefresh={store.retry} tintColor={T.accent} />}
        contentContainerStyle={{ paddingBottom: 36 + insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}
      >
        {/*
          The level of detail, at the head of the page — where the web client
          puts the same choice. It was a row above every transcript once, which
          cost a line on every conversation to answer a question a reader asks
          about twice a month, on the screen with fewest lines to give.

          It is this *device's* preference and travels in no command: the phone
          reads a thread at `compact` while the laptop running it reads the same
          thread at `full`.
        */}
        <SectionTitle text="Detail" />
        <View style={S.card}>
          <Row first onPress={() => store.setDetail(ULTRA)}>
            <View style={S.grow}>
              <Text style={S.title}>Ultra</Text>
              <Text style={S.subtle}>what it is doing, one sentence, and the pictures — for a cover screen</Text>
            </View>
            {store.ultra ? <Text style={{ color: T.accent, fontSize: 17 }}>✓</Text> : null}
          </Row>
          {LOD_ORDER.map((l: Lod) => (
            <Row key={l} onPress={() => store.setDetail(l)}>
              <View style={S.grow}>
                <Text style={S.title}>{LOD_LABEL[l].label}</Text>
                <Text style={S.subtle}>{LOD_LABEL[l].hint}</Text>
              </View>
              {!store.ultra && s.lod === l ? <Text style={{ color: T.accent, fontSize: 17 }}>✓</Text> : null}
            </Row>
          ))}
        </View>

        <SectionTitle text="Machines" />
        {[...s.machines.values()].map((m) => {
          // Only what a person typed can be forgotten. A fleet member came from
          // the TUI's list and forgetting it here would mean nothing: the next
          // `machine.access` would bring it straight back.
          const added = store.saved.some((x) => x.url === m.key);
          return (
            <View key={m.key} style={S.card}>
              <Row
                first
                onPress={() => navigation.navigate("Sheet", { target: { kind: "machine", machine: m.key } })}
              >
                <Dot colour={CONN[m.conn] ?? T.subtle} />
                <View style={S.grow}>
                  <Text style={[S.title, { fontWeight: "600" }]} numberOfLines={1}>{m.name}</Text>
                  <Text style={S.subtle} numberOfLines={1}>
                    {m.key}
                    {m.primary ? " · asked for the fleet" : added ? "" : " · from the fleet"}
                  </Text>
                  {m.connError ? <Text style={{ color: T.danger, fontSize: SIZE.small }}>{m.connError}</Text> : null}
                  {m.info?.settings.bind ? <Text style={S.subtle}>{bindLabel(m.info.settings.bind)}</Text> : null}
                  {m.update ? <Text style={{ color: T.warning, fontSize: SIZE.small }}>{updateLabel(m.update)}</Text> : null}
                </View>
                <Text style={{ color: T.faint, fontSize: 17 }}>›</Text>
              </Row>
              <View style={[S.row, S.rowDivider, { gap: 8, flexWrap: "wrap" }]}>
                <Button label="Update" onPress={() => update(m.key, m.name)} disabled={m.conn !== "connected"} />
                <Button label="Restart" onPress={() => restart(m.key, m.name)} disabled={m.conn !== "connected"} />
                <View style={S.grow} />
                {added ? <Button label="Forget" tone="danger" onPress={() => forget(m.key, m.name)} /> : null}
              </View>
            </View>
          );
        })}

        <View style={{ padding: 12 }}>
          <Button label="Add a machine" tone="primary" onPress={() => navigation.navigate("AddMachine")} />
        </View>

        <SectionTitle text="This app" />
        <View style={S.card}>
          <Row first>
            <View style={S.grow}>
              <Text style={S.title}>Bundle</Text>
              <Text style={S.subtle}>
                {ota?.embedded
                  ? "the one built into the app"
                  : ota?.createdAt
                    ? `taken over the air, ${relTime(ota.createdAt.toISOString())}`
                    : "unknown"}
              </Text>
            </View>
            {ota?.runtimeVersion ? <Pill text={ota.runtimeVersion} /> : null}
          </Row>
          <Row>
            <View style={S.grow}>
              <Text style={S.title}>Updates from</Text>
              <Text style={S.subtle}>
                {/* Baked in when the app was built, and app.config.ts says why. */}
                {updatesEnabled() ? (ota?.machine ?? "a machine this device has not added") : "nowhere — this build takes none"}
              </Text>
            </View>
          </Row>
          {/* A build whose two halves disagree says so here. It is the one
              failure a reader cannot diagnose from anything else on screen. */}
          {updateInconsistency() ? (
            <Row><Text style={[{ color: T.warning, fontSize: SIZE.small }, S.grow]}>{updateInconsistency()}</Text></Row>
          ) : null}
          {otaWord ? (
            <Row><Text style={[S.muted, S.grow]}>{otaWord}</Text></Row>
          ) : null}
          {updatesEnabled() ? (
            <View style={[S.row, S.rowDivider, { gap: 8 }]}>
              <Button label="Check now" onPress={() => void check()} busy={checking} />
              <View style={S.grow} />
              {ready ? <Button label="Restart into it" tone="primary" onPress={() => void applyUpdate()} /> : null}
            </View>
          ) : null}
        </View>

        {ota?.updateId ? (
          <Text style={[S.subtle, { paddingHorizontal: 26, paddingTop: 10 }]} selectable>
            {ota.updateId}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
