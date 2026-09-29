/**
 * The app (issue #168).
 *
 * Providers, the stack, and the one call that starts the store. Everything else
 * is a screen.
 */
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { store } from "./store";
import { primeUpdateToken } from "./ota";
import { loadIconFont } from "./Icon";
import { T } from "./theme";
import type { Routes } from "./nav";
import { ErrorBoundary } from "./ErrorBoundary";
import { ListScreen } from "./screens/ListScreen";
import { ThreadScreen } from "./screens/ThreadScreen";
import { ItemScreen } from "./screens/ItemScreen";
import { MediaScreen } from "./screens/MediaScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AddMachineScreen } from "./screens/AddMachineScreen";
import { SheetScreen } from "./screens/SheetScreen";

const Stack = createNativeStackNavigator<Routes>();

/** covey's own palette over React Navigation's dark theme. */
const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: T.bg,
    card: T.surface,
    text: T.text,
    border: T.border,
    primary: T.accent,
    notification: T.danger,
  },
};

export function App() {
  useEffect(() => {
    // Dial what this device remembers, then tell `expo-updates` the token for
    // the machine that serves bundles. In that order: the token comes from the
    // same store the machines do.
    // Before anything draws: the font comes down with the bundle, and an icon
    // that asks for it on mount draws nothing until it lands.
    loadIconFont();
    void store.start().then(primeUpdateToken);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/*
          Outside the navigator, so a throw in any screen is caught rather than
          unmounting the tree to a black screen. A release build has no red box,
          and the first send from a phone proved what that costs.
        */}
        <ErrorBoundary>
        <StatusBar barStyle="light-content" backgroundColor={T.surface} />
        <NavigationContainer theme={theme}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: T.surface },
              headerTintColor: T.text,
              headerTitleStyle: { fontSize: 16 },
              contentStyle: { backgroundColor: T.bg },
            }}
          >
            <Stack.Screen name="List" component={ListScreen} options={{ title: "covey" }} />
            <Stack.Screen name="Thread" component={ThreadScreen} options={{ title: "" }} />
            <Stack.Screen name="Item" component={ItemScreen} options={{ title: "" }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
            <Stack.Screen name="AddMachine" component={AddMachineScreen} options={{ title: "Add a machine" }} />
            {/*
              A picture and a sheet are both steps in the stack, so the back
              gesture shuts them — see `nav.ts`. Both are presented over what
              they came from rather than replacing it.
            */}
            <Stack.Screen
              name="Media"
              component={MediaScreen}
              options={{ presentation: "fullScreenModal", headerShown: false, animation: "fade" }}
            />
            <Stack.Screen
              name="Sheet"
              component={SheetScreen}
              options={{ presentation: "formSheet", headerShown: false, sheetAllowedDetents: [0.5, 1] }}
            />
          </Stack.Navigator>
        </NavigationContainer>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
