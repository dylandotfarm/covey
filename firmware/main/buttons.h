/*
 * The two buttons (#178).
 *
 * The device has two and the reader needs four things from them: walk the menu,
 * go back, record, and page through a long reply. So the menu button tells a
 * tap from a hold, and the talk button reports when it went down and how long
 * it was held — a hold is a recording and a tap is a page.
 *
 * Both are read on a 5 ms timer with a debounce of three reads, because a
 * mechanical button makes about a millisecond of noise on each edge and a
 * single bounce read as a second tap walks the menu two threads at a time.
 *
 * Events go on a queue rather than into a callback: the callback would run in
 * the timer's own task, and what a button does on this device is repaint a
 * screen, which takes 300 ms.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    BTN_MENU_TAP,   /* the menu button, pressed and let go inside the hold time */
    BTN_MENU_HOLD,  /* the menu button, held. Sent once, while it is still down */
    BTN_TALK_DOWN,  /* the talk button went down. Start recording now */
    BTN_TALK_UP,    /* the talk button came up. `held_ms` says how long it was */
} button_event_kind_t;

typedef struct {
    button_event_kind_t kind;
    uint32_t held_ms;
} button_event_t;

/* How long the menu button must be down to be a hold rather than a tap. */
#define BUTTON_HOLD_MS 600

/*
 * Under this, a press of the talk button is a tap and not a recording.
 *
 * Recording starts the moment the button goes down, because a reader starts
 * speaking then and half a word lost at the front is a sentence the recogniser
 * reads wrongly. A press shorter than this throws those samples away.
 */
#define BUTTON_TAP_MS 350

void buttons_init(void);

/* Wait up to `wait_ms` for an event. Answers false when none came. */
bool buttons_next(button_event_t *out, uint32_t wait_ms);
