/*
 * Write the script that walks the device through its screens.
 *
 * The messages are built with the *real* encoders from `@covey/client`, so what
 * the device is shown here is byte for byte what the app sends it. The output
 * is a list of lines `tools/console.py drive` understands:
 *
 *   msg <base64>   one downlink message, type byte first
 *   key <c>        one console key
 *   wait <seconds>
 *   shot <name>    save the next frame under this name
 *
 * Run: node tools/demo.mjs > /tmp/demo.txt
 */
import {
  Down, DeviceState, TextKind, writeState, writeText, writeThreads,
} from "../../packages/client/dist/device.js";

const out = [];
const msg = (type, body) => {
  const whole = new Uint8Array(1 + body.length);
  whole[0] = type;
  whole.set(body, 1);
  out.push(`msg ${Buffer.from(whole).toString("base64")}`);
};

const threads = [
  { title: "Bluetooth pairing for the app", busy: true },
  { title: "A notice says why a repo failed", busy: false },
  { title: "Render the app in a browser", busy: false },
  { title: "width() miscounts combining marks", busy: false },
  { title: "Shell access in a thread", busy: false },
  { title: "Indent conversations further", busy: false },
];

out.push("wait 4"); // let the device finish booting after a reset
out.push("key f"); // dump every paint from here on
out.push("wait 1");

msg(Down.threads, writeThreads(1, threads));
out.push("wait 3");
out.push("shot menu");

out.push("key 1"); // the menu button: walk to the next thread
out.push("wait 3");
out.push("shot menu-moved");

msg(Down.state, writeState(DeviceState.hearing));
out.push("wait 2");
msg(Down.text, writeText(TextKind.heard, "Add a note to the readme about the two buttons"));
out.push("wait 3");
out.push("shot heard");

msg(Down.state, writeState(DeviceState.busy));
out.push("wait 3");
out.push("shot working");

msg(Down.state, writeState(DeviceState.idle));
msg(
  Down.text,
  writeText(
    TextKind.reply,
    "I added a section to the readme. It says the talk button records while " +
      "you hold it and sends when you let go, and that the menu button walks " +
      "the thread list.\n\nThe tests pass and the build is clean. One thing " +
      "worth knowing: the device shows what covey heard before the agent " +
      "answers, so a word the recogniser got wrong is visible straight away " +
      "rather than after a turn has run on it.",
  ),
);
out.push("wait 3");
out.push("shot reply");

out.push("key 5"); // a tap of talk: page the reply
out.push("wait 3");
out.push("shot reply-page-2");

out.push("key 2"); // a hold of menu: back to the list
out.push("wait 3");
out.push("shot back-to-menu");

console.log(out.join("\n"));
