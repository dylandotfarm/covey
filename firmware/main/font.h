/*
 * Text on the e-paper (#178).
 *
 * Two monospaced faces, both baked by `tools/mkfont.py`. Monospaced on purpose:
 * the screen is 200 pixels wide and the firmware has to say how many characters
 * fit *before* it draws them, to wrap a reply and to cut a thread title. With a
 * proportional face that answer costs a pass over the glyph table every time.
 *
 * A face that cannot draw a character draws nothing for it rather than a box.
 * The text comes from an agent and carries em dashes and quotation marks, and a
 * line of boxes reads as a broken screen; a line with a space where the dash
 * was reads as the sentence it is. `font_ascii` is what the phone should have
 * done, and does it again here because the device must never depend on it.
 */
#pragma once

#include <stdint.h>

typedef enum {
    FONT_SMALL = 0, /* 6 by 12: 33 columns, the menu and the bars */
    FONT_BODY = 1,  /* 8 by 16: 25 columns, what the agent said */
} font_face_t;

int font_width(font_face_t face);
int font_height(font_face_t face);

/* One line, cut at the right edge of the screen. Answers the x it ended at. */
int font_text(int x, int y, const char *s, font_face_t face, int colour);

/* The same, but stop after `max_px` pixels and end with an ellipsis. */
void font_text_elided(int x, int y, int max_px, const char *s, font_face_t face, int colour);

/*
 * How many lines `s` takes when wrapped into `width_px`.
 *
 * Counted without drawing, so the caller can size a box or work out how many
 * pages a reply takes before it paints any of it.
 */
int font_wrap_lines(const char *s, font_face_t face, int width_px);

/*
 * Draw `s` wrapped into `width_px`, starting at wrapped line `from_line`.
 *
 * Draws at most `max_lines`. Wraps on a space where there is one and inside a
 * word where there is not, because a URL with no space in it must still appear
 * rather than run off the edge. Answers the number of lines it drew.
 */
int font_wrap(int x, int y, int width_px, const char *s, font_face_t face, int colour,
              int from_line, int max_lines);
