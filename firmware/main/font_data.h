/* Written by tools/mkfont.py. Do not edit: run the script again. */
#pragma once
#include <stdint.h>

#define FONT_FIRST 32
#define FONT_LAST  126

#define FONT_SMALL_W 6
#define FONT_SMALL_H 12
extern const uint8_t font_small_bits[1140];

#define FONT_BODY_W 8
#define FONT_BODY_H 16
extern const uint8_t font_body_bits[1520];

