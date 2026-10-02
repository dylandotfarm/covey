# covey on a device

*Issue #178. A thing with two buttons and a screen that you talk to, and that
shows you what the agent said. It is a peripheral of the phone, not a fourth
client: it holds no covey state, has no credentials, and has never heard of a
machine.*

![Six screens of the device: the thread list the phone sent, the menu button
walking it, what covey heard, the turn running, the agent's answer, and the
second page of it. Every frame is the device's own framebuffer, read over
USB.](media/device.gif)

## What it is

The board is a [Waveshare ESP32-S3 1.54inch e-Paper][board] — an
ESP32-S3-PICO-1 with 8 MB of flash and 8 MB of PSRAM, a 200 by 200 black and
white panel, an ES8311 codec for the microphone, a battery, and two buttons.
About $25. The firmware is in `firmware/`, ESP-IDF 5.5, plain C.

[board]: https://www.waveshare.com/esp32-s3-epaper-1.54.htm

The chip has Bluetooth Low Energy and **no Bluetooth Classic**, so there is no
serial port profile and no A2DP. Everything here is GATT.

## The loop

```
  you hold talk  ──▶ the device records ──▶ ADPCM ──▶ BLE ──▶ the phone
                                                               │
                              Android's recogniser ◀── a WAV ◀─┘
                                       │
                                       ▼
                             turn.send on the thread
                                       │
                                       ▼
                     the daemon, the agent, the answer
                                       │
   the device paints it ◀── BLE ◀── the app reads the timeline
```

Five seconds of speech is about 40 kB on the air and reaches the phone in under
two. The recogniser runs on the phone, offline, and the words never leave it
until covey sends them to a thread.

## The two buttons

| | tap | hold |
| --- | --- | --- |
| **talk** (PWR) | page a reply too long for one screen | record; let go to send |
| **menu** (BOOT) | the next thread in the list | swap the list and the text |

The talk button is PWR and not BOOT because GPIO0 is the pin the chip samples
at reset: a reader holding BOOT while the device restarts lands in the serial
bootloader with a blank screen, and the button somebody holds for seconds at a
time must never be that one.

Recording starts the instant the button goes down, not when the press turns out
to be long — a person starts speaking as they press, and the first syllable is
what the recogniser needs most. A press under 350 ms throws those samples away
and is read as a tap.

## Who decides what

Nothing on the device is a second copy of a decision the app already makes.

| Decision | Where it lives |
| --- | --- |
| What the menu says and in what order | `projectRows` in `@covey/web`, flattened |
| Which thread is busy | `threadIsBusy` in `@covey/protocol` |
| What counts as "the reply" | the rule in `replyLead`: the last `assistant` item with prose |
| The frame, the codec, the WAV | `packages/client/src/device.ts` |

The device answers a menu pick with a **position** and the **generation** that
position belonged to. A UUID is 36 bytes and a menu is twenty of them, which is
a kilobyte of radio time for something the phone already knows; the generation
is what makes the position safe, because a pick against a list that has since
changed is refused rather than opening a thread nobody chose.

## The wire

One service, two characteristics, in `packages/client/src/device.ts`:

```
service   c0be1000-7b2d-4f1a-9c3e-1d5a8f0b6e21
uplink    c0be1001-…   the device notifies
downlink  c0be1002-…   the phone writes
```

Two, so a reply can go down while an utterance is still coming up.

A message is cut into fragments with a four-byte header — type, flags, and a
message id — because a thread list and an utterance are both longer than any
MTU a phone will agree to. BLE keeps what it carries on one characteristic in
order, so a fragment says only whether it opens a message and whether it closes
one. The message id is what makes a lost fragment *visible*: a fragment whose
id is not the one being assembled throws the half-built message away rather
than joining two utterances into one sentence.

Writes from the phone go in a queue. Two messages written at once interleave
their fragments, and the device drops a message whose fragments do not follow
each other.

## The audio

IMA ADPCM, 16 kHz, mono, four bits a sample.

Sixteen-bit samples are 32 kB for every second somebody holds the button and
BLE carries about a tenth of that, so a five-second question would take half a
minute to arrive. ADPCM costs the ESP32 almost nothing and is one pass of
arithmetic away from what Android transcribes.

It is **block based**: 256 bytes, 505 samples, and every block carries its own
predictor and step. A block damaged on the air costs its own 32 milliseconds
and not the rest of the sentence. The last block is padded to its boundary —
a block that does not start where the decoder looks is one it cannot find — so
the message also carries **the count of samples the device recorded**. Without
that count the recogniser is handed up to 31 ms of sound nobody made at the end
of every utterance.

Android transcribes a *file* and takes one shape of it: 16 kHz, 16-bit, one
channel, PCM in a WAV container. `wavFromPcm16` writes that and nothing else.
Hand it anything else and it answers `audio-capture`, which reads as a broken
microphone rather than as a wrong header.

