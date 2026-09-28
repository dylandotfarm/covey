// A placeholder, replaced once the bundle is proven to resolve the shared
// packages. It exists to make `expo export` a real test of the module graph.
import { Text, View } from "react-native";
import { timelineRows } from "@covey/client";
import { DEFAULT_LOD } from "@covey/protocol";
import { relTime } from "@covey/web";

export function App() {
  const rows = timelineRows([], { lod: DEFAULT_LOD, toggled: new Set() });
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>{`rows ${rows.length} · ${relTime(null)} · ${DEFAULT_LOD}`}</Text>
    </View>
  );
}
