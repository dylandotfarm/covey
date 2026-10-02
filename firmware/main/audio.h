/*
 * The microphone (#178).
 *
 * The board's microphone and speaker are both an ES8311 on the I2C bus, with
 * the samples on I2S. Only the microphone is used: the device shows an answer,
 * it does not read one out.
 *
 * A recording is held whole in PSRAM and sent after the reader lets go, rather
 * than streamed while they talk. Two reasons, and both are the radio. BLE
 * carries about a tenth of what 16 kHz samples cost, so a stream would fall
 * behind the speaker within a second and never catch up. And the recogniser on
 * the phone wants a *file*: it is given the whole utterance at once, so there
 * is nothing waiting would have saved.
 *
 * Thirty seconds is the cap. It is 960 kB of the 8 MB this board has, and it is
 * far longer than anybody holds a button — the cap exists so a key held down in
 * a pocket cannot fill the heap, not because a long question is wrong.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AUDIO_MAX_SECONDS 30
#define AUDIO_MAX_SAMPLES (AUDIO_SAMPLE_RATE * AUDIO_MAX_SECONDS)

/* Bring the codec up. Answers false when the board did not answer on I2C. */
bool audio_init(void);

/* Start filling the buffer. Answers false when it was already recording. */
bool audio_record_start(void);

/* Stop. The samples stay until the next start. */
void audio_record_stop(void);

bool audio_recording(void);

/* What was recorded. `count` is samples, not bytes. */
const int16_t *audio_samples(size_t *count);

/* How long the recording is, by the count of samples rather than by a clock. */
uint32_t audio_duration_ms(void);

/*
 * The loudest sample of the recording, 0 to 1.
 *
 * Logged after every utterance. A recording that is silent and a recording the
 * recogniser could not read look the same on the screen and are two different
 * faults, and this is the number that tells them apart.
 */
float audio_peak(void);
