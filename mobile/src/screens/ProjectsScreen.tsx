/**
 * One fleet's projects.
 *
 * The screen a tap on a fleet row opens, and a screen rather than a fold
 * because that is what the back gesture already shuts — the lesson `nav.ts`
 * holds for a picture and for the settings sheet.
 *
 * It names the fleet rather than carrying its rows, so a project that appears
 * or a thread that starts while the reader is in here arrives on its own.
 * `projectRows` is asked for that one fleet, which is where the line between
 * two fleets is actually drawn.
 */
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { S } from "../ui";
import { ProjectList } from "../components/ProjectList";
import { TopLines } from "../components/TopLines";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Projects">;

export function ProjectsScreen({ route }: Props) {
  return (
    <View style={S.screen}>
      <TopLines />
      <ProjectList fleet={route.params.fleet} />
    </View>
  );
}
