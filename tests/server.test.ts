/* ============ server.test.ts — pruebas adversariales de la API ============
 * Contra un servidor de verdad con la base en memoria: lo que intentaría
 * alguien con malas intenciones o un cliente roto (nombres raros, inyección,
 * tokens falsos, partidas gigantes, guardados a la vez desde dos dispositivos,
 * fuerza bruta, rutas fuera de dist/...).
 *
 *   bun test tests/server.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers';

let srv: ReturnType<typeof startServer>;
let base = '';

beforeAll(() => {
  // Un dist/ de mentira con un archivo, y un secreto FUERA de él que no debe salir.
  const root = mkdtempSync(join(tmpdir(), 'poke-td-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.html'), '<h1>juego</h1>');
  writeFileSync(join(root, 'secreto.txt'), 'NO');
  srv = startServer({ port: 0, dbPath: ':memory:', dist: join(root, 'dist'), loginLimit: 1000 });
  base = `http://127.0.0.1:${srv.server.port}`;
});
afterAll(() => srv.stop());

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  return { status: res.status, j };
}

let n = 0;
/** Cuenta nueva con un nombre único. */
async function account(pass = 'secreta1') {
  const name = 'Jug' + (++n) + Math.random().toString(36).slice(2, 6);
  const r = await call('POST', '/api/register', { name, pass });
  expect(r.status).toBe(200);
  return { name, pass, token: r.j.token as string };
}

