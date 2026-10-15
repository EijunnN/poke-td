/* ============ music.test.ts — las partituras se pueden tocar ============
 * El sintetizador (core/audio.ts) lee las canciones de data/music.ts: una nota
 * o un acorde mal escritos sonaban mal sin avisar. Aquí se revisan todas.
 */
import { describe, expect, test } from 'bun:test';
import { MUSIC } from '../src/data/music';

const NOTE = /^[A-G](#|b)?-?\d$/;                         // como midiOf en core/audio.ts
const CHORD = /^([A-G])(#|b)?(m?)(?:\/([A-G])(#|b)?)?$/;   // como parseChord

describe('partituras', () => {
  for (const [id, song] of Object.entries(MUSIC)) {
    test(id, () => {
      for (const c of song.chords) expect(c).toMatch(CHORD);
      const bars = song.bars || song.chords.length;
      for (const tr of song.melody || []) {
        for (const bar of tr.bars) {
          let steps = 0;
          for (const tok of bar.trim().split(/\s+/)) {
            const [n, len] = tok.split(':');
            if (n !== '-') expect(n).toMatch(NOTE);
            steps += +len || 1;
          }
          expect(steps).toBeLessThanOrEqual(16);            // un compás son 16 semicorcheas
        }
        expect(tr.bars.length).toBeLessThanOrEqual(bars);
      }
      for (const p of song.parts || []) {
        expect(Number.isInteger(p.octave)).toBe(true);
        expect(p.pattern.length).toBe(16);
      }
    });
  }
});
