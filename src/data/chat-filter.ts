/* ============ chat-filter.ts — limpieza de los mensajes del chat ============
 * Lo usan el servidor y el juego (no importa nada del juego):
 *   - cleanChat (servidor, server/realtime.ts): quita caracteres de control e
 *     invisibles, junta espacios y corta a CHAT_MAX. null si no queda nada. No
 *     cambia ninguna palabra: el chat es libre.
 *   - maskBad (juego, net/chat.ts): sólo si el jugador activa «Censurar palabrotas»
 *     en Ajustes, y sólo en lo que ve él. Tacha los insultos y palabrotas más
 *     comunes (español e inglés) aunque vengan con tildes, mayúsculas, letras
 *     repetidas o números en vez de letras ("put4", "MIERDAAA"), y cambia los
 *     enlaces por [enlace].
 */
import { CHAT_MAX } from './quick-chat';

/** Palabras tachadas enteras (ya normalizadas: minúsculas, sin tildes, sin letras repetidas). */
const WORDS = new Set([
  // español
  'puta', 'putas', 'puto', 'putos', 'mierda', 'mierdas', 'joder', 'jodete', 'cabron', 'cabrona', 'cabrones',
  'gilipolas', 'pendejo', 'pendeja', 'pendejos', 'verga', 'vergas', 'chinga', 'chingar', 'chingada', 'chingado',
  'culero', 'culera', 'maricon', 'maricones', 'marica', 'imbecil', 'imbeciles', 'idiota', 'idiotas',
  'estupido', 'estupida', 'subnormal', 'mongolo', 'mongola', 'retrasado', 'retrasada', 'folar', 'polla', 'culo',
  'hijoputa', 'hijueputa', 'malparido', 'malparida', 'carajo', 'mamon', 'mamona', 'pinche', 'nazi',
  'cagon', 'mierdoso', 'gonorea', 'huevon', 'weon', 'conchetumare', 'ctm', 'hdp',
  // inglés
  'fuck', 'fucker', 'fucking', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'whore', 'slut', 'cock',
  'pusy', 'motherfucker', 'retard', 'faget', 'fag', 'niga', 'wtf', 'stfu',
]);
/** Raíces: se tacha cualquier palabra que empiece así (jodido, putada, fucked, mierdero...). */
const STEMS = ['puta', 'puto', 'mierd', 'jod', 'gilipol', 'pendej', 'cabron', 'maric', 'chingad', 'hijoput', 'hijueput',
  'fuck', 'shit', 'bitch', 'fag'];
// Al juntar letras repetidas, algunas palabras normales caen en un insulto ("perra" -> "pera", la
// fruta; "coño" -> "cono", la figura; Niger, el país): ésas no están en la lista. Y las raíces que
// también empiezan palabras normales, aquí.
const SAFE = new Set(['shitake', 'fagot', 'fagots']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Forma con la que se compara una palabra: minúsculas, sin tildes, sin "leet" y sin letras repetidas. */
export function norm(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[013457@$!]/g, ch => LEET[ch]).replace(/ñ/g, 'n')
    .replace(/(.)\1+/g, '$1');
}

function bad(word: string): boolean {
  const n = norm(word);
  if (!n || SAFE.has(n)) return false;
  return WORDS.has(n) || STEMS.some(s => n.startsWith(s) && !SAFE.has(n));
}

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|xyz|gg|io|es|me|ly|tk|ru|link|site|app|dev)\b(?:\/\S*)?/gi;
/** Caracteres de control e invisibles (ancho cero, marcas de dirección...). */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** El mensaje tal y como se reparte (sin tachar todavía), o null si queda vacío. */
export function cleanChat(s: string): string | null {
  // Primero los espacios (tabuladores y saltos de línea son caracteres de control: si no, se pegaban las palabras).
  const t = s.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ +/g, ' ').trim();
  if (!t) return null;
  return [...t].slice(0, CHAT_MAX).join('').trim() || null;
}

/** Tacha palabrotas y enlaces. Las palabras se miran con letras, números y @$! (las trampas típicas). */
export function maskBad(s: string): string {
  return s.replace(LINK, '[enlace]')
    .replace(/[\p{L}\p{N}@$!]+/gu, w => bad(w) ? '*'.repeat([...w].length) : w);
}