describe('cuentas', () => {
  test('crear, entrar y saber quién eres', async () => {
    const a = await account();
    expect((await call('GET', '/api/me', undefined, a.token)).j.name).toBe(a.name);
    const l = await call('POST', '/api/login', { name: a.name.toUpperCase(), pass: a.pass });
    expect(l.status).toBe(200);
    expect(l.j.name).toBe(a.name);                      // el nombre visible no cambia de mayúsculas
    expect(l.j.token).not.toBe(a.token);
  });

  test('el nombre es único sin distinguir mayúsculas', async () => {
    const a = await account();
    const r = await call('POST', '/api/register', { name: a.name.toLowerCase(), pass: 'otra1234' });
    expect(r.status).toBe(409);
  });

  test('dos registros simultáneos con el mismo nombre: sólo uno', async () => {
    const name = 'Carrera' + Math.random().toString(36).slice(2, 6);
    const rs = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/register', { name, pass: 'secreta1' })));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(rs.filter(r => r.status === 409).length).toBe(7);
  });

  test.each([
    ['vacío', ''], ['corto', 'ab'], ['largo', 'a'.repeat(17)], ['espacios', 'a b c'],
    ['inyección SQL', "x' OR 1=1 --"], ['html', '<script>'], ['emoji', 'ab😀c'],
    ['número', 12345], ['objeto', { $ne: null }], ['null', null],
  ])('nombre no válido: %s', async (_, name) => {
    const r = await call('POST', '/api/register', { name, pass: 'secreta1' });
    expect(r.status).toBe(400);
    expect(r.j.ok).toBe(false);
  });

  test('contraseña corta, larga o que no es texto', async () => {
    for (const pass of ['12345', 'x'.repeat(201), 123456, null, ['secreta1']]) {
      const r = await call('POST', '/api/register', { name: 'Pass' + Math.random().toString(36).slice(2, 8), pass });
      expect(r.status).toBe(400);
    }
  });

  test('entrar mal da siempre el mismo error (no revela si el nombre existe)', async () => {
    const a = await account();
    const wrong = await call('POST', '/api/login', { name: a.name, pass: 'mala1234' });
    const ghost = await call('POST', '/api/login', { name: 'NoExiste' + n, pass: 'mala1234' });
    const inj = await call('POST', '/api/login', { name: "' OR '1'='1", pass: "' OR '1'='1" });
    for (const r of [wrong, ghost, inj]) { expect(r.status).toBe(401); expect(r.j.error).toBe(wrong.j.error); }
  });

  test('JSON roto, cuerpo que no es objeto o demasiado grande', async () => {
    expect((await call('POST', '/api/login', undefined, undefined, '{nombre')).status).toBe(400);
    expect((await call('POST', '/api/login', undefined, undefined, '[1,2]')).status).toBe(400);
    expect((await call('POST', '/api/login', undefined, undefined, '"hola"')).status).toBe(400);
    expect((await call('POST', '/api/login', { name: 'x'.repeat(20000), pass: 'y' })).status).toBe(413);
  });

  test('cerrar sesión invalida ese token y no los demás', async () => {
    const a = await account();
    const b = (await call('POST', '/api/login', { name: a.name, pass: a.pass })).j.token;
    expect((await call('POST', '/api/logout', undefined, a.token)).status).toBe(200);
    expect((await call('GET', '/api/me', undefined, a.token)).status).toBe(401);
    expect((await call('GET', '/api/me', undefined, b)).status).toBe(200);
  });

  test('tokens falsos o mal formados', async () => {
    const a = await account();
    for (const t of ['', 'x', a.token + 'x', a.token.slice(0, -1), 'a'.repeat(43), "' OR 1=1 --", a.token.toUpperCase()]) {
      const res = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + t } });
      expect(res.status).toBe(401);
    }
    const res = await fetch(base + '/api/me', { headers: { Authorization: a.token } });   // sin "Bearer"
    expect(res.status).toBe(401);
  });

  test('borrar la cuenta pide la contraseña y se lleva sesiones y partida', async () => {
    const a = await account();
    await call('PUT', '/api/save', { save: { coins: 5 }, base: 0 }, a.token);
    expect((await call('DELETE', '/api/account', { pass: 'mala1234' }, a.token)).status).toBe(401);
    expect((await call('DELETE', '/api/account', { pass: a.pass }, a.token)).status).toBe(200);
    expect((await call('GET', '/api/save', undefined, a.token)).status).toBe(401);
    expect((await call('POST', '/api/login', a)).status).toBe(401);
    // El nombre queda libre y la cuenta nueva empieza sin partida.
    const again = await call('POST', '/api/register', { name: a.name, pass: 'nueva123' });
    expect(again.status).toBe(200);
    expect((await call('GET', '/api/save', undefined, again.j.token)).j.save).toBeNull();
  });

  test('fuerza bruta: a partir del límite por minuto, 429', async () => {
    const s = startServer({ port: 0, dbPath: ':memory:', dist: '/nada', loginLimit: 5 });
    try {
      const codes = [];
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`http://127.0.0.1:${s.server.port}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'x', pass: 'y' }) });
        codes.push(r.status);
      }
      expect(codes.slice(0, 5).every(c => c === 401)).toBe(true);
      expect(codes.slice(5).every(c => c === 429)).toBe(true);
    } finally { s.stop(); }
  });
});

describe('partida', () => {
  test('sin sesión no se lee ni se escribe', async () => {
    expect((await call('GET', '/api/save')).status).toBe(401);
    expect((await call('PUT', '/api/save', { save: {}, base: 0 })).status).toBe(401);
  });

  test('guardar y leer; la versión sube en cada guardado', async () => {
    const a = await account();
    expect((await call('GET', '/api/save', undefined, a.token)).j).toEqual({ ok: true, save: null, ver: 0 });
    const s1 = { name: a.name, coins: 10, owned: { 25: { at: 1, from: 'starter' } }, texto: 'ñ "comillas"   😀' };
    const p1 = await call('PUT', '/api/save', { save: s1, base: 0 }, a.token);
    expect(p1.j).toEqual({ ok: true, ver: 1 });
    expect((await call('GET', '/api/save', undefined, a.token)).j).toEqual({ ok: true, save: s1, ver: 1 });
    expect((await call('PUT', '/api/save', { save: { ...s1, coins: 20 }, base: 1 }, a.token)).j.ver).toBe(2);
  });

  test('cada cuenta sólo ve su partida', async () => {
    const a = await account(), b = await account();
    await call('PUT', '/api/save', { save: { de: 'a' }, base: 0 }, a.token);
    expect((await call('GET', '/api/save', undefined, b.token)).j.save).toBeNull();
  });

  test('versión vieja: 409 con la partida actual (no se pisa)', async () => {
    const a = await account();
    await call('PUT', '/api/save', { save: { coins: 1 }, base: 0 }, a.token);
    await call('PUT', '/api/save', { save: { coins: 2 }, base: 1 }, a.token);
    const stale = await call('PUT', '/api/save', { save: { coins: 999 }, base: 1 }, a.token);
    expect(stale.status).toBe(409);
    expect(stale.j.save).toEqual({ coins: 2 });
    expect(stale.j.ver).toBe(2);
    expect((await call('GET', '/api/save', undefined, a.token)).j.save).toEqual({ coins: 2 });
  });

  test('dos dispositivos guardan a la vez sobre la misma versión: gana uno, el otro recibe 409', async () => {
    const a = await account();
    await call('PUT', '/api/save', { save: { coins: 0 }, base: 0 }, a.token);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('PUT', '/api/save', { save: { coins: i }, base: 1 }, a.token)));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(rs.filter(r => r.status === 409).length).toBe(9);
    expect((await call('GET', '/api/save', undefined, a.token)).j.ver).toBe(2);
  });

  test('partidas no válidas o gigantes', async () => {
    const a = await account();
    for (const b of [{}, { save: null, base: 0 }, { save: [1], base: 0 }, { save: 'x', base: 0 }, { save: {}, base: -1 }, { save: {}, base: 1.5 }, { save: {}, base: '0' }]) {
      expect((await call('PUT', '/api/save', b, a.token)).status).toBe(400);
    }
    const huge = { save: { relleno: 'x'.repeat(600 * 1024) }, base: 0 };
    expect((await call('PUT', '/api/save', huge, a.token)).status).toBe(413);
    expect((await call('GET', '/api/save', undefined, a.token)).j.save).toBeNull();
  });
});

describe('archivos', () => {
  test('sirve dist/ pero nada de fuera', async () => {
    expect(await (await fetch(base + '/')).text()).toBe('<h1>juego</h1>');
    for (const p of ['/../secreto.txt', '/%2e%2e/secreto.txt', '/%2e%2e%2fsecreto.txt', '/..%5csecreto.txt', '/%zz']) {
      const res = await fetch(base + p);
      expect([400, 403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('NO');
    }
  });

  test('rutas de la API que no existen y métodos raros', async () => {
    expect((await call('GET', '/api/nada')).status).toBe(404);
    expect((await call('DELETE', '/api/save')).status).toBe(404);
    expect((await fetch(base + '/', { method: 'POST' })).status).toBe(405);
  });
});
