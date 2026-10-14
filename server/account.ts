/* ============ server/account.ts — cambiar y restablecer la contraseña ============
 *
 *   POST /api/password  { old, pass }   -> { ok }   cambia la contraseña de tu cuenta
 *
 * Al cambiarla se cierran las demás sesiones de la cuenta (la de este
 * dispositivo sigue abierta). Si alguien la olvida, el administrador le pone
 * una temporal desde la VPS: `bun server/admin.ts reset-password <nombre>`.
 */
import type { Db } from './db';
import { json, fail, readBody, type Module } from './http';

export const MIN_PASS = 6, MAX_PASS = 200;

/**
 * Contra quien prueba contraseñas actuales a lo bruto con una sesión robada:
 * a partir de `max` fallos en un minuto (por cuenta o por IP), 429 hasta que pase.
 * Sólo cuentan los fallos de contraseña, no los cambios buenos ni los datos mal puestos.
 */
function failures(max: number) {
  const seen = new Map<string, { n: number; t: number }>();
  return {
    blocked(k: string) { const f = seen.get(k); return !!f && Date.now() - f.t < 60_000 && f.n >= max; },
    add(k: string) {
      const f = seen.get(k);
      if (!f || Date.now() - f.t >= 60_000) { seen.set(k, { n: 1, t: Date.now() }); if (seen.size > 50_000) seen.clear(); }
      else f.n++;
    },
  };
}

export function createAccount(db: Db, opts: { perUser?: number; perIp?: number } = {}): Module {
  const byUser = failures(opts.perUser ?? 10), byIp = failures(opts.perIp ?? 30);
  return async (req, ctx) => {
    if (ctx.path !== '/password') return null;
    if (req.method !== 'POST') return fail(404, 'No existe.');
    if (!ctx.user || !ctx.session) return fail(401, 'Sesión caducada: vuelve a entrar.');
    const uk = String(ctx.user.id);
    if (byUser.blocked(uk) || byIp.blocked(ctx.ip)) return fail(429, 'Demasiados intentos seguidos. Espera un poco.');
    const b = await readBody(req);
    if (b instanceof Response) return b;
    const old = typeof b.old === 'string' ? b.old : '', pass = typeof b.pass === 'string' ? b.pass : '';
    if (!old || !(await Bun.password.verify(old, ctx.user.pass))) {
      byUser.add(uk); byIp.add(ctx.ip);
      return fail(401, 'La contraseña actual no es correcta.');
    }
    if (pass.length < MIN_PASS) return fail(400, `La contraseña nueva debe tener al menos ${MIN_PASS} caracteres.`);
    if (pass.length > MAX_PASS) return fail(400, 'La contraseña nueva es demasiado larga.');
    db.setPassword(ctx.user.id, await Bun.password.hash(pass, { algorithm: 'argon2id' }));
    db.deleteOtherSessions(ctx.user.id, ctx.session);
    return json({ ok: true });
  };
}

/** Contraseña temporal legible (sin letras que se confundan). */
export function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, x => A[x % A.length]).join('');
}

/**
 * Pone una contraseña temporal a la cuenta `name` y cierra todas sus sesiones.
 * @returns la contraseña temporal, o null si la cuenta no existe
 */
export async function resetPassword(db: Db, name: string) {
  const user = db.userByKey(name.trim().toLowerCase());
  if (!user) return null;
  const pass = tempPassword();
  db.setPassword(user.id, await Bun.password.hash(pass, { algorithm: 'argon2id' }));
  db.deleteOtherSessions(user.id);
  return pass;
}
