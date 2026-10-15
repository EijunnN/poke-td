/* ============ chat-filter.test.ts — limpieza y censura opcional del chat ============ */
import { describe, expect, test } from 'bun:test';
import { cleanChat, maskBad } from '../src/data/chat-filter';
import { CHAT_MAX } from '../src/data/quick-chat';

describe('cleanChat (servidor): no toca las palabras', () => {
  test('junta espacios, quita invisibles y corta a lo máximo', () => {
    expect(cleanChat('  hola   a\ttodos ')).toBe('hola a todos');
    expect(cleanChat('ho​la‮')).toBe('hola');
    expect(cleanChat(' ​\n ')).toBeNull();
    expect([...cleanChat('ñ'.repeat(500))!].length).toBe(CHAT_MAX);
    expect(cleanChat('eres un PUT0 idiota')).toBe('eres un PUT0 idiota');
  });
});

describe('maskBad (Ajustes → Censurar palabrotas)', () => {
  test('tacha palabrotas aunque vengan disfrazadas, y los enlaces', () => {
    expect(maskBad('eres un PUT0 idiotaaa, mira www.estafa.com y MIERDÁ')).toBe('eres un **** ********, mira [enlace] y ******');
    expect(maskBad('what the fuck, fucking shit')).toBe('what the ****, ******* ****');
    expect(maskBad('jodido cabrón')).toBe('****** ******');
  });
  test('no tacha palabras normales que se parecen', () => {
    const ok = 'una pera, un cono y la perra de Niger; el calculo de la noche en Shitake';
    expect(maskBad(ok)).toBe(ok);
  });
});
