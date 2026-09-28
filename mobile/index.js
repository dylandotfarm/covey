// The app's entry. `registerRootComponent` is what Expo's native code calls,
// and it must run before anything touches React Native's modules.
import { registerRootComponent } from "expo";
import { App } from "./src/App";

registerRootComponent(App);
