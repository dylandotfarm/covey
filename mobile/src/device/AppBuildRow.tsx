/**
 * The app a machine has built, and the button that asks it for a new one (#185).
 *
 * A native change moves the runtime version, so it cannot come over the air —
 * somebody has to install a binary. That used to mean typing an address into
 * the phone's browser from memory. The machine that built it is one the app is
 * already connected to and already has a token for, so it can simply be a row
 * to tap.
 *
 * The row says the version so a reader can see whether tapping it is worth
 * anything: an APK the same version as the running app is the one already
 * installed. What the version does *not* say is how old the code behind it is.
 * A machine update runs `git pull`, `pnpm install` and `pnpm run build`, and
 * none of those reach `mobile/`, so a machine can hold a binary built weeks
 * before the code it now runs — which is what the build button is for. It is
 * the whole of the answer to "give me the current app": ask the machine, watch
 * the steps, then tap the row above them.
 *
 * A machine that has never built one is listed too, with no version and the
 * same button. That is where the offer is worth most, and the old row showed
 * such a machine nothing at all.
 */
import { Linking, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { appBuildLabel } from "@covey/web";
import { store } from "../store";
import { SIZE, T } from "../theme";
import { Button, Row, S, SectionTitle } from "../ui";

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
  const machines = [...store.state.machines.values()].filter((m) => m.info?.appBuild || m.info?.canBuildApp);

  if (machines.length === 0) return null;

  return (
    <>
      <SectionTitle text="Install" />
      <View style={S.card}>
        {machines.map((machine, i) => {
          const build = machine.info?.appBuild ?? null;
          const run = machine.appBuild;
          const building = run?.state === "running";
          const current = build != null && RUNNING != null && build.version === RUNNING;
          return (
            <View key={machine.key}>
              <Row
                first={i === 0}
                {...(build ? { onPress: () => void Linking.openURL(apkUrl(machine.key, machine.token)) } : {})}
              >
                <View style={S.grow}>
                  <Text style={S.title}>
                    {build ? `covey ${build.version}` : "No app built yet"}
                    {current ? " — the one you are running" : ""}
                  </Text>
                  <Text style={S.subtle}>
                    {machine.name}
                    {build ? ` · ${megabytes(build.bytes)}` : ""}
                    {build && day(build.builtAt) ? ` · built ${day(build.builtAt)}` : ""}
                  </Text>
                  <Text style={{ color: T.subtle, fontSize: SIZE.small }}>
                    {!build
                      ? "Build it here and this row becomes the app to install."
                      : current
                        ? "Tap to install it again."
                        : "Tap to install. Android asks once to allow it."}
                  </Text>
                  {/* The one line of a build, where every other machine failure
                      on this screen says its own. A failed build keeps saying
                      so until the next one starts: it is the only record a
                      reader has, and the daemon's log is not on this phone. */}
                  {run ? (
                    <Text style={{ color: run.state === "failed" ? T.danger : T.subtle, fontSize: SIZE.small }}>
                      {appBuildLabel(run)}
                    </Text>
                  ) : null}
                </View>
              </Row>
              {machine.info?.canBuildApp ? (
                <View style={[S.row, S.rowDivider, { gap: 8 }]}>
                  <Button
                    label={building ? "Building the app" : "Build the app"}
                    onPress={() => store.buildApp(machine.key)}
                    disabled={machine.conn !== "connected"}
                    busy={building}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </>
  );
}
