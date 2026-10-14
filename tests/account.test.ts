/* ============ account.test.ts — cambiar y restablecer la contraseña (adversarial) ============
 *   bun test tests/account.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers';
import { openDb } from '../server/db';

let srv: ReturnType<typeof startServer>;
let base = '';
const dbPath = join(mkdtempSync(join(tmpdir(), 'poke-td-acc-')), 'acc.sqlite');

beforeAll(() => {
  srv = startServer({ port: 0, dbPath, dist: '/nada', loginLimit: 1000 });
  base = `http://127.0.0.1:${srv.server.port}`;
});
afterAll(() => srv.stop());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  return { status: res.status, j };
}

let n = 0;
async function account(pass = 'secreta1') {
  const name = 'Acc' + (++n) + Math.random().toString(36).slice(2, 6);
  const r = await call('POST', '/api/register', { name, pass });
  expect(r.status).toBe(200);
  return { name, pass, token: r.j.token as string };
}

describe('cambiar la contraseña', () => {
  test('con la actual buena: entra con la nueva, no con la vieja', async () => {
    const a = await account();
    expect((await call('POST', '/api/password', { old: a.pass, pass: 'nueva1234' }, a.token)).status).toBe(200);
    expect((await call('POST', '/api/login', { name: a.name, pass: a.pass })).status).toBe(401);
    expect((await call('POST', '/api/login', { name: a.name, pass: 'nueva1234' })).status).toBe(200);
  });

  test('cierra las demás sesiones y deja abierta la de quien la cambia', async () => {
    const a = await account();
    const other = (await call('POST', '/api/login', { name: a.name, pass: a.pass })).j.token;
    await call('POST', '/api/password', { old: a.pass, pass: 'nueva1234' }, a.token);
    expect((await call('GET', '/api/me', undefined, a.token)).status).toBe(200);
    expect((await call('GET', '/api/me', undefined, other)).status).toBe(401);
  });

  test('sin sesión, con la actual mala, o con una nueva no válida: no cambia', async () => {
    const a = await account();
    expect((await call('POST', '/api/password', { old: a.pass, pass: 'nueva1234' })).status).toBe(401);
    expect((await call('POST', '/api/password', { old: 'mala1234', pass: 'nueva1234' }, a.token)).status).toBe(401);
    for (const pass of ['12345', 'x'.repeat(201), 123456, null, ['nueva1234']]) {
      expect((await call('POST', '/api/password', { old: a.pass, pass }, a.token)).status).toBe(400);
    }
    for (const old of [null, 123, ['secreta1'], '']) {
      expect((await call('POST', '/api/password', { old, pass: 'nueva1234' }, a.token)).status).toBe(401);
    }
    expect((await call('POST', '/api/login', { name: a.name, pass: a.pass })).status).toBe(200);
  });

  test('otro método o un token falso', async () => {
    const a = await account();
    expect((await call('GET', '/api/password', undefined, a.token)).status).toBe(404);
    expect((await call('POST', '/api/password', { old: a.pass, pass: 'nueva1234' }, a.token + 'x')).status).toBe(401);
  });

  test('probar contraseñas actuales a lo bruto: 429', async () => {
    const a = await account();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await call('POST', '/api/password', { old: 'mala' + i + 'xx', pass: 'nueva1234' }, a.token)).status);
    expect(codes.slice(0, 10).every(c => c === 401)).toBe(true);
    expect(codes.slice(10).every(c => c === 429)).toBe(true);
    // Ni siquiera con la buena mientras dura el bloqueo.
    expect((await call('POST', '/api/password', { old: a.pass, pass: 'nueva1234' }, a.token)).status).toBe(429);
  });
});

describe('restablecer desde la VPS (server/admin.ts)', () => {
  const admin = (...args: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'server', 'admin.ts'), ...args], { env: { ...process.env, DB_PATH: dbPath } });

  test('pone una temporal, cierra sus sesiones y con ella se entra', async () => {
    const a = await account();
    const r = admin('reset-password', a.name.toUpperCase());
    expect(r.exitCode).toBe(0);
    const temp = /: (\S+)\n/.exec(r.stdout.toString())![1];
    expect(temp.length).toBeGreaterThanOrEqual(10);
    expect((await call('GET', '/api/me', undefined, a.token)).status).toBe(401);
    expect((await call('POST', '/api/login', { name: a.name, pass: a.pass })).status).toBe(401);
    const l = await call('POST', '/api/login', { name: a.name, pass: temp });
    expect(l.status).toBe(200);
    // Y desde ahí la cambia a una suya.
    expect((await call('POST', '/api/password', { old: temp, pass: 'mia12345' }, l.j.token)).status).toBe(200);
  });

  test('cuenta que no existe, sin nombre o con inyección: no toca nada', async () => {
    const before = openDb(dbPath).raw.query('SELECT COUNT(*) AS n, GROUP_CONCAT(pass) AS p FROM users').get();
    expect(admin('reset-password', 'NoExisteNadie').exitCode).toBe(1);
    expect(admin('reset-password', "x' OR '1'='1").exitCode).toBe(1);
    expect(admin('reset-password').exitCode).toBe(1);
    expect(admin('otra-cosa', 'x').exitCode).toBe(1);
    const after = openDb(dbPath).raw.query('SELECT COUNT(*) AS n, GROUP_CONCAT(pass) AS p FROM users').get();
    expect(after).toEqual(before);
  });

  test('cada temporal es distinta', async () => {
    const a = await account();
    const p1 = /: (\S+)\n/.exec(admin('reset-password', a.name).stdout.toString())![1];
    const p2 = /: (\S+)\n/.exec(admin('reset-password', a.name).stdout.toString())![1];
    expect(p1).not.toBe(p2);
  });
});

describe('copias de seguridad (server/admin.ts backup)', () => {
  test('la copia se abre y tiene las cuentas; sólo se guardan las BACKUP_KEEP últimas', async () => {
    const a = await account();
    const dir = mkdtempSync(join(tmpdir(), 'poke-td-bak-'));
    const run = () => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'server', 'admin.ts'), 'backup', dir],
      { env: { ...process.env, DB_PATH: dbPath, BACKUP_KEEP: '2' } });
    for (let i = 0; i < 3; i++) { expect(run().exitCode).toBe(0); await Bun.sleep(5); }
    const files = (await Array.fromAsync(new Bun.Glob('poke-td-*.sqlite').scan(dir))).sort();
    expect(files.length).toBe(2);
    const copy = openDb(join(dir, files[1]));
    expect(copy.userByKey(a.name.toLowerCase())?.name).toBe(a.name);
    copy.close();
  });
});

describe('IP del jugador detrás de Caddy (TRUST_PROXY)', () => {
  test('inventarse X-Forwarded-For no salta el límite de intentos', async () => {
    const s = startServer({ port: 0, dbPath: ':memory:', dist: '/nada', loginLimit: 3, trustProxy: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        // Caddy AÑADE la IP real al final; lo de delante lo pone quien quiera.
        const r = await fetch(`http://127.0.0.1:${s.server.port}/api/login`, {
          method: 'POST', body: JSON.stringify({ name: 'x', pass: 'y' }),
          headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` },
        });
        codes.push(r.status);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    } finally { s.stop(); }
  });
});