### Keeping the two encoders honest

`firmware/main/adpcm.c` and `adpcmFromPcm` in `device.ts` must agree byte for
byte and can never run together. So the device encodes a fixed triangle wave
and prints the bytes, and `packages/client/src/device.test.ts` holds them:

```sh
cd firmware && sg dialout -c "python3 tools/console.py key t"
```

Paste the base64 into `DEVICE_ADPCM_BASE64`. If that test ever fails, one of
the two drifted and the words stopped arriving.

## Transcription

**The daemon writes out the words, not the phone** (#180). The phone carries
the recording to the daemon that holds the thread; the daemon hands it to a
transcription service on its own machine and sends the words back.

Three reasons it belongs there:

- The key that reaches a transcription service is a secret, and covey keeps
  secrets on the machine that runs the work (#126). A phone is not that machine.
- The service can be changed without anybody installing an app — and an app
  changes only by somebody installing one.
- The TUI and the web client get dictation from the same call.

What travels is the device's **own ADPCM blocks**, not the samples: a quarter of
the bytes, which on a phone's mobile link is a quarter of the wait. The daemon
decodes with `pcmFromAdpcm` from `@covey/client` — the same decoder the
firmware's encoder was written against, so there is one definition of the format.

The RPC is `transcribe` and `packages/daemon/src/transcribe.ts` answers it.
`COVEY_TRANSCRIBE_URL` names the service and defaults to
`http://127.0.0.1:8790`. Setting it to the **empty string** turns the feature
off, which is not the same as leaving it unset.

Measured, machine to service and back: a 5-second utterance in about 600 ms, an
11-second one in about 840 ms; over the daemon's socket end to end, 933 ms for
11 seconds.

### When it cannot

A daemon with nothing set up answers the code `unavailable`, and **only that
code** makes the phone fall back to its own recogniser (Android's, which is what
#180 was raised about — worse, but a device whose button does nothing is worse
still). Every other failure is real and its sentence goes to the device's screen
as it came: the service writes its sentences for that screen, and covey has
nothing better to say about silence than the thing that heard it.

A recording covey could not read never becomes a turn. When no words come back
the **loudness decides the sentence** — a microphone that heard nothing and a
recogniser that understood nothing are the same blank screen and two different
things to fix. That is the #132 rule, kept.

The settings screen names which of the two wrote the last words, because the
quality gap between them is wide enough that a reader seeing a bad transcript
should be able to tell, and a daemon that quietly stopped answering would
otherwise look like a recogniser that suddenly got worse.

## One thread at a time

A `MachineClient` holds one thread subscription; `watchThread` drops the last
one. So the device and the phone cannot look at different threads, and the
device wins: picking on the device opens that thread in the app too. It is a
remote control for the phone rather than a second client of the daemon, and
that is the whole reason it needs no credentials of its own.

## Painting

A full refresh is about two seconds and flashes the panel; a partial refresh is
about 0.3 seconds and leaves a faint trace that builds up. So covey paints
partially while somebody walks the menu and takes the slow one every
`EPAPER_FULL_EVERY` (8) to wipe the traces away. That number is the whole feel
of the device: too low and the screen flashes while somebody scrolls, too high
and the text greys out.

**One task paints, and nothing paints from a radio callback** — the Bluetooth
stack holds locks while it calls back, and a refresh is 300 ms. Messages are
copied and queued and the painting task takes them in its own time.

Nothing animates. A level meter at three frames a second would make the device
feel slower than it is and would say nothing the word "Listening" does not. The
reply goes to the screen **once, when the turn ends**, not while it streams.

## Security, and what it is not

The link bonds, so a reader pairs once and every later connection is encrypted
and silent. The characteristics do **not** demand encryption, and that is a
trade made on purpose: a phone that will not bond — Android has several reasons
not to, none of which it explains — would otherwise connect, subscribe, and
fail on the first write with nothing on either screen to say why. The audio on
this link is one radio hop to a phone in the same room, and everything past the
phone goes over the daemon's own authenticated socket.

To demand it, add `BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_WRITE_ENC` to the
characteristic flags in `firmware/main/ble.c`.

## Building and flashing

```sh
# once
git clone -b v5.5.1 --recursive https://github.com/espressif/esp-idf ~/esp/esp-idf
~/esp/esp-idf/install.sh esp32s3

# each time
. ~/esp/esp-idf/export.sh
cd firmware
idf.py build
idf.py -p /dev/ttyACM0 flash
```

The port is `/dev/ttyACM0` because this chip is its own USB device; there is no
separate serial bridge. You must be in the `dialout` group. If `id` does not
show it but `/etc/group` does, the session predates the change — `sg dialout -c
"…"` runs one command with it.

`python3 -m venv` fails on a Debian or Ubuntu machine without `python3-venv`,
and ESP-IDF's installer stops there. Without root, make the environment with
the virtualenv zipapp first:

```sh
curl -sSLo /tmp/virtualenv.pyz https://bootstrap.pypa.io/virtualenv.pyz
python3 /tmp/virtualenv.pyz ~/.espressif/python_env/idf5.5_py3.12_env
```

## The development console

The device takes single keys over its USB port. None of this is for a reader;
it is how the device is worked on when it is on a bench and nobody's hands are
on it.

| key | what it does |
| --- | --- |
| `f` / `F` | start and stop dumping every paint as base64 |
| `t` | encode the fixed tone and print the bytes |
| `m` | record two seconds and report the peak, the mean and the share of zeros |
| `p` | force a clean full repaint |
| `1` `2` | a tap and a hold of the menu button |
| `3` `4` `5` | talk down, talk up held, talk up tapped |
| `>…` | one downlink message, base64, type byte first |

`>` is the real protocol over a second transport rather than a test fixture
living in the firmware: the bytes are the ones `writeThreads` and `writeText`
produce. It is how the device is driven with no phone in the room.

```sh
cd firmware
node tools/demo.mjs > /tmp/demo.txt           # build the script with the real encoders
sg dialout -c "python3 tools/console.py drive /tmp/demo.txt --out shots --reset"
```

Every picture of a screen in the pull request came out of that — the device's
own framebuffer, not a photograph of it.

`m` is the one that matters when the microphone goes quiet. A wrong I²S pin
gives a codec that opens, reads that succeed, and every sample zero; `zeros=0%`
with a mean over about 100 is a microphone that works.

## Reaching it with the screen locked

Android stops a **background** app from receiving Bluetooth scan results while
the screen is off, and kills the process when the app is swiped away. Either one
makes the device unreachable, and the reader just sees a button that does
nothing.

`mobile/modules/covey-link` is the answer: a foreground service that does
nothing at all. It holds no connection and reads no characteristic — `ble.ts`
still owns the scan, the connection and the fragments. All it does is run in the
foreground, which lifts the scan restriction and stops the process being
reclaimed. Anything else in it would be a second implementation of something
that already works.

It costs a notification Android will not let covey hide, and that is right: a
reader should be able to see what is holding their radio open, and to stop it.
The channel is `IMPORTANCE_LOW`, so it sits in the shade without making a sound.

From Android 14 the service type must be declared **twice** — in the manifest
and again in the `startForeground` call — and a mismatch throws rather than
degrades. `connectedDevice` is the type, with
`FOREGROUND_SERVICE_CONNECTED_DEVICE` beside it.

The module is loaded with `requireOptionalNativeModule`, not
`requireNativeModule`. A bundle delivered over the air can land in an app built
before the module existed, and the strict call would throw at import time and
take the whole app down. Answering false is what an older app honestly is.

### The device keeps what it could not send

The firmware used to refuse to record at all when the link was down, so a
moment's disconnection threw away a sentence before the reader had finished
speaking it. Now it records regardless, encodes, and holds the utterance in
PSRAM until the link returns — then sends it from the status sweep rather than
from the connect event, because a phone is connected for a moment before it
subscribes and a send before that goes nowhere.

One held utterance, not a queue: somebody who speaks twice into a device that is
plainly not answering has said the same thing twice, and the second is the one
they meant.

## Installing a new app

A native change moves the runtime version, so it cannot come over the air. The
machine that built the app serves it instead, at `/apk`, gated exactly as
`/updates` is — and the settings screen offers it as a row to tap, so nobody has
to type an address into a phone's browser from memory.

`MachineInfo.appBuild` carries the version, the size and when gradle wrote it. A
machine that has never run `pnpm run apk` reports nothing and offers nothing,
which is most of them.

This is **not** the update channel. `/updates` carries JavaScript into an app
already installed, silently and often; `/apk` hands a whole binary to somebody
who chose to install it, for the one case the other refuses to handle.

## The cost of a native module

`react-native-ble-plx` is native code, so `mobile/app.config.ts` moves to
`0.3.0` and every installed app must be sideloaded once more. A bundle that
imports it cannot run in an app built without it, and `runtimeVersion` is what
stops the daemon from offering one. See `docs/MOBILE.md`.

## What it deliberately is not

- **Not a covey client.** It has no socket and no token. Unplug the phone and
  it is a screen with two buttons.
- **Not a speaker.** The ES8311 can play and the board has an amplifier, but
  reading an answer aloud is a different feature with different failure modes.
  The amplifier is left down and draws nothing.
- **Not a second thread.** One subscription, one thread, shared with the phone.
