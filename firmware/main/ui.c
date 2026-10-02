#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "board.h"
#include "epaper.h"
#include "font.h"

/* The three bands of the screen. */
#define BAR_H 14
#define HINT_Y (EPD_HEIGHT - 15)
#define BODY_Y (BAR_H + 4)
#define BODY_H (HINT_Y - BODY_Y - 3)
#define PAD 3

#define MENU_ROW_H 15
#define MENU_ROWS (BODY_H / MENU_ROW_H)

static struct {
    proto_menu_t menu;
    int cursor;
    ui_view_t view;
    uint8_t state;
    bool link;
    uint8_t battery;
    bool recording;
    uint32_t rec_seconds;
    int page;
    uint8_t text_kind;
    char text[PROTO_MAX_TEXT + 1];
} s;

void ui_init(void)
{
    memset(&s, 0, sizeof(s));
    s.battery = 0xff;
    s.view = VIEW_MENU;
    snprintf(s.text, sizeof(s.text), "Open covey on your phone and connect to this device.");
}

void ui_set_menu(const proto_menu_t *menu)
{
    /*
     * Keep the cursor on the thread it was on.
     *
     * The phone re-sends the whole list whenever anything in it changes, and a
     * title moves up the list as soon as somebody else's thread gets a message.
     * A cursor kept by position would walk under the reader's hand, so it is
     * kept by title and only falls back to a position when the title is gone.
     */
    char was[PROTO_MAX_TITLE + 1] = "";
    if (s.cursor < s.menu.count) snprintf(was, sizeof(was), "%s", s.menu.threads[s.cursor].title);

    /* The first list is the device becoming useful: show it. */
    if (s.menu.count == 0 && menu->count > 0) s.view = VIEW_MENU;

    s.menu = *menu;
    s.cursor = 0;
    if (was[0]) {
        for (int i = 0; i < s.menu.count; i++)
            if (strcmp(s.menu.threads[i].title, was) == 0) {
                s.cursor = i;
                break;
            }
    }
}

int ui_cursor_next(void)
{
    if (s.menu.count == 0) return 0;
    s.cursor = (s.cursor + 1) % s.menu.count;
    s.page = 0;
    return s.cursor;
}

int ui_cursor(void) { return s.cursor; }
uint16_t ui_generation(void) { return s.menu.generation; }

const char *ui_current_title(void)
{
    return s.cursor < s.menu.count ? s.menu.threads[s.cursor].title : "";
}

void ui_set_text(uint8_t kind, const char *text)
{
    s.text_kind = kind;
    s.page = 0;
    snprintf(s.text, sizeof(s.text), "%s", text);
    /*
     * Everything but a thread's name turns the screen to it.
     *
     * A reply is what the reader is waiting for. A notice is why they are not
     * going to get one. And the words covey heard are the answer to the only
     * question a reader has just after speaking — did it understand me — so a
     * transcript that arrived while the menu was up would be the one thing
     * worth seeing and the one thing not shown.
     */
    if (kind != TEXT_THREAD) s.view = VIEW_TEXT;
}

void ui_set_state(uint8_t state) { s.state = state; }
void ui_set_link(bool connected) { s.link = connected; }
void ui_set_battery(uint8_t percent) { s.battery = percent; }

void ui_set_recording(bool on, uint32_t seconds)
{
    s.recording = on;
    s.rec_seconds = seconds;
}

void ui_toggle_view(void)
{
    s.view = s.view == VIEW_MENU ? VIEW_TEXT : VIEW_MENU;
    s.page = 0;
}

ui_view_t ui_view(void) { return s.view; }

void ui_page(void)
{
    int lines = font_wrap_lines(s.text, FONT_BODY, EPD_WIDTH - PAD * 2);
    int per = (BODY_H - font_height(FONT_SMALL) - 2) / font_height(FONT_BODY);
    if (per < 1) per = 1;
    s.page = (s.page + 1) * per < lines ? s.page + 1 : 0;
}

/* ------------------------------------------------------------------ paint */

static void draw_bar(void)
{
    epaper_fill(0, 0, EPD_WIDTH, BAR_H, EPAPER_BLACK);

    const char *left = "covey";
    if (!s.link) left = "no phone";
    else if (s.recording) left = "listening";
    else if (s.state == STATE_HEARING) left = "hearing";
    else if (s.state == STATE_BUSY) left = "working";
    else if (s.state == STATE_AWAY) left = "away";
    font_text(PAD, 1, left, FONT_SMALL, EPAPER_WHITE);

    char right[16] = "";
    if (s.battery != 0xff) snprintf(right, sizeof(right), "%u%%", s.battery);
    if (right[0]) {
        int w = (int)strlen(right) * font_width(FONT_SMALL);
        font_text(EPD_WIDTH - PAD - w, 1, right, FONT_SMALL, EPAPER_WHITE);
    }
}

