/* ============ quick-chat.ts — frases rápidas y límites del chat ============
 * Lo comparten el juego y el servidor (server/realtime.ts valida el id): por eso
 * no importa nada del juego. Las frases viajan por su id y cada uno las ve en
 * su idioma.
 */

export interface QuickPhrase { id: string; es: string; en: string }

export const QUICK: QuickPhrase[] = [
  { id: 'hi', es: '¡Hola!', en: 'Hi!' },
  { id: 'ready', es: '¡Listo!', en: 'Ready!' },
  { id: 'help', es: '¡Ayuda!', en: 'Help!' },
  { id: 'omw', es: '¡Voy!', en: 'On my way!' },
  { id: 'wait', es: 'Espera un momento', en: 'Wait a moment' },
  { id: 'watch', es: '¡Cuidado!', en: 'Watch out!' },
  { id: 'thx', es: '¡Gracias!', en: 'Thanks!' },
  { id: 'gg', es: '¡Bien jugado!', en: 'Well played!' },
];
export const QUICK_IDS: ReadonlySet<string> = new Set(QUICK.map(q => q.id));

/** Largo máximo de un mensaje escrito. */
export const CHAT_MAX = 120;
