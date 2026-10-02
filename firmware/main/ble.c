#include "ble.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "proto.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "ble";

/*
 * The service and its two characteristics.
 *
 * NimBLE takes a 128-bit UUID with its bytes the other way round, so these read
 * backwards against `DEVICE_SERVICE_UUID` in `packages/client/src/device.ts`.
 * They are the same number. Check the last four bytes, which are the first four
 * characters of the string.
 */
static const ble_uuid128_t SVC_UUID = BLE_UUID128_INIT(
    0x21, 0x6e, 0x0b, 0x8f, 0x5a, 0x1d, 0x3e, 0x9c,
    0x1a, 0x4f, 0x2d, 0x7b, 0x00, 0x10, 0xbe, 0xc0);
static const ble_uuid128_t UP_UUID = BLE_UUID128_INIT(
    0x21, 0x6e, 0x0b, 0x8f, 0x5a, 0x1d, 0x3e, 0x9c,
    0x1a, 0x4f, 0x2d, 0x7b, 0x01, 0x10, 0xbe, 0xc0);
static const ble_uuid128_t DOWN_UUID = BLE_UUID128_INIT(
    0x21, 0x6e, 0x0b, 0x8f, 0x5a, 0x1d, 0x3e, 0x9c,
    0x1a, 0x4f, 0x2d, 0x7b, 0x02, 0x10, 0xbe, 0xc0);

static uint8_t s_addr_type;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_up_handle;
static bool s_subscribed;
static ble_rx_fn s_on_message;
static ble_link_fn s_on_link;
static proto_rx_t s_rx;
static char s_name[24];

static void advertise(void);

/* ----------------------------------------------------------------- access */

static int on_write(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn;
    (void)attr;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;

    uint8_t frame[600];
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, frame, sizeof(frame), &len) != 0)
        return BLE_ATT_ERR_INSUFFICIENT_RES;

    uint8_t type;
    size_t body_len;
    if (proto_rx_push(&s_rx, frame, len, &type, &body_len) && s_on_message)
        s_on_message(type, s_rx.buf, body_len);
    return 0;
}

static const struct ble_gatt_svc_def GATT_SVCS[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = &UP_UUID.u,
                .access_cb = on_write, /* never read; it exists only to notify */
                .val_handle = &s_up_handle,
                .flags = BLE_GATT_CHR_F_NOTIFY,
            },
            {
                .uuid = &DOWN_UUID.u,
                .access_cb = on_write,
                /*
                 * With a response and without.
                 *
                 * A thread list goes without, because it is many fragments and
                 * waiting for each would make opening the app feel slow. Some
                 * Android stacks refuse a write without a response on a
                 * characteristic that does not offer both, so both are offered.
                 */
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {0},
        },
    },
    {0},
};

/* ------------------------------------------------------------------ events */

static int on_gap(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            s_subscribed = false;
            proto_rx_reset(&s_rx);
            /*
             * Ask for a short connection interval.
             *
             * An utterance is a few hundred fragments and the radio sends at
             * most a handful an interval, so the interval *is* the transfer
             * rate. Android grants 7.5 ms to 15 ms here; left at its own
             * default of 50 ms a ten-second question takes a minute.
             */
            struct ble_gap_upd_params params = {
                .itvl_min = 6,  /* 7.5 ms, in units of 1.25 ms */
                .itvl_max = 12, /* 15 ms */
                .latency = 0,
                .supervision_timeout = 400, /* 4 s */
            };
            ble_gap_update_params(s_conn, &params);
            ESP_LOGI(TAG, "a phone connected");
            if (s_on_link) s_on_link(true);
        } else {
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "the phone went away (reason %d)", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_subscribed = false;
        if (s_on_link) s_on_link(false);
        advertise();
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_up_handle) {
            s_subscribed = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "the phone %s", s_subscribed ? "is listening" : "stopped listening");
        }
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "the connection agreed %d bytes", event->mtu.value);
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;

    default:
        return 0;
    }
}

static void advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;
    fields.name = (uint8_t *)s_name;
    fields.name_len = (uint8_t)strlen(s_name);
    fields.name_is_complete = 1;
    if (ble_gap_adv_set_fields(&fields) != 0) ESP_LOGE(TAG, "the name would not fit the advert");

    /*
     * The service UUID goes in the scan response, not the advert.
     *
     * A 128-bit UUID is 16 bytes and the name is most of what is left of the 31
     * an advert holds. The app scans for the service, and a scan picks up the
     * response as well as the advert.
     */
    struct ble_hs_adv_fields rsp = {0};
    rsp.uuids128 = (ble_uuid128_t *)&SVC_UUID;
    rsp.num_uuids128 = 1;
    rsp.uuids128_is_complete = 1;
    ble_gap_adv_rsp_set_fields(&rsp);

    struct ble_gap_adv_params adv = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    int err = ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &adv, on_gap, NULL);
    if (err != 0 && err != BLE_HS_EALREADY) ESP_LOGE(TAG, "advertising would not start (%d)", err);
}

static void on_sync(void)
{
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_addr_type);
    advertise();
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* ------------------------------------------------------------------ public */

bool ble_init(const char *name, ble_rx_fn on_message, ble_link_fn on_link)
{
    s_on_message = on_message;
    s_on_link = on_link;
    proto_rx_reset(&s_rx);
    snprintf(s_name, sizeof(s_name), "%s", name);

    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "the Bluetooth stack would not start");
        return false;
    }
    ble_hs_cfg.sync_cb = on_sync;
    /* Bond, and take the simple pairing: this device has no keypad. */
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(GATT_SVCS) != 0 || ble_gatts_add_svcs(GATT_SVCS) != 0) {
        ESP_LOGE(TAG, "the service would not register");
        return false;
    }
    ble_svc_gap_device_name_set(s_name);
    nimble_port_freertos_init(host_task);
    return true;
}

bool ble_connected(void) { return s_conn != BLE_HS_CONN_HANDLE_NONE; }
bool ble_ready(void) { return ble_connected() && s_subscribed; }

int ble_payload(void)
{
    if (!ble_connected()) return 20;
    uint16_t mtu = ble_att_mtu(s_conn);
    return mtu > 23 ? mtu - 3 : 20;
}

/* One fragment. Waits for room rather than dropping it. */
static bool send_frame(const uint8_t *frame, int len, void *ctx)
{
    (void)ctx;
    for (int tries = 0; tries < 400; tries++) {
        if (!ble_ready()) return false;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, (uint16_t)len);
        if (om) {
            int err = ble_gatts_notify_custom(s_conn, s_up_handle, om);
            if (err == 0) return true;
            if (err != BLE_HS_ENOMEM && err != BLE_HS_EAGAIN) {
                ESP_LOGW(TAG, "a fragment would not go (%d)", err);
                return false;
            }
        }
        /*
         * Out of buffers, which is the radio doing its job: the host holds a
         * fixed number of them and a whole utterance is more fragments than it
         * has. Wait a tick and try the same fragment again.
         */
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    ESP_LOGW(TAG, "the radio stayed full for two seconds");
    return false;
}

bool ble_send(uint8_t type, const uint8_t *body, size_t len)
{
    if (!ble_ready()) return false;
    return proto_send(send_frame, NULL, type, body, len, ble_payload());
}
