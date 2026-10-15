/* ============ fix-server-ranking.test.ts — subida de marcas del cliente (src/net/ranking.ts) ============
 * Con un G.DB falso: los reintentos ante red caída, 5xx y 429, el motivo de cada rechazo
 * (onResult / last) y que la subida espere al aviso de inicio. Las esperas se saltan.
 *
 *   bun test tests/fix-server-ranking.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { G } from '../src/g';

type Reply = { status: number; j: any } | null;
let replies: Record<string, Reply[]> = {};
let calls: { method: string; path: string; body: any }[] = [];
let session: any = { token: 't', uid: '1', name: 'Ana' };
const toasts: string[] = [];

const realSetTimeout = globalThis.setTimeout;
// Sin esperas: los reintentos (segundos) se disparan al momento.
globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
afterAll(() => { globalThis.setTimeout = realSetTimeout; });

(G as any).DB = {
  get session() { return session; },
  async api(method: string, path: string, body?: any) {
    calls.push({ method, path, body });
    const q = replies[method + ' ' + path] || [];
    const r = q.length > 1 ? q.shift()! : q[0];
    if (r === undefined) return { status: 404, j: { ok: false, error: 'No existe.' } };
    if (r === null) throw new TypeError('Failed to fetch');
    return r;
  },
};
(G as any).UI = { toast: (t: string) => { toasts.push(t); } };
(G as any).Social = { friends: [] };
await import('../src/net/ranking');
const R = (G as any).Ranking;

const ok = (j: any = {}) => ({ status: 200, j: { ok: true, ...j } });
const err = (status: number, error: string) => ({ status, j: { ok: false, error } });
const solo = { t: 300, lv: 5, kills: 80, dex: 25, shiny: false };
const n = (path: string) => calls.filter(c => c.path === '/ranking' + path).length;
let results: any[] = [];
R.onResult((r: any) => results.push(r));

beforeEach(() => { replies = {}; calls = []; results = []; toasts.length = 0; session = { token: 't', uid: '1', name: 'Ana' }; });

describe('subir una marca al ranking', () => {
  test('sube y avisa del resultado', async () => {
    replies['POST /ranking/submit'] = [ok({ better: ['d', 'a'] })];
    expect(await R.submitSolo(solo)).toEqual(['d', 'a']);
    expect(results).toEqual([{ mode: 's', ok: true, better: ['d', 'a'] }]);
    expect(R.last).toEqual(results[0]);
    expect(toasts.length).toBe(1);
  });

  test('un 429 en /submit se reintenta, no se pierde la marca', async () => {
    replies['POST /ranking/submit'] = [err(429, 'Demasiadas peticiones. Espera un poco.'), err(429, 'Demasiadas peticiones. Espera un poco.'), ok({ better: ['a'] })];
    expect(await R.submitSolo(solo)).toEqual(['a']);
    expect(n('/submit')).toBe(3);
    expect(results[0].ok).toBe(true);
  });

  test('una caída de red y un 5xx también se reintentan', async () => {
    replies['POST /ranking/submit'] = [null, err(502, 'Bad gateway'), ok({ better: [] })];
    await R.submitSolo(solo);
    expect(n('/submit')).toBe(3);
    expect(results[0]).toEqual({ mode: 's', ok: true, better: [] });
  });

  test('si no hay manera, dice el motivo en vez de callar', async () => {
    replies['POST /ranking/submit'] = [err(429, 'x')];
    expect(await R.submitSolo(solo)).toEqual([]);
    expect(n('/submit')).toBe(4);                                          // el intento y tres reintentos
    expect(results[0].ok).toBe(false);
    expect(results[0].skipped).toBeUndefined();
    expect(results[0].reason).toMatch(/demasiadas peticiones/);
    replies['POST /ranking/submit'] = [null];
    await R.submitSolo(solo);
    expect(results[1].reason).toMatch(/conexión/);
  });

  test('un rechazo del servidor no se reintenta y trae su motivo', async () => {
    replies['POST /ranking/submit'] = [err(403, 'Una cuenta marcada no puede subir marcas.')];
    expect(await R.submitSolo(solo)).toEqual([]);
    expect(n('/submit')).toBe(1);
    expect(results[0]).toEqual({ mode: 's', ok: false, better: [], reason: 'Una cuenta marcada no puede subir marcas.' });
    replies['POST /ranking/submit'] = [err(400, 'Tiempo imposible.')];
    await R.submitSolo(solo);
    expect(results[1].reason).toBe('Tiempo imposible.');
  });

  test('sin partida en curso (el inicio no llegó): lo dice', async () => {
    replies['POST /ranking/submit'] = [err(409, 'No hay una partida en curso.')];
    await R.submitSolo(solo);
    expect(results[0].reason).toMatch(/inicio de la partida/);
  });

  test('una partida de más de una hora no se manda: el ranking no la admite', async () => {
    expect(await R.submitSolo({ ...solo, t: 3601 })).toEqual([]);
    expect(n('/submit')).toBe(0);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toMatch(/60 minutos/);
  });

  test('las partidas que no cuentan salen como "skipped", sin avisar de fallo', async () => {
    await R.submitSolo({ ...solo, t: 59 });
    await R.submitDefense({ waves: 0, lives: 10, secs: 5, kills: 0, dex: 25 });
    await R.submitGroup({ t: 300, lv: 3, kills: 3, members: [{ uid: '1', dex: 25 }] });
    expect(results.map(r => [r.mode, r.ok, r.skipped])).toEqual([['s', false, true], ['d', false, true], ['g', false, true]]);
    expect(n('/submit')).toBe(0);
  });

  test('sin sesión no se hace nada ni se avisa', async () => {
    session = null;
    expect(await R.submitSolo(solo)).toEqual([]);
    expect(calls.length).toBe(0);
    expect(results.length).toBe(0);
  });

  test('Defensa: el mismo camino, con su modo', async () => {
    replies['POST /ranking/submit'] = [err(429, 'x'), ok({ better: ['d'] })];
    expect(await R.submitDefense({ waves: 10, lives: 8, secs: 900, kills: 300, dex: 25 })).toEqual(['d']);
    expect(calls.at(-1)!.body.mode).toBe('d');
    expect(results[0].mode).toBe('d');
  });
});

describe('aviso de inicio de partida', () => {
  test('/start se reintenta ante 429 y la subida espera a que acabe', async () => {
    replies['POST /ranking/start'] = [err(429, 'x'), err(429, 'x'), ok()];
    replies['POST /ranking/submit'] = [ok({ better: [] })];
    R.runStarted('s');
    await R.submitSolo(solo);
    expect(calls.map(c => c.path)).toEqual(['/ranking/start', '/ranking/start', '/ranking/start', '/ranking/submit']);
  });

  test('un rechazo de /start (400) no se repite', async () => {
    replies['POST /ranking/start'] = [err(400, 'Modo no válido.')];
    replies['POST /ranking/submit'] = [ok({ better: [] })];
    R.runStarted('s');
    await R.submitSolo(solo);
    expect(n('/start')).toBe(1);
  });
});
