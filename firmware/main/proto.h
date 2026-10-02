/*
 * The wire, the device's half (#178).
 *
 * `packages/client/src/device.ts` is the other half and the one with the tests.
 * Every constant here has a twin there; change one and change both, or the
 * phone reads a thread list as an utterance.
 *
 * A message is cut into fragments with a four-byte header because an utterance
 * and a thread list are both longer than any maximum transmission unit a phone
 * will agree to. BLE keeps what it carries on one characteristic in order, so a
 * fragment says only whether it opens a message and whether it closes one.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PROTO_VERSION 1
#define PROTO_HEADER 4
#define PROTO_FLAG_FIRST 0x01
#define PROTO_FLAG_LAST 0x02

/* What the device sends. */
#define UP_HELLO 0x01
#define UP_AUDIO 0x02
#define UP_SELECT 0x03
#define UP_STATUS 0x04

/* What the phone sends. */
#define DOWN_THREADS 0x81
#define DOWN_TEXT 0x82
#define DOWN_STATE 0x83
#define DOWN_ACK 0x84

/* What a line of text is for. */
#define TEXT_HEARD 0
#define TEXT_REPLY 1
#define TEXT_NOTICE 2
#define TEXT_THREAD 3

/* What the open thread is doing. */
#define STATE_IDLE 0
#define STATE_HEARING 1
#define STATE_BUSY 2
#define STATE_AWAY 3

/* The menu's limits, as `MAX_THREADS` and `MAX_TITLE_BYTES` on the other side. */
#define PROTO_MAX_THREADS 32
#define PROTO_MAX_TITLE 48
#define PROTO_MAX_TEXT 2048

/* One fragment, handed to the radio. Answers false when it could not go. */
typedef bool (*proto_send_fn)(const uint8_t *frame, int len, void *ctx);

/*
 * Cut `body` into fragments and hand each to `send`.
 *
 * `payload` is what the connection's maximum transmission unit leaves for data,
 * which is the unit less the three bytes ATT keeps for itself. Answers false as
 * soon as a fragment could not go: a message half sent is a message the phone
 * throws away, so there is nothing to gain by sending the rest.
 */
bool proto_send(proto_send_fn send, void *ctx, uint8_t type, const uint8_t *body, size_t len,
                int payload);

/* A thread in the device's own menu. */
typedef struct {
    char title[PROTO_MAX_TITLE + 1];
    bool busy;
} proto_thread_t;

/* What the phone last sent, held whole so a repaint needs no radio. */
typedef struct {
    uint16_t generation;
    uint8_t count;
    proto_thread_t threads[PROTO_MAX_THREADS];
} proto_menu_t;

/* Read a `DOWN_THREADS` body into `menu`. False when the body is malformed. */
bool proto_read_threads(const uint8_t *body, size_t len, proto_menu_t *menu);

/* Read a `DOWN_TEXT` body. `out` takes at most `max` bytes and is terminated. */
bool proto_read_text(const uint8_t *body, size_t len, uint8_t *kind, char *out, size_t max);

/* Read a `DOWN_ACK` body. */
bool proto_read_ack(const uint8_t *body, size_t len, bool *ok, char *out, size_t max);

/* Build the bodies the device sends. Each answers the bytes written. */
size_t proto_write_hello(uint8_t *out, size_t max, const char *name);
size_t proto_write_select(uint8_t *out, uint16_t generation, uint16_t index);
size_t proto_write_status(uint8_t *out, uint8_t battery, uint32_t up_ms, uint32_t free_heap);
/* The 16-byte header an utterance opens with. The audio follows it. */
size_t proto_write_audio_header(uint8_t *out, uint32_t duration_ms, uint32_t samples);

/* Puts fragments back into messages. One per direction. */
typedef struct {
    uint8_t type;
    uint16_t id;
    bool building;
    size_t held;
    uint8_t buf[PROTO_MAX_TEXT + 512];
} proto_rx_t;

void proto_rx_reset(proto_rx_t *rx);

/*
 * Feed one fragment.
 *
 * Answers true when a message completed, and then `type`, `rx->buf` and `len`
 * are it. A fragment that belongs to no message in progress throws away what
 * was half built rather than joining two messages into one.
 */
bool proto_rx_push(proto_rx_t *rx, const uint8_t *frame, int len, uint8_t *type, size_t *out_len);