static void draw_hint(const char *a, const char *b)
{
    epaper_fill(0, HINT_Y - 2, EPD_WIDTH, 2, EPAPER_BLACK);
    font_text(PAD, HINT_Y + 1, a, FONT_SMALL, EPAPER_BLACK);
    if (b) {
        int w = (int)strlen(b) * font_width(FONT_SMALL);
        font_text(EPD_WIDTH - PAD - w, HINT_Y + 1, b, FONT_SMALL, EPAPER_BLACK);
    }
}

static void draw_menu(void)
{
    if (s.menu.count == 0) {
        font_wrap(PAD, BODY_Y + 6, EPD_WIDTH - PAD * 2,
                  s.link ? "No threads yet. Start one in the covey app."
                         : "Waiting for the phone.",
                  FONT_SMALL, EPAPER_BLACK, 0, 6);
        draw_hint("", NULL);
        return;
    }

    /*
     * Window the list around the cursor.
     *
     * The screen holds ten rows and a fleet holds more, so the list scrolls
     * only when the cursor would leave it. A list that re-centres on every step
     * makes every row move under the reader on every press.
     */
    int first = 0;
    if (s.menu.count > MENU_ROWS) {
        first = s.cursor - MENU_ROWS / 2;
        if (first < 0) first = 0;
        if (first > s.menu.count - MENU_ROWS) first = s.menu.count - MENU_ROWS;
    }

    for (int row = 0; row < MENU_ROWS && first + row < s.menu.count; row++) {
        int i = first + row;
        int y = BODY_Y + row * MENU_ROW_H;
        bool on = i == s.cursor;
        if (on) epaper_fill(0, y - 1, EPD_WIDTH, MENU_ROW_H, EPAPER_BLACK);
        int ink = on ? EPAPER_WHITE : EPAPER_BLACK;

        int x = PAD;
        if (s.menu.threads[i].busy) {
            font_text(x, y + 1, "*", FONT_SMALL, ink);
        }
        x += font_width(FONT_SMALL) + 1;
        font_text_elided(x, y + 1, EPD_WIDTH - x - PAD, s.menu.threads[i].title, FONT_SMALL, ink);
    }

    char count[24];
    snprintf(count, sizeof(count), "%d of %d", s.cursor + 1, s.menu.count);
    draw_hint("hold talk to speak", count);
}

static void draw_text(void)
{
    const char *lead = s.text_kind == TEXT_HEARD    ? "you said"
                       : s.text_kind == TEXT_NOTICE ? "notice"
                       : s.text_kind == TEXT_THREAD ? "thread"
                                                    : ui_current_title();
    font_text_elided(PAD, BODY_Y, EPD_WIDTH - PAD * 2, lead, FONT_SMALL, EPAPER_BLACK);
    int top = BODY_Y + font_height(FONT_SMALL) + 2;
    epaper_fill(PAD, top - 2, EPD_WIDTH - PAD * 2, 1, EPAPER_BLACK);

    int per = (HINT_Y - 4 - top) / font_height(FONT_BODY);
    if (per < 1) per = 1;
    int lines = font_wrap_lines(s.text, FONT_BODY, EPD_WIDTH - PAD * 2);
    font_wrap(PAD, top, EPD_WIDTH - PAD * 2, s.text, FONT_BODY, EPAPER_BLACK, s.page * per, per);

    if (lines > per) {
        char page[24];
        snprintf(page, sizeof(page), "%d/%d", s.page + 1, (lines + per - 1) / per);
        draw_hint("tap talk for more", page);
    } else {
        draw_hint("hold talk to speak", "menu: hold");
    }
}

static void draw_recording(void)
{
    /*
     * One screen while the reader speaks, and it does not animate.
     *
     * A refresh is 300 ms of the reader's time, so a meter at three frames a
     * second would make the device feel slower than it is and would say nothing
     * the word does not. The thread's name is here because the recording is
     * about to go to it, and that is the last moment to notice it is the wrong
     * one.
     */
    int y = BODY_Y + 16;
    font_text(PAD, y, "Listening", FONT_BODY, EPAPER_BLACK);
    y += font_height(FONT_BODY) + 10;
    epaper_fill(PAD, y, EPD_WIDTH - PAD * 2, 3, EPAPER_BLACK);
    y += 12;
    font_text_elided(PAD, y, EPD_WIDTH - PAD * 2, ui_current_title(), FONT_SMALL, EPAPER_BLACK);
    draw_hint("let go to send", NULL);
}

void ui_paint(bool partial)
{
    epaper_clear();
    draw_bar();
    if (s.recording) draw_recording();
    else if (s.view == VIEW_MENU) draw_menu();
    else draw_text();
    epaper_flush(partial);
}
