export { runDaemon, installStopHandlers, type DaemonHandle } from "./main.js";
export { dataDir, loadDaemonConfig } from "./config.js";
export { webAddresses, withToken } from "./addresses.js";
export { tailscaleSelf } from "./tailscale.js";
export { clearPidFile, isAlive, pidFilePath, readPidFile, type PidRecord } from "./pidfile.js";
export { Engine } from "./engine.js";
export { Updater, sourceInfo, sourceRoot } from "./update.js";
export { coveyPlugin } from "./plugin.js";
export { buildInfo, buildLabel, buildDirs, newestBuildMtime, buildIsNewerThan } from "./build.js";
