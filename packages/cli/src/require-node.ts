/**
 * The first import of `index.ts`, and it has to stay first: ES modules evaluate
 * their imports in source order, so this runs before `@covey/daemon` pulls in
 * `node:sqlite` — which on Node 20 fails with a message nobody can act on.
 */
const MIN_MAJOR = 22;
if (Number(process.versions.node.split(".")[0]) < MIN_MAJOR) {
  console.error(`covey needs Node ${MIN_MAJOR} or newer; this is ${process.version}.`);
  process.exit(1);
}
