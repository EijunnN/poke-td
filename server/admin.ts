/* ============ server/admin.ts — tareas de administración desde la VPS ============
 *
 *   bun server/admin.ts reset-password <nombre>   contraseña temporal para quien la olvidó
 *   bun server/admin.ts backup <carpeta>          copia de la base de datos (guarda BACKUP_KEEP, 14)
 *
 * Usa la misma base de datos que el servidor (DB_PATH, por defecto data/poke-td.sqlite).
 * Se puede ejecutar con el servidor en marcha.
 */
import { join } from 'node:path';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { openDb } from './db';
import { resetPassword } from './account';

const [cmd, arg] = process.argv.slice(2);
const db = openDb(process.env.DB_PATH || join(import.meta.dir, '..', 'data', 'poke-td.sqlite'));
let code = 0;

if (cmd === 'reset-password' && arg) {
  const pass = await resetPassword(db, arg);
  if (!pass) { console.error(`No existe la cuenta "${arg}".`); code = 1; }
  else {
    console.log(`Contraseña temporal de "${arg}": ${pass}`);
    console.log('Se han cerrado sus sesiones. Dile que entre con ella y la cambie en Ajustes → Cuenta.');
  }
} else if (cmd === 'backup' && arg) {
  mkdirSync(arg, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(arg, `poke-td-${stamp}.sqlite`);
  // VACUUM INTO hace una copia coherente aunque el servidor esté escribiendo.
  db.raw.run('VACUUM INTO ?', [file]);
  const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
  const old = readdirSync(arg).filter(f => /^poke-td-.*\.sqlite$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(join(arg, f));
  console.log(`Copia: ${file}${old.length ? ` (borradas ${old.length} antiguas)` : ''}`);
} else {
  console.log('Uso:\n  bun server/admin.ts reset-password <nombre>\n  bun server/admin.ts backup <carpeta>');
  code = cmd ? 1 : 0;
}
db.close();
process.exit(code);
