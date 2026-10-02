/*
 * The covey device (#178).
 *
 * A thing with two buttons and a screen that talks to the covey app on a phone
 * over Bluetooth Low Energy. It holds no covey state: the phone sends the list
 * of threads and the words an agent said, and the device sends what somebody
 * said into it. Everything past the phone — the machine, the thread, the token
 * — is the app's business and the device never hears about it.
 *
 * The buttons:
 *
 *   talk (PWR)   hold to record, let go to send. A tap pages a long reply.
 *   menu (BOOT)  a tap walks to the next thread, a hold swaps menu and text.
 *
 * One task paints. A refresh is 300 milliseconds and the Bluetooth stack holds
 * locks while it calls back, so nothing paints from a radio callback: messages
 * are copied and queued, and the painting task takes them in its own time.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "adpcm.h"
#include "audio.h"
#include "ble.h"
#include "board.h"
#include "buttons.h"
#include "epaper.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "nvs_flash.h"
#include "proto.h"
#include "ui.h"

static const char *TAG = "covey";

typedef enum { EV_BUTTON, EV_MESSAGE, EV_LINK, EV_TICK } ev_kind_t;

typedef struct {
    ev_kind_t kind;
    button_event_t button;
    uint8_t type;
    uint8_t *body; /* heap, freed by the painting task */
    size_t len;
    bool connected;
} ev_t;

static QueueHandle_t s_events;

/*
 * The utterance that had nowhere to go (#184).
 *
 * A phone whose screen is locked is a phone the device cannot reach for a
 * second or two, and a reader does not know that when they press the button.
 * Losing what they said is the worst thing this device can do, so it is encoded
 * and kept here until the link is back. One, not a queue: a reader who speaks
 * twice into a device that is plainly not answering has said the same thing
 * twice, and the second is the one they would want.
 */
static uint8_t *s_held;
static size_t s_held_len;
static char s_name[24];
static uint8_t s_battery = 0xff;
static bool s_frame_dump = false;

/* ------------------------------------------------------------------ battery */

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;

static void battery_init(void)
{
    gpio_config_t cfg = {.mode = GPIO_MODE_OUTPUT, .pin_bit_mask = 1ULL << VBAT_PWR_PIN};
    ESP_ERROR_CHECK(gpio_config(&cfg));
    gpio_set_level(VBAT_PWR_PIN, 1); /* this rail is the divider, and is active high */

    adc_oneshot_unit_init_cfg_t unit = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&unit, &s_adc) != ESP_OK) return;
    adc_oneshot_chan_cfg_t chan = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    adc_oneshot_config_channel(s_adc, ADC_CHANNEL_3, &chan); /* GPIO4 */
    adc_cali_curve_fitting_config_t cali = {
        .unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    adc_cali_create_scheme_curve_fitting(&cali, &s_cali);
}

/*
 * Charge, as a percentage, or 0xff when there is nothing to measure.
 *
 * The cell is on a divider of one half, so the reading is doubled. A board
 * running on USB with no cell plugged in reads somewhere near zero, and a
 * reading outside what a lithium cell can be is reported as unknown rather than
 * as a flat battery — a device that says 0% while it is plainly running is
 * worse than one that says nothing.
 */
static uint8_t battery_percent(void)
{
    if (!s_adc || !s_cali) return 0xff;
    int raw = 0, mv = 0;
    if (adc_oneshot_read(s_adc, ADC_CHANNEL_3, &raw) != ESP_OK) return 0xff;
    if (adc_cali_raw_to_voltage(s_cali, raw, &mv) != ESP_OK) return 0xff;
    int cell = mv * 2;
    if (cell < 2500 || cell > 4500) return 0xff;
    if (cell >= 4200) return 100;
    if (cell <= 3300) return 0;
    return (uint8_t)((cell - 3300) * 100 / 900);
}

/* --------------------------------------------------------------- the radio */

