#include "epaper.h"

#include <string.h>

#include "board.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "epaper";

/* 200 columns is 25 bytes a row, and the panel takes a row at a time. */
#define EPD_ROW_BYTES (EPD_WIDTH / 8)
#define EPD_BUF_LEN (EPD_ROW_BYTES * EPD_HEIGHT)

static uint8_t s_buf[EPD_BUF_LEN];
static spi_device_handle_t s_spi;
static int s_since_full = 0;
static bool s_partial_ready = false;

/*
 * The waveform tables the panel loads before a refresh.
 *
 * These are the panel's own, from the vendor's driver for this exact screen.
 * They are not parameters: an SSD1681 drives the ink with a voltage sequence
 * that belongs to the film it is bonded to, and a table from another panel
 * leaves ghosting or does not develop the image at all.
 */
static const uint8_t LUT_FULL[159] = {
    0x80, 0x48, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x48, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x80, 0x48, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x48, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x08, 0x01, 0x00, 0x08, 0x01, 0x00, 0x02,
    0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x00, 0x00, 0x00,
    0x22, 0x17, 0x41, 0x00, 0x32, 0x20,
};

static const uint8_t LUT_PARTIAL[159] = {
    0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x80, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x00, 0x00, 0x00,
    0x02, 0x17, 0x41, 0xb0, 0x32, 0x28,
};

static void wait_idle(void)
{
    /* The pin is high while the panel works. A full refresh holds it ~2 s. */
    int waited = 0;
    while (gpio_get_level(EPD_BUSY_PIN) == 1) {
        vTaskDelay(pdMS_TO_TICKS(5));
        if ((waited += 5) > 10000) {
            ESP_LOGE(TAG, "the panel stayed busy for 10 s");
            return;
        }
    }
}

static void write_spi(const uint8_t *data, int len, bool is_command)
{
    gpio_set_level(EPD_DC_PIN, is_command ? 0 : 1);
    gpio_set_level(EPD_CS_PIN, 0);
    spi_transaction_t t = {.length = 8 * len, .tx_buffer = data};
    ESP_ERROR_CHECK(spi_device_polling_transmit(s_spi, &t));
    gpio_set_level(EPD_CS_PIN, 1);
}

static void cmd(uint8_t c) { write_spi(&c, 1, true); }
static void dat(uint8_t d) { write_spi(&d, 1, false); }

static void cmd_data(uint8_t c, const uint8_t *data, int len)
{
    cmd(c);
    write_spi(data, len, false);
}

static void load_lut(const uint8_t *lut)
{
    cmd_data(0x32, lut, 153);
    wait_idle();
    cmd(0x3f); dat(lut[153]);
    cmd(0x03); dat(lut[154]);
    cmd(0x04); dat(lut[155]); dat(lut[156]); dat(lut[157]);
    cmd(0x2c); dat(lut[158]);
}

