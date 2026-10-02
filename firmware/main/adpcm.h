/*
 * IMA ADPCM, the device's half (#178).
 *
 * The other half is `adpcmFromPcm` and `pcmFromAdpcm` in
 * `packages/client/src/device.ts`, and the two must agree byte for byte. They
 * cannot be tested together — one is C on a microcontroller and the other is
 * TypeScript on a phone — so the device dumps its own encoder's bytes over the
 * serial port (`covey selftest`) and `device.test.ts` decodes those exact
 * bytes. Change one side and run that, or the words stop arriving and nothing
 * says why.
 *
 * Four bits a sample instead of sixteen, which is what makes an utterance fit
 * in the radio time BLE has. Every block stands alone: it opens with the sample
 * it starts from and the step to read on, so a block lost on the air costs its
 * own 32 milliseconds and not the rest of the sentence.
 */
#pragma once

#include <stdint.h>
#include <stddef.h>

/* Bytes in a block, and the samples it holds. Mirrors `ADPCM_BLOCK_BYTES`. */
#define ADPCM_BLOCK_BYTES 256
#define ADPCM_BLOCK_SAMPLES (1 + (ADPCM_BLOCK_BYTES - 4) * 2)

/* Carried between blocks so the step does not restart from silence each time. */
typedef struct {
    int16_t predictor;
    int8_t index;
} adpcm_state_t;

/* Start an encoder. */
void adpcm_reset(adpcm_state_t *st);

/*
 * Encode `count` samples into whole blocks.
 *
 * `out` must hold `adpcm_block_count(count) * ADPCM_BLOCK_BYTES`. A last block
 * with fewer than `ADPCM_BLOCK_SAMPLES` samples is padded to the boundary,
 * because a block that does not start where the decoder looks is a block it
 * cannot read. The caller sends the sample count alongside, and the decoder
 * stops there.
 *
 * Answers the bytes written.
 */
size_t adpcm_encode(adpcm_state_t *st, const int16_t *pcm, size_t count, uint8_t *out);

/* Blocks `count` samples take. */
size_t adpcm_block_count(size_t count);
