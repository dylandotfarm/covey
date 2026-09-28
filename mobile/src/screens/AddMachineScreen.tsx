/**
 * Adding a machine (issue #168).
 *
 * The one screen the page has no equivalent of: a page is served by a daemon and
 * knows an address before it runs a line. `parseAddress` guesses what somebody
 * meant, and the case that must never break is the paste — a token reaches a
 * phone by pasting the link the TUI printed, not by being typed out.
 */
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { parseAddress } from "../address";
import { store } from "../store";
import { SIZE, T } from "../theme";
import { Button, S, SectionTitle } from "../ui";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "AddMachine">;

export function AddMachineScreen({ navigation }: Props) {
  const [text, setText] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const input = {
    color: T.text, fontSize: SIZE.body, backgroundColor: T.surface,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, marginHorizontal: 12,
  } as const;

  const add = async () => {
    const parsed = parseAddress(text);
    if ("error" in parsed) { setError(parsed.error); return; }
    setBusy(true);
    try {
      // A token typed into the field wins over one in a pasted link: the field is
      // the more deliberate of the two.
      await store.addMachine({ url: parsed.url, name: parsed.name }, token.trim() || parsed.token);
      navigation.goBack();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    const clip = (await Clipboard.getStringAsync()).trim();
    if (!clip) return;
    setText(clip);
    setError(null);
    // The link the TUI prints carries the token, so a paste fills both fields.
    const parsed = parseAddress(clip);
    if (!("error" in parsed) && parsed.token) setToken(parsed.token);
  };

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <SectionTitle text="Address" />
      <TextInput
        style={input}
        value={text}
        onChangeText={(t) => { setText(t); setError(null); }}
        placeholder="pi, pi:3790, or the link the TUI printed"
        placeholderTextColor={T.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={[S.subtle, { paddingHorizontal: 14, paddingTop: 6 }]}>
        The daemon's default port is 3790. In the TUI, press enter on a machine row to see its addresses.
      </Text>

      <SectionTitle text="Token" />
      <TextInput
        style={input}
        value={token}
        onChangeText={setToken}
        placeholder="Only if this machine needs one"
        placeholderTextColor={T.faint}
        autoCapitalize="none"
        autoCorrect={false}
        // The value is a credential, so it is not left on the screen.
        secureTextEntry
      />
      <Text style={[S.subtle, { paddingHorizontal: 14, paddingTop: 6 }]}>
        A machine on this tailnet needs none: the daemon recognises its owner. It is kept in this
        device's keychain.
      </Text>

      {error ? <Text style={{ color: T.danger, fontSize: SIZE.small, paddingHorizontal: 14, paddingTop: 14 }}>{error}</Text> : null}

      <View style={{ flexDirection: "row", gap: 10, padding: 12, paddingTop: 20 }}>
        <Button label="Paste a link" onPress={() => void paste()} />
        <View style={S.grow} />
        <Button label="Add" tone="primary" onPress={() => void add()} busy={busy} disabled={!text.trim()} />
      </View>
    </ScrollView>
  );
}
