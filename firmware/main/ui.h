/*
 * What the screen says (#178).
 *
 * Two views and one status bar. The menu is the list of threads the phone sent;
 * the text view is the last thing that happened in the thread the cursor is on.
 * The talk button records against whichever thread the cursor is on, in either
 * view, so a reader never has to open anything to speak to it.
 *
 * Every paint is 300 ms of e-paper and the reader is waiting through it, so the
 * rule here is one paint per thing that happened. Nothing animates: a level
 * meter at three frames a second would make the device feel slower than it is,
 * and the one moment that matters — the device heard you — is said in words.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "proto.h"

typedef enum {
    VIEW_MENU = 0,
    VIEW_TEXT = 1,
} ui_view_t;

void ui_init(void);

/*
 * The menu the phone sent. Keeps the cursor on the same thread where it can.
 *
 * The *first* list a device is sent turns the screen to the menu, because that
 * is the moment the device became useful and the reader is looking at a notice
 * telling them to pick a thread. A later list does not: by then the reader may
 * be halfway through a reply, and a list arrives every time anybody's thread
 * anywhere changes.
 */
void ui_set_menu(const proto_menu_t *menu);

/* Move the cursor on by one, wrapping at the end. Answers the new index. */
int ui_cursor_next(void);

int ui_cursor(void);
uint16_t ui_generation(void);

/* The thread the cursor is on, or "" when the menu is empty. */
const char *ui_current_title(void);

void ui_set_text(uint8_t kind, const char *text);
void ui_set_state(uint8_t state);
void ui_set_link(bool connected);
void ui_set_battery(uint8_t percent);

/* Say the device is recording, and for how long. Painted without the radio. */
void ui_set_recording(bool on, uint32_t seconds);

/* Swap between the menu and the text of the thread the cursor is on. */
void ui_toggle_view(void);
ui_view_t ui_view(void);

/* Page down through a reply too long for one screen. Wraps to the top. */
void ui_page(void);

/* Draw the current view and push it. `partial` asks for the fast refresh. */
void ui_paint(bool partial);
