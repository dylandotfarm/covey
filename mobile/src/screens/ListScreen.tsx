/**
 * The home screen: the fleets, or the projects when there is only one of them.
 *
 * A fleet is the line between two sets of machines on one tailnet — the ones at
 * work and the ones at home — and the line is real rather than cosmetic: a
 * repository pools inside one fleet and never across two, so the same
 * repository cloned at work and at home is two rows with their own threads and
 * their own machines. The terminal has drawn that line for a year; this screen
 * is the phone drawing it.
 *
 * **One fleet is the shape covey has always had, and it keeps it.** A reader
 * who has never made a second fleet opens the app on their projects, at the
 * depth they always were. The fleet rows appear the moment a second fleet does
 * and go when it goes, which is the same rule the TUI's own fleet fold follows.
 *
 * The projects themselves are `ProjectList`, because a tap on a fleet opens
 * exactly that list scoped to one fleet. Written once: a list the home screen
 * shows and the fleet screen does not would be two lists to keep in step.
 */
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { fleetRows, type FleetRow } from "@covey/web";
import { store } from "../store";
import { useStore } from "../useStore";
import { SIZE, T } from "../theme";
import { Empty, Pill, Row, S, useContentInsets } from "../ui";
import { Icon } from "../Icon";
import { ProjectList } from "../components/ProjectList";
import { TopLines } from "../components/TopLines";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "List">;

export function ListScreen({ navigation }: Props) {
  useStore();
  // A camera punch is inside the screen on Android 15 and later, and on a
  // Razr's cover display it is inside the only screen there is.
  const insets = useContentInsets();
  const s = store.state;

  if (!store.loaded) return <View style={S.screen} />;

  if (s.machines.size === 0) {
    return (
      <View style={S.screen}>
        <Empty
          title="No machines yet."
          hint="Add the machine that runs covey. In the TUI, press enter on a machine row to see its address."
        />
        {/* The insets, or the navigation bar sits over the one control this
            screen has. `S.screen` fills the window and Android draws its bars
            on top, so a flat padding leaves the label half covered and the
            bottom of the button untappable — and a reader with no machine yet
            has nothing else to press. The list below pads the same way. */}
        <View
          style={{
            padding: 16,
            paddingBottom: 16 + insets.bottom,
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right,
          }}
        >
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

  const settings = (
    <Pressable onPress={() => navigation.navigate("Settings")} style={[S.row, { paddingBottom: 4 }]}>
      <Icon name="settings" size={16} colour={T.accent} />
      <Text style={{ color: T.accent, fontSize: SIZE.small }}>Machines and settings</Text>
    </Pressable>
  );

  const fleets = fleetRows(s);

  return (
    <View style={S.screen}>
      <TopLines />
      {fleets.length > 1 ? (
        <FlatList
          data={fleets}
          keyExtractor={(f) => f.key}
          // The gesture that dials a machine again, as the project list has it:
          // a reader whose fleet is empty because a machine is asleep reaches
          // for this before they read the banner.
          refreshControl={<RefreshControl refreshing={false} onRefresh={store.retry} tintColor={T.accent} />}
          ListHeaderComponent={settings}
          renderItem={({ item: f }) => (
            <View style={S.card}>
              <Row first onPress={() => navigation.navigate("Projects", { fleet: f.name })}>
                <View style={S.grow}>
                  {/* A fleet name is a reader's own word, so it keeps the case
                      they typed. `fleetKey` folds the case to decide what is
                      one fleet; nothing folds it to paint one. */}
                  <Text style={[S.title, { fontWeight: "600" }]} numberOfLines={1}>{f.name}</Text>
                  <Text style={S.subtle} numberOfLines={1}>{fleetMeta(f)}</Text>
                </View>
                {/* A fleet may not hide that something inside it is working or
                    waits on a person — the rule the project row keeps one
                    level down, and the reason a reader can stay here. */}
                {f.waiting > 0 ? <Pill text={`${f.waiting} waiting`} colour={T.awaiting} /> : null}
                {f.active > 0 ? <Pill text={`${f.active} busy`} colour={T.working} /> : null}
                <Icon name="chevron" size={20} colour={T.faint} />
              </Row>
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 28 + insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}
        />
      ) : (
        <ProjectList header={settings} />
      )}
    </View>
  );
}

/** What a fleet holds, in the words the TUI's own fleet row uses. */
function fleetMeta(f: FleetRow): string {
  return `${f.projects} project${f.projects === 1 ? "" : "s"} · ${f.machines} machine${f.machines === 1 ? "" : "s"}`;
}
