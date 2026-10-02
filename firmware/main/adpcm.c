#include "adpcm.h"

#include <string.h>

static const int8_t INDEX_TABLE[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};

static const int16_t STEP_TABLE[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
};

static int16_t clamp_sample(int32_t v)
{
    if (v < -32768) return -32768;
    if (v > 32767) return 32767;
    return (int16_t)v;
}

static int8_t clamp_index(int32_t v)
{
    if (v < 0) return 0;
    if (v > 88) return 88;
    return (int8_t)v;
}

void adpcm_reset(adpcm_state_t *st)
{
    st->predictor = 0;
    st->index = 0;
}

size_t adpcm_block_count(size_t count)
{
    if (count == 0) return 0;
    return (count + ADPCM_BLOCK_SAMPLES - 1) / ADPCM_BLOCK_SAMPLES;
}

size_t adpcm_encode(adpcm_state_t *st, const int16_t *pcm, size_t count, uint8_t *out)
{
    if (count == 0) return 0;
    size_t blocks = adpcm_block_count(count);
    memset(out, 0, blocks * ADPCM_BLOCK_BYTES);

    for (size_t b = 0; b < blocks; b++) {
        size_t from = b * ADPCM_BLOCK_SAMPLES;
        size_t upto = from + ADPCM_BLOCK_SAMPLES;
        if (upto > count) upto = count;

        uint8_t *block = out + b * ADPCM_BLOCK_BYTES;
        int16_t predictor = pcm[from];

        /* The block's own header: where it starts and how big a step to take. */
        block[0] = (uint8_t)(predictor & 0xff);
        block[1] = (uint8_t)((predictor >> 8) & 0xff);
        block[2] = (uint8_t)st->index;
        block[3] = 0;

        size_t at = 4;
        int pending = -1;
        for (size_t i = from + 1; i < upto; i++) {
            int16_t step = STEP_TABLE[st->index];
            int32_t diff = (int32_t)pcm[i] - predictor;
            int nibble = 0;
            if (diff < 0) {
                nibble = 8;
                diff = -diff;
            }
            int32_t delta = step >> 3;
            if (diff >= step) {
                nibble |= 4;
                diff -= step;
                delta += step;
            }
            if (diff >= (step >> 1)) {
                nibble |= 2;
                diff -= step >> 1;
                delta += step >> 1;
            }
            if (diff >= (step >> 2)) {
                nibble |= 1;
                delta += step >> 2;
            }
            predictor = clamp_sample(nibble & 8 ? predictor - delta : predictor + delta);
            st->index = clamp_index(st->index + INDEX_TABLE[nibble]);

            /* Two samples to a byte, the earlier one in the low nibble. */
            if (pending < 0) {
                pending = nibble;
            } else {
                block[at++] = (uint8_t)(pending | (nibble << 4));
                pending = -1;
            }
        }
        if (pending >= 0) block[at++] = (uint8_t)pending;
        st->predictor = predictor;
    }
    return blocks * ADPCM_BLOCK_BYTES;
}