static void reset_panel(void)
{
    gpio_set_level(EPD_RST_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    gpio_set_level(EPD_RST_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(EPD_RST_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    wait_idle();
}

/* The window and the cursor, in the panel's own axes. */
static void set_window(void)
{
    cmd(0x44);
    dat(0x00);
    dat((EPD_WIDTH - 1) >> 3);
    cmd(0x45);
    dat((EPD_HEIGHT - 1) & 0xff);
    dat((EPD_HEIGHT - 1) >> 8);
    dat(0x00);
    dat(0x00);
    cmd(0x4e);
    dat(0x00);
    cmd(0x4f);
    dat((EPD_HEIGHT - 1) & 0xff);
    dat((EPD_HEIGHT - 1) >> 8);
}

static void init_full(void)
{
    reset_panel();
    cmd(0x12); /* a software reset, which the panel answers by going busy */
    wait_idle();

    cmd(0x01); /* how many rows the panel drives */
    dat(0xc7);
    dat(0x00);
    dat(0x01);

    cmd(0x11); /* data entry mode: x up, y down */
    dat(0x01);

    set_window();

    cmd(0x3c); /* the border, so the frame around the image stays white */
    dat(0x01);

    cmd(0x18); /* read the temperature from the panel's own sensor */
    dat(0x80);

    cmd(0x22);
    dat(0xb1);
    cmd(0x20);
    wait_idle();

    load_lut(LUT_FULL);
    s_partial_ready = false;
}

static void init_partial(void)
{
    reset_panel();
    load_lut(LUT_PARTIAL);

    cmd(0x37);
    for (int i = 0; i < 10; i++) dat(i == 5 ? 0x40 : 0x00);

    cmd(0x3c);
    dat(0x80);

    cmd(0x22);
    dat(0xc0);
    cmd(0x20);
    wait_idle();
    s_partial_ready = true;
}

void epaper_init(void)
{
    gpio_config_t out = {
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = (1ULL << EPD_RST_PIN) | (1ULL << EPD_DC_PIN) |
                        (1ULL << EPD_CS_PIN) | (1ULL << EPD_PWR_PIN),
    };
    ESP_ERROR_CHECK(gpio_config(&out));
    gpio_config_t in = {.mode = GPIO_MODE_INPUT, .pin_bit_mask = 1ULL << EPD_BUSY_PIN};
    ESP_ERROR_CHECK(gpio_config(&in));

    gpio_set_level(EPD_PWR_PIN, 0); /* the rail is active low */
    gpio_set_level(EPD_CS_PIN, 1);
    gpio_set_level(EPD_RST_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(100));

    spi_bus_config_t bus = {
        .miso_io_num = -1,
        .mosi_io_num = EPD_MOSI_PIN,
        .sclk_io_num = EPD_SCK_PIN,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = EPD_BUF_LEN + 8,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(EPD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev = {
        .clock_speed_hz = 20 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = -1, /* chip select is driven by hand, around each byte */
        .queue_size = 4,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(EPD_SPI_HOST, &dev, &s_spi));

    epaper_clear();
    init_full();
    ESP_LOGI(TAG, "panel up, %dx%d", EPD_WIDTH, EPD_HEIGHT);
}

void epaper_clear(void)
{
    /* The panel reads a 1 bit as white, which is the opposite of the ink. */
    memset(s_buf, 0xff, sizeof(s_buf));
}

void epaper_pixel(int x, int y, int colour)
{
    if (x < 0 || y < 0 || x >= EPD_WIDTH || y >= EPD_HEIGHT) return;
    uint8_t *byte = &s_buf[y * EPD_ROW_BYTES + (x >> 3)];
    uint8_t mask = 0x80 >> (x & 7);
    if (colour == EPAPER_BLACK) *byte &= (uint8_t)~mask;
    else *byte |= mask;
}

void epaper_fill(int x, int y, int w, int h, int colour)
{
    for (int row = y; row < y + h; row++)
        for (int col = x; col < x + w; col++) epaper_pixel(col, row, colour);
}

void epaper_rect(int x, int y, int w, int h, int colour)
{
    for (int col = x; col < x + w; col++) {
        epaper_pixel(col, y, colour);
        epaper_pixel(col, y + h - 1, colour);
    }
    for (int row = y; row < y + h; row++) {
        epaper_pixel(x, row, colour);
        epaper_pixel(x + w - 1, row, colour);
    }
}

void epaper_flush(bool allow_partial)
{
    bool partial = allow_partial && s_since_full < EPAPER_FULL_EVERY;

    if (partial) {
        if (!s_partial_ready) init_partial();
        set_window();
        cmd_data(0x24, s_buf, sizeof(s_buf));
        cmd(0x22);
        dat(0xcf);
        cmd(0x20);
        wait_idle();
        s_since_full++;
        /*
         * Keep the panel's second buffer in step with the first.
         *
         * A partial refresh draws the difference between what is in 0x24 and
         * what is in 0x26. Leave 0x26 behind and the next partial refresh
         * redraws against a frame two steps old, which paints the text that was
         * there two screens ago back on top of this one.
         */
        cmd_data(0x26, s_buf, sizeof(s_buf));
        return;
    }

    init_full();
    set_window();
    cmd_data(0x24, s_buf, sizeof(s_buf));
    cmd(0x22);
    dat(0xc7);
    cmd(0x20);
    wait_idle();
    cmd_data(0x26, s_buf, sizeof(s_buf));
    s_since_full = 0;
}

void epaper_sleep(void)
{
    cmd(0x10);
    dat(0x01);
    vTaskDelay(pdMS_TO_TICKS(100));
}

const uint8_t *epaper_buffer(int *len)
{
    if (len) *len = (int)sizeof(s_buf);
    return s_buf;
}
