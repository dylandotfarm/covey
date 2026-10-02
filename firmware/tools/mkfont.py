#!/usr/bin/env python3
"""
Make the two bitmap fonts the device paints with.

The screen is 200 by 200 and the firmware has no font engine, so the glyphs are
baked into the image as bitmaps. They come from DejaVu Sans Mono, rendered here
rather than drawn by hand: a hand-drawn font is a page of hexadecimal nobody can
check, and this script can be run again when a size turns out to be wrong.

Two sizes, both monospaced, both at most 8 pixels wide so one row is one byte:

  small  6 x 12   33 columns, 16 rows   the menu and the status bar
  body   8 x 16   25 columns, 12 rows   what the agent said

A row is one byte with the leftmost pixel in the high bit, which is the order
the e-paper itself takes, so `epaper_text` writes a row without shifting it.

Run: python3 tools/mkfont.py   (writes main/font_data.c and main/font_data.h)
"""
from PIL import Image, ImageDraw, ImageFont
import os

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FIRST, LAST = 32, 126           # printable ASCII; the device cuts anything else

# (name, width, height, point size, baseline from the top, font file)
FACES = [
    ("small", 6, 12, 11, 9, FONT),
    ("body",  8, 16, 15, 12, BOLD),
]

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def glyphs(width, height, size, baseline, path):
    face = ImageFont.truetype(path, size)
    rows = []
    for code in range(FIRST, LAST + 1):
        img = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(img)
        # `anchor="ls"` puts the pen on the baseline at the left edge, which is
        # the only way every glyph of a monospaced face lines up with the next.
        draw.text((0, baseline), chr(code), font=face, fill=255, anchor="ls")
        for y in range(height):
            bits = 0
            for x in range(width):
                # Over half lit is a black pixel. The screen has two colours.
                if img.getpixel((x, y)) >= 128:
                    bits |= 0x80 >> x
            rows.append(bits)
    return rows


def main():
    c = ['/* Written by tools/mkfont.py. Do not edit: run the script again. */',
         '#include "font_data.h"', '']
    h = ['/* Written by tools/mkfont.py. Do not edit: run the script again. */',
         '#pragma once', '#include <stdint.h>', '',
         f'#define FONT_FIRST {FIRST}', f'#define FONT_LAST  {LAST}', '']
    for name, w, hgt, size, base, path in FACES:
        rows = glyphs(w, hgt, size, base, path)
        c.append(f'/* {name}: {w}x{hgt}, ASCII {FIRST}..{LAST}, one byte a row. */')
        c.append(f'const uint8_t font_{name}_bits[{len(rows)}] = {{')
        for i in range(0, len(rows), 12):
            c.append('    ' + ' '.join(f'0x{b:02x},' for b in rows[i:i + 12]))
        c.append('};')
        c.append('')
        h.append(f'#define FONT_{name.upper()}_W {w}')
        h.append(f'#define FONT_{name.upper()}_H {hgt}')
        h.append(f'extern const uint8_t font_{name}_bits[{len(rows)}];')
        h.append('')
    open(os.path.join(HERE, "main", "font_data.c"), "w").write("\n".join(c) + "\n")
    open(os.path.join(HERE, "main", "font_data.h"), "w").write("\n".join(h) + "\n")
    print("wrote main/font_data.c and main/font_data.h")


if __name__ == "__main__":
    main()
