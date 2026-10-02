#!/usr/bin/env python3
"""
Talk to the device over its USB port.

The device has a one-key console (see `main.c`): `t` runs the encoder self test,
`f` turns the frame dump on and off, and `p` forces a clean repaint. This script
drives it, captures what comes back, and can save a frame as a PNG.

  python3 tools/console.py watch 10              read the log for 10 seconds
  python3 tools/console.py key f --seconds 6     press a key and read the answer
  python3 tools/console.py frames out/ --seconds 30
                                                 save every frame it sees as a PNG

Run it under `sg dialout` when the shell's groups do not include dialout.
"""
import argparse
import base64
import os
import sys
import time

sys.path.insert(0, os.path.expanduser("~/.espressif/python_env/idf5.5_py3.12_env/lib/python3.12/site-packages"))
import serial  # noqa: E402

PORT = os.environ.get("COVEY_DEVICE_PORT", "/dev/ttyACM0")


def frame_png(payload, width, height, path, scale=2):
    """Turn one dumped frame into a picture.

    The panel reads a 1 bit as white, so the bits are inverted here: what the
    firmware holds is what the screen is told, and what this writes is what a
    person sees.
    """
    from PIL import Image

    raw = base64.b64decode(payload)
    img = Image.new("1", (width, height), 1)
    row_bytes = width // 8
    for y in range(height):
        for x in range(width):
            bit = raw[y * row_bytes + (x >> 3)] & (0x80 >> (x & 7))
            img.putpixel((x, y), 1 if bit else 0)
    if scale != 1:
        img = img.resize((width * scale, height * scale), Image.NEAREST)
    img.save(path)
    return path



def drain(port, seconds, out_dir, name_holder, state):
    """Read for a while, saving any frame that arrives.

    `state` carries the bytes of a line that had not finished when the last call
    ran out of time. A frame is nearly seven kilobytes on one line, so it spans
    several reads and almost always several calls; a buffer that started empty
    each time cut every long line in half and printed the tail as rubbish.
    """
    end = time.time() + seconds
    while time.time() < end:
        state[0] += port.read(4096)
        while b"\n" in state[0]:
            line, state[0] = state[0].split(b"\n", 1)
            text = line.decode("utf-8", "replace").rstrip("\r")
            if text.startswith("COVEY-FRAME "):
                parts = text.split(" ", 3)
                name = name_holder[0] or "frame-%03d" % name_holder[1]
                path = os.path.join(out_dir, name + ".png")
                frame_png(parts[3], int(parts[1]), int(parts[2]), path)
                print("saved", path, flush=True)
                name_holder[0] = None
                name_holder[1] += 1
            elif text:
                print(" ", text, flush=True)


def drive(port, script_path, out_dir):
    """Run a script of messages, keys and waits, saving the frames it names."""
    os.makedirs(out_dir, exist_ok=True)
    name_holder = [None, 0]
    state = [b""]
    for raw in open(script_path):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        verb, _, rest = line.partition(" ")
        if verb == "msg":
            port.write(b">" + rest.encode() + b"\n")
            port.flush()
            drain(port, 0.5, out_dir, name_holder, state)
        elif verb == "key":
            port.write(rest.encode())
            port.flush()
            drain(port, 0.5, out_dir, name_holder, state)
        elif verb == "wait":
            drain(port, float(rest), out_dir, name_holder, state)
        elif verb == "shot":
            # Ask for a repaint and give its frame this name. The paint the
            # message itself caused has already been and gone by now, so naming
            # "the next frame" would wait for one that never comes; `p` is the
            # key that makes one. It is the slow, clean refresh, which is also
            # the one worth photographing.
            name_holder[0] = rest
            port.write(b"p")
            port.flush()
            drain(port, 5, out_dir, name_holder, state)
        else:
            print("unknown line:", line)
    drain(port, 2, out_dir, name_holder, state)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["watch", "key", "frames", "drive"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--seconds", type=float, default=8)
    ap.add_argument("--reset", action="store_true", help="restart the device first")
    ap.add_argument("--out", default="frames", help="where `drive` saves pictures")
    args = ap.parse_args()

    port = serial.Serial(PORT, 115200, timeout=0.2)
    if args.reset:
        # DTR and RTS drive the chip's reset line. The USB port belongs to the
        # chip itself on an ESP32-S3, so the reset takes the port away with it:
        # close the handle, wait for the device to come back, and open a new
        # one. Reusing the old handle reads nothing and reports no error.
        port.setDTR(False)
        port.setRTS(True)
        time.sleep(0.1)
        port.setRTS(False)
        port.close()
        for _ in range(60):
            time.sleep(0.5)
            try:
                port = serial.Serial(PORT, 115200, timeout=0.2)
                break
            except serial.SerialException:
                continue
        else:
            raise SystemExit("the device did not come back after the reset")
        time.sleep(1.5)
    port.reset_input_buffer()

    if args.action == "key":
        port.write(args.arg.encode())
        port.flush()
    elif args.action == "frames":
        os.makedirs(args.arg, exist_ok=True)
        port.write(b"f")
        port.flush()

    if args.action == "drive":
        drive(port, args.arg, args.out)
        return

    seconds = float(args.arg) if args.action == "watch" and args.arg else args.seconds
    end = time.time() + seconds
    saved = 0
    buf = b""
    while time.time() < end:
        buf += port.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            text = line.decode("utf-8", "replace").rstrip("\r")
            if text.startswith("COVEY-FRAME ") and args.action == "frames":
                parts = text.split(" ", 3)
                path = os.path.join(args.arg, "frame-%03d.png" % saved)
                frame_png(parts[3], int(parts[1]), int(parts[2]), path)
                print("saved", path, flush=True)
                saved += 1
            else:
                print(text, flush=True)
    port.close()


if __name__ == "__main__":
    main()
