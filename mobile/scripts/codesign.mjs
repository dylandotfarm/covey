/**
 * Make the key pair that signs an over-the-air update (issue #168).
 *
 * The app verifies every manifest against a certificate built into it, so a
 * bundle can only come from the machine that holds the matching private key.
 * Without this an update is whatever answered the request.
 *
 * The certificate is committed; the private key is not, and this script writes
 * it where the daemon looks for it and nowhere else:
 *
 *   mobile/certs/certificate.pem      committed, built into the app
 *   $COVEY_HOME/mobile-signing-key.pem   the private key, never committed
 *
 * Run it once per machine that is to serve updates. Run it again and every app
 * already built against the old certificate stops accepting updates until it is
 * rebuilt, which is why it refuses to overwrite.
 *
 *   pnpm run codesign
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const certs = join(app, "certs");
const keyDir = process.env.COVEY_HOME || join(homedir(), ".covey");
const keyFile = join(keyDir, "mobile-signing-key.pem");
const certFile = join(certs, "certificate.pem");

if (existsSync(certFile) || existsSync(keyFile)) {
  console.error(`refusing to overwrite: ${existsSync(certFile) ? certFile : keyFile} exists.`);
  console.error("An app built against the current certificate would stop accepting updates.");
  console.error("Delete both by hand if that is what you mean, and rebuild the app afterwards.");
  process.exit(1);
}

mkdirSync(certs, { recursive: true });
mkdirSync(keyDir, { recursive: true });
const staging = join(app, ".codesign-keys");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging);

console.log("generating the key pair and the certificate…");
execFileSync("npx", [
  "expo-updates", "codesigning:generate",
  "--key-output-directory", staging,
  "--certificate-output-directory", certs,
  "--certificate-validity-duration-years", "10",
  "--certificate-common-name", "covey",
], { cwd: app, stdio: "inherit" });

// The private key goes out of the checkout entirely, so no rule about what is
// committed has to hold it back.
renameSync(join(staging, "private-key.pem"), keyFile);
rmSync(staging, { recursive: true, force: true });

console.log(`\ncertificate: ${certFile}   (commit this; it is built into the app)`);
console.log(`private key: ${keyFile}   (never commit this)`);
console.log("\nRebuild the app so it carries the certificate, then `pnpm run export`.");
