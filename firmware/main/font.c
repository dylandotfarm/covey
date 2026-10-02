#include "font.h"

#include <string.h>

#include "epaper.h"
#include "font_data.h"

int font_width(font_face_t face) { return face == FONT_BODY ? FONT_BODY_W : FONT_SMALL_W; }
int font_height(font_face_t face) { return face == FONT_BODY ? FONT_BODY_H : FONT_SMALL_H; }

static const uint8_t *face_bits(font_face_t face)
{
    return face == FONT_BODY ? font_body_bits : font_small_bits;
}

/*
 * The character this face will draw for `c`.
 *
 * An agent writes em dashes, curly quotation marks and ellipses, and this font
 * holds printable ASCII alone. Rather than draw a box, fold the few marks that
 * have a plain spelling and drop the rest. The input is UTF-8, so a byte over
 * 0x7f is part of a character and never a character: `font_ascii` works on the
 * decoded value and `next_rune` is what decodes it.
 */
static char ascii_of(uint32_t rune)
{
    if (rune >= 32 && rune <= 126) return (char)rune;
    switch (rune) {
    case 0x2018: case 0x2019: case 0x02bc: return '\'';
    case 0x201c: case 0x201d: return '"';
    case 0x2013: case 0x2014: case 0x2212: return '-';
    case 0x2026: return '.'; /* an ellipsis, as one dot; three would re-wrap */
    case 0x00a0: case 0x2007: case 0x202f: return ' ';
    case 0x2022: case 0x00b7: return '*';
    default: return 0;
    }
}

/* Decode one UTF-8 character. Answers where the next one starts. */
static const char *next_rune(const char *s, uint32_t *out)
{
    uint8_t c = (uint8_t)*s;
    if (c < 0x80) {
        *out = c;
        return s + 1;
    }
    int extra = (c & 0xe0) == 0xc0 ? 1 : (c & 0xf0) == 0xe0 ? 2 : (c & 0xf8) == 0xf0 ? 3 : 0;
    if (extra == 0) {
        *out = 0xfffd;
        return s + 1;
    }
    uint32_t v = c & (0x3f >> extra);
    for (int i = 0; i < extra; i++) {
        if ((s[1 + i] & 0xc0) != 0x80) { /* a cut character: stop here */
            *out = 0xfffd;
            return s + 1;
        }
        v = (v << 6) | (uint32_t)(s[1 + i] & 0x3f);
    }
    *out = v;
    return s + 1 + extra;
}

static void draw_glyph(int x, int y, char c, font_face_t face, int colour)
{
    if (c < FONT_FIRST || c > FONT_LAST) return;
    const uint8_t *bits = face_bits(face) + (size_t)(c - FONT_FIRST) * (size_t)font_height(face);
    int w = font_width(face);
    int h = font_height(face);
    for (int row = 0; row < h; row++)
        for (int col = 0; col < w; col++)
            if (bits[row] & (0x80 >> col)) epaper_pixel(x + col, y + row, colour);
}

int font_text(int x, int y, const char *s, font_face_t face, int colour)
{
    int w = font_width(face);
    uint32_t rune;
    while (*s) {
        s = next_rune(s, &rune);
        char c = ascii_of(rune);
        if (!c) continue;
        draw_glyph(x, y, c, face, colour);
        x += w;
    }
    return x;
}

void font_text_elided(int x, int y, int max_px, const char *s, font_face_t face, int colour)
{
    int w = font_width(face);
    int room = max_px / w;
    if (room <= 0) return;

    /* Count what it would take, so the ellipsis only appears when it is true. */
    int need = 0;
    uint32_t rune;
    for (const char *p = s; *p;) {
        p = next_rune(p, &rune);
        if (ascii_of(rune)) need++;
    }
    if (need <= room) {
        font_text(x, y, s, face, colour);
        return;
    }

    int limit = room - 1;
    int drawn = 0;
    for (const char *p = s; *p && drawn < limit;) {
        p = next_rune(p, &rune);
        char c = ascii_of(rune);
        if (!c) continue;
        draw_glyph(x + drawn * w, y, c, face, colour);
        drawn++;
    }
    draw_glyph(x + drawn * w, y, '~', face, colour);
}

/*
 * Walk `s` one wrapped line at a time.
 *
 * `start` and `len` come back as the span of the source this line covers. The
 * caller draws it or counts it. Answers NULL at the end of the text.
 *
 * A newline in the text ends a line, because an agent writes lists.
 */
static const char *wrap_step(const char *s, int cols, const char **start, int *len)
{
    while (*s == ' ') s++; /* a wrapped line never opens on a space */
    if (!*s) return NULL;

    *start = s;
    const char *last_space = NULL;
    int used = 0;
    const char *p = s;
    uint32_t rune;

    while (*p) {
        if (*p == '\n') {
            *len = (int)(p - *start);
            return p + 1;
        }
        const char *after = next_rune(p, &rune);
        char c = ascii_of(rune);
        if (c == ' ') last_space = p;
        if (c && used == cols) {
            /* Full. Go back to the last space, or cut the word if there is none. */
            if (last_space && last_space > *start) {
                *len = (int)(last_space - *start);
                return last_space + 1;
            }
            *len = (int)(p - *start);
            return p;
        }
        if (c) used++;
        p = after;
    }
    *len = (int)(p - *start);
    return p;
}

int font_wrap_lines(const char *s, font_face_t face, int width_px)
{
    int cols = width_px / font_width(face);
    if (cols <= 0 || !s) return 0;
    int lines = 0;
    const char *start;
    int len;
    while ((s = wrap_step(s, cols, &start, &len)) != NULL) lines++;
    return lines;
}

int font_wrap(int x, int y, int width_px, const char *s, font_face_t face, int colour,
              int from_line, int max_lines)
{
    int cols = width_px / font_width(face);
    if (cols <= 0 || !s) return 0;
    int h = font_height(face);
    int w = font_width(face);
    int line = 0;
    int drawn = 0;
    const char *start;
    int len;

    while (drawn < max_lines && (s = wrap_step(s, cols, &start, &len)) != NULL) {
        if (line++ < from_line) continue;
        int at = x;
        const char *p = start;
        uint32_t rune;
        while (p < start + len) {
            p = next_rune(p, &rune);
            char c = ascii_of(rune);
            if (!c) continue;
            draw_glyph(at, y + drawn * h, c, face, colour);
            at += w;
        }
        drawn++;
    }
    return drawn;
}
