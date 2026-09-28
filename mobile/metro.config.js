/**
 * Metro, taught to find the three packages this app shares with the TUI and the
 * web client (issue #168).
 *
 * `mobile/` is its own workspace, so `@covey/protocol`, `@covey/client` and
 * `@covey/web` are not in its `node_modules` and never will be. They are read
 * where `tsc -b` wrote them, from the checkout above.
 *
 * Three settings, and each one is load-bearing:
 *
 * - `watchFolders` puts `packages/` inside Metro's world. A file outside it is
 *   a file Metro refuses to read, however well the path resolves.
 * - `extraNodeModules` maps the package name to the package directory, so
 *   `@covey/web`'s own `import "@covey/protocol"` resolves as well. The
 *   mapping has to be by name rather than by file, because the imports inside
 *   those packages are by name.
 * - `unstable_enablePackageExports` is what makes the name land on the right
 *   file: each package's `exports` map already names its entry, and
 *   `@covey/web`'s entry is `dist/state.js` rather than an index. Without this
 *   Metro looks for `main` in a directory that has no `index.js`.
 *
 * `nodeModulesPaths` is pinned to this directory alone so React Native is
 *  resolved once, from here. Two copies of React in one bundle is a blank
 *  screen with no error.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const app = __dirname;
const repo = path.resolve(app, "..");
const pkg = (name) => path.join(repo, "packages", name);

const config = getDefaultConfig(app);

config.watchFolders = [path.join(repo, "packages")];
config.resolver.nodeModulesPaths = [path.join(app, "node_modules")];
config.resolver.extraNodeModules = {
  "@covey/protocol": pkg("protocol"),
  "@covey/client": pkg("client"),
  "@covey/web": pkg("web"),
};
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