static void on_message(uint8_t type, const uint8_t *body, size_t len)
{
    ev_t ev = {.kind = EV_MESSAGE, .type = type, .len = len};
    ev.body = len ? malloc(len) : NULL;
    if (len && !ev.body) return;
    if (len) memcpy(ev.body, body, len);
    if (xQueueSend(s_events, &ev, 0) != pdTRUE) free(ev.body);
}

static void on_link(bool connected)
{
    ev_t ev = {.kind = EV_LINK, .connected = connected};
    xQueueSend(s_events, &ev, 0);
}

static void send_hello(void)
{
    uint8_t body[64];
    size_t n = proto_write_hello(body, sizeof(body), s_name);
    ble_send(UP_HELLO, body, n);
}

static void send_status(void)
{
    uint8_t body[16];
    size_t n = proto_write_status(body, s_battery, (uint32_t)(esp_timer_get_time() / 1000),
                                  (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    ble_send(UP_STATUS, body, n);
}

static void send_select(void)
{
    uint8_t body[8];
    size_t n = proto_write_select(body, ui_generation(), (uint16_t)ui_cursor());
    ble_send(UP_SELECT, body, n);
}

/*
 * Encode the recording and put it on the air.
 *
 * The header and the audio go as one message, so the buffer is allocated with
 * the header's sixteen bytes in front of the blocks and the encoder writes past
 * them. Copying a hundred kilobytes to glue on a header would be the largest
 * allocation this firmware makes, twice.
 */
/** Send what is held, if anything. Keeps it when it still cannot go. */
static bool send_held(void)
{
    if (!s_held || !ble_ready()) return false;
    ESP_LOGI(TAG, "sending the utterance that was waiting, %u bytes", (unsigned)s_held_len);
    bool ok = ble_send(UP_AUDIO, s_held, s_held_len);
    if (ok) {
        free(s_held);
        s_held = NULL;
        s_held_len = 0;
    }
    return ok;
}

/**
 * Encode what was recorded and send it, or keep it until the link is back.
 *
 * Answers whether it went. The caller says which of the two happened on the
 * screen, because "held" and "sent" are different things to a reader waiting
 * for an answer.
 */
static bool send_recording(bool *held)
{
    *held = false;
    size_t count = 0;
    const int16_t *pcm = audio_samples(&count);
    if (count == 0) return false;

    size_t blocks = adpcm_block_count(count);
    size_t total = 16 + blocks * ADPCM_BLOCK_BYTES;
    uint8_t *body = heap_caps_malloc(total, MALLOC_CAP_SPIRAM);
    if (!body) {
        ESP_LOGE(TAG, "no room to encode %u samples", (unsigned)count);
        return false;
    }

    adpcm_state_t st;
    adpcm_reset(&st);
    adpcm_encode(&st, pcm, count, body + 16);
    proto_write_audio_header(body, audio_duration_ms(), (uint32_t)count);

    ESP_LOGI(TAG, "%u ms, %u samples, %u bytes, peak %.2f", (unsigned)audio_duration_ms(),
             (unsigned)count, (unsigned)total, audio_peak());

    if (ble_ready() && ble_send(UP_AUDIO, body, total)) {
        free(body);
        return true;
    }

    /* Nowhere to send it. Keep it rather than lose what somebody said. */
    free(s_held);
    s_held = body;
    s_held_len = total;
    *held = true;
    ESP_LOGW(TAG, "no phone; holding %u bytes until the link is back", (unsigned)total);
    return false;
}

/* ------------------------------------------------------------ the console */

/*
 * A few single-key commands over the USB port, for working on the device.
 *
 * `f` turns the frame dump on and off: every paint is then written to the
 * console as base64, which is how the pictures in the pull request were made —
 * they are the device's own buffer rather than a photograph of it. `t` runs the
 * encoder against a fixed tone and prints the bytes, which is what
 * `packages/client/src/device.test.ts` decodes to prove the C and the
 * TypeScript agree. Neither costs anything when nobody types.
 */
static void selftest_adpcm(void)
{
    /* A tone no floating point is needed for, so both sides can make it. */
    static const size_t N = 1600;
    int16_t *pcm = malloc(N * sizeof(int16_t));
    if (!pcm) return;
    for (size_t i = 0; i < N; i++) {
        /* A triangle wave of period 40 samples, peaking at 12000. */
        size_t phase = i % 40;
        int v = phase < 20 ? (int)phase : (int)(40 - phase);
        pcm[i] = (int16_t)((v - 10) * 1200);
    }
    size_t blocks = adpcm_block_count(N);
    uint8_t *out = malloc(blocks * ADPCM_BLOCK_BYTES);
    if (!out) {
        free(pcm);
        return;
    }
    adpcm_state_t st;
    adpcm_reset(&st);
    size_t n = adpcm_encode(&st, pcm, N, out);

    size_t b64_len = 0;
    size_t cap = n * 2 + 8;
    unsigned char *b64 = malloc(cap);
    if (b64 && mbedtls_base64_encode(b64, cap, &b64_len, out, n) == 0)
        printf("COVEY-SELFTEST-ADPCM %u %u %.*s\n", (unsigned)N, (unsigned)n, (int)b64_len, b64);
    free(b64);
    free(out);
    free(pcm);
}

static void dump_frame(void)
{
    int len = 0;
    const uint8_t *buf = epaper_buffer(&len);
    size_t cap = (size_t)len * 2 + 8;
    unsigned char *b64 = malloc(cap);
    size_t b64_len = 0;
    if (b64 && mbedtls_base64_encode(b64, cap, &b64_len, buf, (size_t)len) == 0)
        printf("COVEY-FRAME %d %d %.*s\n", EPD_WIDTH, EPD_HEIGHT, (int)b64_len, b64);
    free(b64);
}

/*
 * Record for two seconds and say what the microphone heard.
 *
 * The only way to know an ES8311 is wired the way the board file says is to
 * read it, and nobody can hold a button down over a serial port. The peak and
 * the mean tell a microphone that is working from one that answers with a flat
 * line, which is what a wrong I2S pin gives: the codec opens, the reads
 * succeed, and every sample is zero.
 */
static void selftest_mic(void)
{
    if (!audio_record_start()) {
        printf("COVEY-MIC busy\n");
        return;
    }
    vTaskDelay(pdMS_TO_TICKS(2000));
    audio_record_stop();

    size_t count = 0;
    const int16_t *pcm = audio_samples(&count);
    int64_t sum = 0;
    int zero = 0;
    for (size_t i = 0; i < count; i++) {
        sum += (int64_t)pcm[i] * pcm[i];
        if (pcm[i] == 0) zero++;
    }
    double rms = count ? sqrt((double)sum / (double)count) : 0;
    printf("COVEY-MIC samples=%u ms=%u peak=%.4f rms=%.1f zeros=%d%%\n", (unsigned)count,
           (unsigned)audio_duration_ms(), audio_peak(), rms,
           count ? (int)(100L * zero / (long)count) : 100);
}

/*
 * The keys this console takes.
 *
 * Nothing here is for a reader: it is how the device is worked on when it is on
 * a bench with a cable and nobody's hands are on it. `1` to `4` put a button
 * event on the same queue the real buttons use, which is what made the pictures
 * in the pull request and what proves a screen without somebody pressing it.
 */
static void inject(button_event_kind_t kind, uint32_t held)
{
    ev_t ev = {.kind = EV_BUTTON, .button = {.kind = kind, .held_ms = held}};
    xQueueSend(s_events, &ev, 0);
}

/*
 * Take one downlink message over the serial port instead of over the radio.
 *
 * A line of `>` and then base64 of a whole message — the type byte and then the
 * body — goes to the same handler a notification would. This is not a test
 * fixture living in the firmware: it is the real protocol over a second
 * transport, so the device can be worked on with no phone in the room, and the
 * bytes are the ones `writeThreads` and `writeText` produce in
 * `packages/client/src/device.ts`. It is also how the pictures of the menu in
 * the pull request were made.
 */
static void console_message(void)
{
    static char line[4096];
    size_t n = 0;
    for (;;) {
        int c = getchar();
        if (c == EOF) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (c == '\n' || c == '\r') break;
        if (n + 1 < sizeof(line)) line[n++] = (char)c;
    }
    line[n] = 0;

    size_t raw_len = 0;
    unsigned char *raw = malloc(n);
    if (!raw) return;
    if (mbedtls_base64_decode(raw, n, &raw_len, (const unsigned char *)line, n) != 0 ||
        raw_len < 1) {
        printf("COVEY-MESSAGE bad\n");
        free(raw);
        return;
    }
    printf("COVEY-MESSAGE type=%u len=%u\n", raw[0], (unsigned)(raw_len - 1));
    /*
     * Something is talking to the device, so the bar must not say "no phone".
     * The serial port is a second transport for the same protocol rather than a
     * pretence of one: a peer that sends a thread list is a peer, and the
     * status the next message carries would otherwise never be shown.
     */
    static bool said = false;
    if (!ble_connected() && !said) {
        said = true;
        on_link(true);
    }
    on_message(raw[0], raw + 1, raw_len - 1);
    free(raw);
}

static void console_task(void *arg)
{
    (void)arg;
    for (;;) {
        int c = getchar();
        if (c == EOF) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        switch (c) {
        case '>': console_message(); break;
        case 't': selftest_adpcm(); break;
        case 'm': selftest_mic(); break;
        /* On and off, rather than one key that toggles: a script that cannot
         * see the screen must be able to say which state it wants. */
        case 'f':
            s_frame_dump = true;
            printf("COVEY-FRAME-DUMP on\n");
            dump_frame();
            break;
        case 'F':
            s_frame_dump = false;
            printf("COVEY-FRAME-DUMP off\n");
            break;
        case 'p': {
            ev_t ev = {.kind = EV_TICK};
            xQueueSend(s_events, &ev, 0);
            break;
        }
        case '1': inject(BTN_MENU_TAP, 100); break;
        case '2': inject(BTN_MENU_HOLD, BUTTON_HOLD_MS); break;
        case '3': inject(BTN_TALK_DOWN, 0); break;
        case '4': inject(BTN_TALK_UP, 2000); break;  /* a held press: send */
        case '5': inject(BTN_TALK_UP, 50); break;    /* a tap: page a long reply */
        default: break;
        }
    }
}

/* ------------------------------------------------------------ the one task */

static void paint(bool partial)
{
    ui_paint(partial);
    if (s_frame_dump) dump_frame();
}

static void handle_message(const ev_t *ev)
{
    switch (ev->type) {
    case DOWN_THREADS: {
        proto_menu_t menu;
        if (proto_read_threads(ev->body, ev->len, &menu)) {
            ui_set_menu(&menu);
            paint(true);
            send_select();
        }
        break;
    }
    case DOWN_TEXT: {
        uint8_t kind;
        static char text[PROTO_MAX_TEXT + 1];
        if (proto_read_text(ev->body, ev->len, &kind, text, sizeof(text))) {
            ui_set_text(kind, text);
            paint(true);
        }
        break;
    }
    case DOWN_STATE:
        if (ev->len >= 1) {
            ui_set_state(ev->body[0]);
            paint(true);
        }
        break;
    case DOWN_ACK: {
        bool ok = false;
        static char text[260];
        if (proto_read_ack(ev->body, ev->len, &ok, text, sizeof(text))) {
            if (!ok) {
                ui_set_text(TEXT_NOTICE, text);
                paint(true);
            }
        }
        break;
    }
    default:
        ESP_LOGW(TAG, "a message of kind %u, which this firmware does not know", ev->type);
        break;
    }
}

static void handle_button(const button_event_t *b)
{
    switch (b->kind) {
    case BTN_MENU_TAP:
        ui_cursor_next();
        paint(true);
        send_select();
        break;

    case BTN_MENU_HOLD:
        ui_toggle_view();
        paint(true);
        break;

    case BTN_TALK_DOWN:
        /*
         * Record whether or not the phone is there.
         *
         * It may be a locked screen that is one second from waking, and the
         * reader has already started talking. What cannot be recovered is the
         * sentence; the link usually can.
         */
        /*
         * Recording starts here and not when the press turns out to be long.
         * A reader begins talking as they press, and the first syllable is what
         * the recogniser needs most. A press too short to mean it is thrown
         * away below.
         */
        if (audio_record_start()) {
            ui_set_recording(true, 0);
            paint(true);
        }
        break;

    case BTN_TALK_UP: {
        if (!audio_recording() && b->held_ms < BUTTON_TAP_MS) {
            /* A tap with no recording under way: page a long reply. */
            if (ui_view() == VIEW_TEXT) {
                ui_page();
                paint(true);
            }
            break;
        }
        audio_record_stop();
        ui_set_recording(false, 0);

        if (b->held_ms < BUTTON_TAP_MS) {
            /* Too short to be a question. Page instead, and send nothing. */
            if (ui_view() == VIEW_TEXT) ui_page();
            paint(true);
            break;
        }

        ui_set_state(STATE_HEARING);
        paint(true);
        bool held = false;
        if (!send_recording(&held)) {
            ui_set_text(TEXT_NOTICE, held
                ? "Saved. It goes to covey when your phone is back."
                : "The recording did not reach the phone.");
            ui_set_state(held ? STATE_AWAY : STATE_IDLE);
            paint(true);
        }
        break;
    }
    }
}

static void ui_task(void *arg)
{
    (void)arg;
    ev_t ev;
    uint32_t last_status = 0;

    for (;;) {
        if (xQueueReceive(s_events, &ev, pdMS_TO_TICKS(1000)) == pdTRUE) {
            switch (ev.kind) {
            case EV_BUTTON:
                handle_button(&ev.button);
                break;
            case EV_MESSAGE:
                handle_message(&ev);
                free(ev.body);
                break;
            case EV_LINK:
                ui_set_link(ev.connected);
                if (ev.connected) {
                    ui_set_text(TEXT_NOTICE, s_held
                        ? "Connected. Sending what you said."
                        : "Connected. Pick a thread and hold talk.");
                } else {
                    ui_set_state(STATE_IDLE);
                }
                paint(true);
                break;
            case EV_TICK:
                paint(false);
                break;
            }
        }

        /* Say how the device is every half minute, and only while anybody listens. */
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        /*
         * The link is up and something is waiting. This is the sweep rather
         * than the connect event because a phone is connected a moment before
         * it subscribes, and a send before that goes nowhere.
         */
        if (s_held && ble_ready() && send_held()) {
            ui_set_state(STATE_BUSY);
            ui_set_text(TEXT_HEARD, "Sent what you said while the phone was away.");
            paint(true);
        }

        if (ble_ready() && now - last_status > 30000) {
            last_status = now;
            s_battery = battery_percent();
            ui_set_battery(s_battery);
            send_hello();
            send_status();
        }
    }
}

static void button_task(void *arg)
{
    (void)arg;
    button_event_t b;
    for (;;)
        if (buttons_next(&b, 1000)) {
            ev_t ev = {.kind = EV_BUTTON, .button = b};
            xQueueSend(s_events, &ev, 0);
        }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    /* The name carries the last three bytes of the radio's address, so two
     * devices in one room are told apart without anybody naming them. */
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_name, sizeof(s_name), "covey-%02x%02x%02x", mac[3], mac[4], mac[5]);
    ESP_LOGI(TAG, "%s, firmware %d.%d.%d", s_name, FIRMWARE_MAJOR, FIRMWARE_MINOR, FIRMWARE_PATCH);

    s_events = xQueueCreate(8, sizeof(ev_t));

    epaper_init();
    ui_init();
    ui_paint(false);

    battery_init();
    s_battery = battery_percent();
    ui_set_battery(s_battery);

    buttons_init();
    if (!audio_init()) ESP_LOGE(TAG, "there is no microphone; the device can still show text");
    if (!ble_init(s_name, on_message, on_link)) ESP_LOGE(TAG, "there is no radio");

    xTaskCreate(ui_task, "ui", 8192, NULL, 5, NULL);
    xTaskCreate(button_task, "button", 3072, NULL, 5, NULL);
    xTaskCreate(console_task, "console", 4096, NULL, 2, NULL);
}
