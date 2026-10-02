#include "buttons.h"

#include <stdbool.h>

#include "board.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#define TICK_MS 5
#define DEBOUNCE 3

typedef struct {
    gpio_num_t pin;
    uint8_t steady;   /* the level the pin has held for DEBOUNCE reads */
    uint8_t agree;    /* how many reads in a row have disagreed with it */
    uint8_t last;
    uint32_t down_at; /* milliseconds since boot, when it went down */
    bool hold_sent;
} button_t;

static button_t s_menu = {.pin = BUTTON_MENU_PIN, .steady = 1, .last = 1};
static button_t s_talk = {.pin = BUTTON_TALK_PIN, .steady = 1, .last = 1};
static QueueHandle_t s_queue;
static esp_timer_handle_t s_timer;

static void push(button_event_kind_t kind, uint32_t held)
{
    button_event_t e = {.kind = kind, .held_ms = held};
    xQueueSendFromISR(s_queue, &e, NULL);
}

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

/* Answers true on the tick the pin settled on a new level. */
static bool settled(button_t *b, uint8_t *level)
{
    uint8_t raw = (uint8_t)gpio_get_level(b->pin);
    if (raw != b->last) {
        b->last = raw;
        b->agree = 0;
        return false;
    }
    if (raw == b->steady) return false;
    if (++b->agree < DEBOUNCE) return false;
    b->steady = raw;
    *level = raw;
    return true;
}

static void tick(void *arg)
{
    (void)arg;
    uint8_t level;

    /* Both buttons pull the pin to ground, so 0 is down. */
    if (settled(&s_menu, &level)) {
        if (level == 0) {
            s_menu.down_at = now_ms();
            s_menu.hold_sent = false;
        } else if (!s_menu.hold_sent) {
            push(BTN_MENU_TAP, now_ms() - s_menu.down_at);
        }
    } else if (s_menu.steady == 0 && !s_menu.hold_sent &&
               now_ms() - s_menu.down_at >= BUTTON_HOLD_MS) {
        /* Sent while the button is still down, so the reader feels the moment
         * it became a hold rather than finding out when they let go. */
        s_menu.hold_sent = true;
        push(BTN_MENU_HOLD, BUTTON_HOLD_MS);
    }

    if (settled(&s_talk, &level)) {
        if (level == 0) {
            s_talk.down_at = now_ms();
            push(BTN_TALK_DOWN, 0);
        } else {
            push(BTN_TALK_UP, now_ms() - s_talk.down_at);
        }
    }
}

void buttons_init(void)
{
    gpio_config_t cfg = {
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pin_bit_mask = (1ULL << BUTTON_MENU_PIN) | (1ULL << BUTTON_TALK_PIN),
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));

    s_queue = xQueueCreate(8, sizeof(button_event_t));
    esp_timer_create_args_t args = {.callback = tick, .name = "buttons"};
    ESP_ERROR_CHECK(esp_timer_create(&args, &s_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(s_timer, TICK_MS * 1000));
}

bool buttons_next(button_event_t *out, uint32_t wait_ms)
{
    return xQueueReceive(s_queue, out, pdMS_TO_TICKS(wait_ms)) == pdTRUE;
}
