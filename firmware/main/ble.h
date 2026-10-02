/*
 * The radio (#178).
 *
 * One GATT service with two characteristics: the device notifies on the uplink
 * and the phone writes to the downlink. Two rather than one, so a reply can go
 * to the device while an utterance is still on its way up.
 *
 * The device is the peripheral and advertises. The phone scans for the service
 * and connects, which is the only arrangement that works: a phone's app cannot
 * advertise reliably in the background, and a device in a pocket must be
 * findable whenever the app is opened.
 *
 * **Bonding, and what it does not do.** The connection bonds, so a reader pairs
 * once and every later connection is encrypted and silent. The characteristics
 * themselves do *not* demand encryption. That is deliberate and it is a
 * trade: a phone that will not bond — and Android has several reasons not to,
 * none of which it explains — would otherwise connect, subscribe, and then fail
 * on the first write with nothing on either screen to say why. The audio on
 * this link is one radio hop to a phone in the same room, and everything past
 * the phone goes over the daemon's own authenticated socket.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* A whole message arrived from the phone. Called on the radio's own task. */
typedef void (*ble_rx_fn)(uint8_t type, const uint8_t *body, size_t len);

/* The link came up or went down. */
typedef void (*ble_link_fn)(bool connected);

bool ble_init(const char *name, ble_rx_fn on_message, ble_link_fn on_link);

bool ble_connected(void);

/* The phone has subscribed to notifications, so sending is worth doing. */
bool ble_ready(void);

/* What one notification can carry: the agreed unit less ATT's three bytes. */
int ble_payload(void);

/*
 * Send one message, in as many fragments as it takes.
 *
 * Blocks until the radio has taken every fragment, which for a whole utterance
 * is a few seconds. Call it from a task that is allowed to wait, never from a
 * callback the stack is holding a lock for.
 */
bool ble_send(uint8_t type, const uint8_t *body, size_t len);
