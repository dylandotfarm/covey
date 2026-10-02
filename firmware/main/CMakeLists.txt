idf_component_register(
    SRCS "main.c" "epaper.c" "font.c" "font_data.c" "adpcm.c" "proto.c"
         "buttons.c" "audio.c" "ble.c" "ui.c"
    INCLUDE_DIRS "."
    REQUIRES driver esp_timer nvs_flash bt esp_adc esp_driver_i2s esp_driver_i2c mbedtls
)
