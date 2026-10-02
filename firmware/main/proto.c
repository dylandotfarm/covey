#include "proto.h"

#include <string.h>

#include "adpcm.h"
#include "board.h"

/* The message id, so the phone can tell a lost fragment from a new message. */
static uint16_t s_next_id = 1;

bool proto_send(proto_send_fn send, void *ctx, uint8_t type, const uint8_t *body, size_t len,
                int payload)
{
    int room = payload - PROTO_HEADER;
    if (room < 1) room = 1;
    uint16_t id = s_next_id++;
    uint8_t frame[517];
    if (room > (int)sizeof(frame) - PROTO_HEADER) room = (int)sizeof(frame) - PROTO_HEADER;

    size_t at = 0;
    do {
        size_t take = len - at;
        if (take > (size_t)room) take = (size_t)room;
        frame[0] = type;
        frame[1] = (uint8_t)((at == 0 ? PROTO_FLAG_FIRST : 0) |
                             (at + take >= len ? PROTO_FLAG_LAST : 0));
        frame[2] = (uint8_t)(id & 0xff);
        frame[3] = (uint8_t)(id >> 8);
        if (take) memcpy(frame + PROTO_HEADER, body + at, take);
        if (!send(frame, (int)(PROTO_HEADER + take), ctx)) return false;
        at += take;
    } while (at < len);
    return true;
}

/* ------------------------------------------------------------- little ends */

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xff);
    p[1] = (uint8_t)(v >> 8);
}

static void put_u32(uint8_t *p, uint32_t v)
{
    put_u16(p, (uint16_t)(v & 0xffff));
    put_u16(p + 2, (uint16_t)(v >> 16));
}

static uint16_t get_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

/* ------------------------------------------------------------------ writes */

size_t proto_write_hello(uint8_t *out, size_t max, const char *name)
{
    size_t n = strlen(name);
    if (16 + n > max) n = max > 16 ? max - 16 : 0;
    out[0] = PROTO_VERSION;
    out[1] = FIRMWARE_MAJOR;
    out[2] = FIRMWARE_MINOR;
    out[3] = FIRMWARE_PATCH;
    put_u16(out + 4, EPD_WIDTH);
    put_u16(out + 6, EPD_HEIGHT);
    put_u32(out + 8, AUDIO_SAMPLE_RATE);
    put_u16(out + 12, ADPCM_BLOCK_BYTES);
    put_u16(out + 14, (uint16_t)n);
    memcpy(out + 16, name, n);
    return 16 + n;
}

size_t proto_write_select(uint8_t *out, uint16_t generation, uint16_t index)
{
    put_u16(out, generation);
    put_u16(out + 2, index);
    return 4;
}

size_t proto_write_status(uint8_t *out, uint8_t battery, uint32_t up_ms, uint32_t free_heap)
{
    out[0] = battery;
    put_u32(out + 1, up_ms);
    put_u32(out + 5, free_heap);
    return 9;
}

size_t proto_write_audio_header(uint8_t *out, uint32_t duration_ms, uint32_t samples)
{
    put_u32(out + 0, duration_ms);
    put_u32(out + 4, AUDIO_SAMPLE_RATE);
    put_u32(out + 8, samples);
    put_u16(out + 12, ADPCM_BLOCK_BYTES);
    put_u16(out + 14, 0); /* reserved, so the audio starts four-byte aligned */
    return 16;
}

/* ------------------------------------------------------------------- reads */

/* A length-prefixed string, copied out and terminated. */
static bool take_str(const uint8_t *body, size_t len, size_t *at, char *out, size_t max)
{
    if (*at + 2 > len) return false;
    uint16_t n = get_u16(body + *at);
    *at += 2;
    if (*at + n > len) return false;
    size_t take = n < max - 1 ? n : max - 1;
    memcpy(out, body + *at, take);
    out[take] = 0;
    *at += n;
    return true;
}

bool proto_read_threads(const uint8_t *body, size_t len, proto_menu_t *menu)
{
    if (len < 4) return false;
    size_t at = 0;
    uint16_t generation = get_u16(body);
    uint16_t count = get_u16(body + 2);
    at = 4;
    if (count > PROTO_MAX_THREADS) count = PROTO_MAX_THREADS;

    proto_menu_t next = {.generation = generation, .count = 0};
    for (uint16_t i = 0; i < count; i++) {
        if (at >= len) return false;
        bool busy = body[at++] == 1;
        if (!take_str(body, len, &at, next.threads[i].title, sizeof(next.threads[i].title)))
            return false;
        next.threads[i].busy = busy;
        next.count++;
    }
    *menu = next;
    return true;
}

bool proto_read_text(const uint8_t *body, size_t len, uint8_t *kind, char *out, size_t max)
{
    if (len < 3) return false;
    size_t at = 1;
    *kind = body[0];
    return take_str(body, len, &at, out, max);
}

bool proto_read_ack(const uint8_t *body, size_t len, bool *ok, char *out, size_t max)
{
    if (len < 3) return false;
    size_t at = 1;
    *ok = body[0] == 1;
    return take_str(body, len, &at, out, max);
}

/* ---------------------------------------------------------- reassembly */

void proto_rx_reset(proto_rx_t *rx)
{
    rx->building = false;
    rx->held = 0;
    rx->type = 0;
    rx->id = 0;
}

bool proto_rx_push(proto_rx_t *rx, const uint8_t *frame, int len, uint8_t *type, size_t *out_len)
{
    if (len < PROTO_HEADER) {
        proto_rx_reset(rx);
        return false;
    }
    uint8_t t = frame[0];
    uint8_t flags = frame[1];
    uint16_t id = (uint16_t)(frame[2] | (frame[3] << 8));
    const uint8_t *body = frame + PROTO_HEADER;
    size_t n = (size_t)(len - PROTO_HEADER);

    if (flags & PROTO_FLAG_FIRST) {
        rx->building = true;
        rx->type = t;
        rx->id = id;
        rx->held = 0;
    } else if (!rx->building || id != rx->id || t != rx->type) {
        proto_rx_reset(rx);
        return false;
    }

    if (rx->held + n > sizeof(rx->buf)) {
        proto_rx_reset(rx);
        return false;
    }
    memcpy(rx->buf + rx->held, body, n);
    rx->held += n;

    if (!(flags & PROTO_FLAG_LAST)) return false;

    *type = rx->type;
    *out_len = rx->held;
    rx->building = false;
    rx->held = 0;
    return true;
}
