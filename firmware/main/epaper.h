/*
 * The 1.54 inch e-paper screen, 200 by 200, over SPI (#178).
 *
 * The firmware draws into one frame buffer in internal memory — 200 by 200 at
 * one bit a pixel is 5000 bytes — and pushes the whole thing when it wants the
 * screen to change. There is no partial drawing into the panel's memory,
 * because the panel's memory is write only and the cost of a push is the same
 * whether one pixel moved or all of them.
 *
 * **A refresh is slow, and there are two of them.** A full refresh takes about
 * two seconds and flashes the panel black and white to clear it. A partial
 * refresh takes about 0.3 seconds and does not flash, but it leaves a faint
 * trace of what was there before, and the traces build up. So covey paints
 * partially while a reader walks the menu, and takes the full two seconds every
 * `EPAPER_FULL_EVERY` partial refreshes to wipe the traces away. That number is
 * the whole feel of the device: too low and the screen flashes while somebody
 * scrolls, too high and the text greys out.
 *
 * A colour here is ink, not light. `EPAPER_BLACK` is a pixel the reader sees.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define EPAPER_WHITE 0
#define EPAPER_BLACK 1

/* Partial refreshes between one full one. Measured by eye on this panel. */
#define EPAPER_FULL_EVERY 8

/* Bring the panel up. Switches its rail on and leaves the buffer white. */
void epaper_init(void);

/* Make every pixel white. Does not touch the panel until a flush. */
void epaper_clear(void);

/* One pixel. Anything off the screen is dropped rather than wrapped. */
void epaper_pixel(int x, int y, int colour);

/* A filled rectangle, used for the bars and for the menu cursor. */
void epaper_fill(int x, int y, int w, int h, int colour);

/* A one pixel outline. */
void epaper_rect(int x, int y, int w, int h, int colour);

/*
 * Put the buffer on the panel.
 *
 * `allow_partial` false asks for the slow, clean refresh. Pass false when the
 * whole screen changed and true while a reader is moving through a list; the
 * driver takes a full refresh anyway every `EPAPER_FULL_EVERY` times.
 */
void epaper_flush(bool allow_partial);

/* Put the panel to sleep. It keeps showing what it last drew, at no current. */
void epaper_sleep(void);

/* The raw buffer, for the test that dumps a frame over the serial port. */
const uint8_t *epaper_buffer(int *len);
