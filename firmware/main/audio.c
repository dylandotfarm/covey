#include "audio.h"

#include <string.h>

#include "board.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "audio";

/* Samples read in one go. 20 ms, which is small enough to stop quickly. */
#define CHUNK 320

static esp_codec_dev_handle_t s_dev;
static i2s_chan_handle_t s_rx, s_tx;
static int16_t *s_buf;
static volatile size_t s_count;
static volatile bool s_running;
static TaskHandle_t s_task;
static float s_peak;

static void record_task(void *arg)
{
    (void)arg;
    while (s_running && s_count + CHUNK <= AUDIO_MAX_SAMPLES) {
        int got = esp_codec_dev_read(s_dev, s_buf + s_count, CHUNK * (int)sizeof(int16_t));
        if (got != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "the codec stopped answering (%d)", got);
            break;
        }
        s_count += CHUNK;
    }
    s_running = false;
    s_task = NULL;
    vTaskDelete(NULL);
}

bool audio_init(void)
{
    /* The codec's rail is active low, like the screen's. */
    gpio_config_t pwr = {.mode = GPIO_MODE_OUTPUT, .pin_bit_mask = 1ULL << AUDIO_PWR_PIN};
    ESP_ERROR_CHECK(gpio_config(&pwr));
    gpio_set_level(AUDIO_PWR_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(50));

    s_buf = heap_caps_malloc(AUDIO_MAX_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    if (!s_buf) {
        ESP_LOGE(TAG, "no PSRAM for %d seconds of audio", AUDIO_MAX_SECONDS);
        return false;
    }

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_PORT,
        .sda_io_num = I2C_SDA_PIN,
        .scl_io_num = I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus = NULL;
    if (i2c_new_master_bus(&bus_cfg, &bus) != ESP_OK) {
        ESP_LOGE(TAG, "the I2C bus would not start");
        return false;
    }

    /*
     * One I2S port carries both directions and they share the clock lines, so
     * both channels are made together even though only the receiving one is
     * read. The ES8311 takes its bit clock from this port; make the transmit
     * channel separately and the two disagree about the word clock.
     */
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&chan, &s_tx, &s_rx));

    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                        I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_MCLK_PIN,
            .bclk = I2S_BCLK_PIN,
            .ws = I2S_WS_PIN,
            .dout = I2S_DOUT_PIN,
            .din = I2S_DIN_PIN,
            .invert_flags = {false, false, false},
        },
    };
    /* The ES8311 wants a master clock at 256 times the sample rate. */
    std.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_rx, &std));
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_tx, &std));

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_PORT,
        .addr = ES8311_CODEC_DEFAULT_ADDR,
        .bus_handle = bus,
    };
    const audio_codec_ctrl_if_t *ctrl = audio_codec_new_i2c_ctrl(&i2c_cfg);
    if (!ctrl) {
        ESP_LOGE(TAG, "no ES8311 answered on I2C");
        return false;
    }

    audio_codec_i2s_cfg_t i2s_cfg = {.port = I2S_NUM_0, .rx_handle = s_rx, .tx_handle = s_tx};
    const audio_codec_data_if_t *data = audio_codec_new_i2s_data(&i2s_cfg);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();

    es8311_codec_cfg_t es = {
        .ctrl_if = ctrl,
        .gpio_if = gpio_if,
        /* Both, because the ES8311 clocks its converter off the playback path:
         * opened for the microphone alone it answers, but with silence. */
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
        .pa_pin = CODEC_PA_PIN,
        .use_mclk = true,
        .master_mode = false,
    };
    const audio_codec_if_t *codec = es8311_codec_new(&es);
    if (!codec) {
        ESP_LOGE(TAG, "the ES8311 would not start");
        return false;
    }

    esp_codec_dev_cfg_t dev = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
        .codec_if = codec,
        .data_if = data,
    };
    s_dev = esp_codec_dev_new(&dev);
    if (!s_dev) return false;

    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16,
        .channel = 1,
        .sample_rate = AUDIO_SAMPLE_RATE,
    };
    int err = esp_codec_dev_open(s_dev, &fs);
    if (err != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "the codec would not open (%d)", err);
        return false;
    }
    /* 30 dB is what a voice at arm's length needs on this board's microphone. */
    esp_codec_dev_set_in_gain(s_dev, 30.0f);
    /* Nothing is played, so the amplifier stays down and draws nothing. */
    esp_codec_dev_set_out_vol(s_dev, 0);

    ESP_LOGI(TAG, "ES8311 up at %d Hz", AUDIO_SAMPLE_RATE);
    return true;
}

bool audio_record_start(void)
{
    if (s_running || !s_dev) return false;
    s_count = 0;
    s_peak = 0;
    s_running = true;
    if (xTaskCreate(record_task, "record", 4096, NULL, 6, &s_task) != pdPASS) {
        s_running = false;
        return false;
    }
    return true;
}

void audio_record_stop(void)
{
    s_running = false;
    /* Let the task see the flag and leave before anybody reads the buffer. */
    for (int i = 0; i < 50 && s_task; i++) vTaskDelay(pdMS_TO_TICKS(10));

    float peak = 0;
    for (size_t i = 0; i < s_count; i++) {
        float v = (float)(s_buf[i] < 0 ? -s_buf[i] : s_buf[i]) / 32768.0f;
        if (v > peak) peak = v;
    }
    s_peak = peak;
}

bool audio_recording(void) { return s_running; }

const int16_t *audio_samples(size_t *count)
{
    if (count) *count = s_count;
    return s_buf;
}

uint32_t audio_duration_ms(void)
{
    return (uint32_t)((uint64_t)s_count * 1000 / AUDIO_SAMPLE_RATE);
}

float audio_peak(void) { return s_peak; }
