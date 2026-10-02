/**
 * A link to the app a machine has built (#185).
 *
 * A native change moves the runtime version, so it cannot come over the air —
 * somebody has to install a binary. That used to mean typing an address into
 * the phone's browser from memory. The machine that built it is one the app is
 * already connected to and already has a token for, so it can simply be a row
 * to tap.
 *
 * Only a machine that has actually built an app offers one, which is most
 * likely one. The row says the version so a reader can see whether tapping it
 * is worth anything: an APK the same version as the running app is the one
 * already installed.
 */
import { Linking, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { store } from "../store";
import { SIZE, T } from "../theme";
import { Row, S, SectionTitle } from "../ui";

/**
 * The version of the app that is running.
 *
 * From `expo-updates` and not from `Constants.expoConfig`: the runtime version
 * is keyed on the binary's own version (`runtimeVersion: { policy: "appVersion" }`
 * in `app.config.ts`), so it is the one number that cannot disagree with the
 * binary it is read inside. There is no `app.json` in this project to read, and
 * a file that looks authoritative and is not would be worse than nothing.
 */
const RUNNING: string | null = Updates.runtimeVersion ?? null;

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * The URL the browser opens.
 *
 * The socket's address with the scheme changed and the token on the query
 * string, which is how every route that a browser rather than the client
 * fetches is reached (#135) — a download carries no header to put it in.
 */
function apkUrl(machineKey: string, token: string | undefined): string {
  const http = machineKey.replace(/^ws/, "http").replace(/\/+$/, "");
  return token ? `${http}/apk?token=${encodeURIComponent(token)}` : `${http}/apk`;
}

export function AppBuildRow() {
  const builds = [...store.state.machines.values()]
    .filter((m) => m.info?.appBuild)
    .map((m) => ({ machine: m, build: m.info!.appBuild! }));

  if (builds.length === 0) return null;

  return (
    <>
      <SectionTitle text="Install" />
      <View style={S.card}>
        {builds.map(({ machine, build }, i) => {
          const current = RUNNING != null && build.version === RUNNING;
          return (
            <Row
              key={machine.key}
              first={i === 0}
              onPress={() => void Linking.openURL(apkUrl(machine.key, machine.token))}
            >
              <View style={S.grow}>
                <Text style={S.title}>
                  covey {build.version}
                  {current ? " — the one you are running" : ""}
                </Text>
                <Text style={S.subtle}>
                  {machine.name} · {megabytes(build.bytes)}
                  {day(build.builtAt) ? ` · built ${day(build.builtAt)}` : ""}
                </Text>
                <Text style={{ color: T.subtle, fontSize: SIZE.small }}>
                  {current
                    ? "Tap to install it again."
                    : "Tap to install. Android asks once to allow it."}
                </Text>
              </View>
            </Row>
          );
        })}
      </View>
    </>
  );
}
