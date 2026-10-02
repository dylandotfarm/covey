/*
 * The Waveshare ESP32-S3 1.54inch e-Paper board, V2 (#178).
 *
 * Every number here is the board's, not a choice: it comes from the vendor's
 * own `user_config.h` and from the codec board entry `S3_ePaper_1_54`. Change a
 * line only for a different board, and then change `docs/DEVICE.md` with it.
 *
 * The chip is an ESP32-S3-PICO-1 with 8 MB of flash and 8 MB of PSRAM. It has
 * Bluetooth Low Energy and no Bluetooth Classic, which is why the device speaks
 * GATT and not a serial port profile.
 */
#pragma once

#include "driver/gpio.h"
#include "driver/spi_master.h"

/* The screen. 200 by 200, one bit a pixel, driven by an SSD1681. */
#define EPD_WIDTH 200
#define EPD_HEIGHT 200
#define EPD_SPI_HOST SPI2_HOST
#define EPD_DC_PIN GPIO_NUM_10
#define EPD_CS_PIN GPIO_NUM_11
#define EPD_SCK_PIN GPIO_NUM_12
#define EPD_MOSI_PIN GPIO_NUM_13
#define EPD_RST_PIN GPIO_NUM_9
#define EPD_BUSY_PIN GPIO_NUM_8

/*
 * The three power rails the board switches.
 *
 * The screen and the codec are held off until something needs them, and both
 * are *active low*. The battery rail is the other way round: it is the divider
 * that lets the ADC read the cell, and it is switched on only to take a reading
 * because it draws while it is closed.
 */
#define EPD_PWR_PIN GPIO_NUM_6
#define AUDIO_PWR_PIN GPIO_NUM_42
#define VBAT_PWR_PIN GPIO_NUM_17
#define VBAT_ADC_PIN GPIO_NUM_4

/*
 * The two buttons, both active low.
 *
 * PWR talks and BOOT walks the menu. The roles are that way round because GPIO0
 * is the pin the chip samples at reset: a reader who holds BOOT while the
 * device restarts lands in the serial bootloader with a blank screen, and the
 * button a reader holds for seconds at a time must never be that one.
 */
#define BUTTON_TALK_PIN GPIO_NUM_18
#define BUTTON_MENU_PIN GPIO_NUM_0

/* The I2C bus: the codec, the clock and the temperature sensor share it. */
#define I2C_SDA_PIN GPIO_NUM_47
#define I2C_SCL_PIN GPIO_NUM_48
#define I2C_PORT I2C_NUM_0

/* The ES8311 codec, which is both the microphone and the speaker. */
#define I2S_MCLK_PIN GPIO_NUM_14
#define I2S_BCLK_PIN GPIO_NUM_15
#define I2S_WS_PIN GPIO_NUM_38
#define I2S_DOUT_PIN GPIO_NUM_45
#define I2S_DIN_PIN GPIO_NUM_16
#define CODEC_PA_PIN GPIO_NUM_46
#define ES8311_ADDR 0x18

/* What the recogniser on the phone takes, and so what the device records. */
#define AUDIO_SAMPLE_RATE 16000

/*
 * The firmware's own version, which rides on `UP_HELLO`.
 *
 * The app reads it to say what is on the device, and to tell a reader whose
 * device is older than their app why something is missing.
 */
#define FIRMWARE_MAJOR 0
#define FIRMWARE_MINOR 1
#define FIRMWARE_PATCH 0
