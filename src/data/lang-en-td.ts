import { G } from '../g';
import { WAVES } from '../modes/td-waves';
import { ROLES, AURAS, MAPS, TARGET_NAME } from '../modes/td-geom';
/* ============ lang-en-td.ts — el modo Defensa en inglés ============
 * Como lang-en.ts (clave: el texto en español tal como sale; {x} = hueco), pero
 * sólo lo de la Defensa (modes/td.ts) y lo que la rodea: sala, ranking, misiones
 * y logros. Los temas de las oleadas, los poderes de cada tipo, las auras y los
 * mapas se traducen desde sus propios datos (cada uno lleva su `en`), así no se
 * quedan atrás si se cambian.
 */
const fromData: Record<string, string> = {};
for (const w of WAVES) { fromData[w.theme] = w.en[0]; fromData[w.hint] = w.en[1]; }
for (const r of Object.values(ROLES)) { fromData[r.name] = r.en[0]; fromData[r.desc] = r.en[1]; }
for (const a of Object.values(AURAS)) { fromData[a.move] = a.en[0]; fromData[a.what] = a.en[1]; }
for (const m of MAPS) fromData[m.name] = m.en;
G.I18n.add(fromData);

const TARGET_EN: Record<string, string> = { first: 'The first', last: 'The last', strong: 'The strongest', near: 'The nearest' };
const targets: Record<string, string> = {};
for (const [k, v] of Object.entries(TARGET_NAME)) targets[v] = TARGET_EN[k];
G.I18n.add(targets);

G.I18n.add({
  // ---------------- favoritos y mapa ----------------
  'Defensa · tus favoritos': 'Defense · your favorites',
  'En la partida puedes comprar cualquier Pokémon de tu colección. Los favoritos (hasta {x}) salen primero en la tienda.':
    'In the game you can buy any Pokémon from your collection. Your favorites (up to {x}) come first in the shop.',
  'Mapa:': 'Map:', 'Al azar': 'Random', 'Empezar': 'Start', 'Empezar · {x} favoritos': 'Start · {x} favorites',
  'Empezar · 1 favorito': 'Start · 1 favorite', 'préstamo': 'on loan', 'Apoyo': 'Support',

  // ---------------- marcador de arriba ----------------
  'Vidas': 'Lives', 'Monedas': 'Coins', 'Oleada {x} · {x}': 'Wave {x} · {x}', 'Oleada {x} en {x} s · {x}': 'Wave {x} in {x} s · {x}',
  'Quedan {x} · {x}': '{x} left · {x}', '¡Empezar! (N)': 'Start! (N)', 'Ya (N)': 'Now (N)', 'Terminar': 'Finish',
  'Terminar y cobrar el premio': 'Finish and collect the reward', 'Velocidad (F)': 'Speed (F)',
  'La velocidad la elige el anfitrión': 'The host chooses the speed', 'Esperando a {x}…': 'Waiting for {x}…', 'Sin fin · {x}': 'Endless · {x}',

  // ---------------- tienda ----------------
  'Tienda': 'Shop', 'Ocultar': 'Hide', 'Abrir': 'Open', 'Favoritos': 'Favorites', 'Tipo…': 'Type…', 'Filtrar por tipo': 'Filter by type',
  'y {x} más: filtra por tipo': 'and {x} more: filter by type',

  // ---------------- panel de la torre ----------------
  '{x} va a evolucionar': '{x} is about to evolve', 'Elige en qué:': 'Choose into what:', '{x} (tú)': '{x} (you)',
  'Ataque: nivel {x}': 'Attack: level {x}', 'Al máximo': 'Maxed out', 'Mejorar ataque · {x}': 'Upgrade attack · {x}',
  'Es tuya': "It's yours", 'Dueño:': 'Owner:', 'Nivel {x}': 'Level {x}', 'radio': 'radius', 'alcance corto': 'short range',
  'alcance medio': 'medium range', 'alcance largo': 'long range', 'Al mejorarlo: {x}': 'When upgraded: {x}', 'Reforzada: {x}': 'Boosted: {x}',
  'La próxima mejora lo hace evolucionar (eliges en qué)': 'The next upgrade makes it evolve (you choose into what)',
  'La próxima mejora lo hace evolucionar a {x}': 'The next upgrade makes it evolve into {x}',
  'Mejorar · {x}': 'Upgrade · {x}', 'Ataca a: {x}': 'Attacks: {x}', 'Vender · +{x}': 'Sell · +{x}',
  'Apoyo: no ataca; {x} a las torres cercanas': 'Support: does not attack; {x} to nearby towers',

  // ---------------- colocar ----------------
  'Colocando': 'Placing', 'monedas': 'coins',
  'Toca para plantar aquí': 'Tap to place it here', 'Clic para plantar aquí': 'Click to place it here', 'Cancelar (Esc)': 'Cancel (Esc)',
  'Fuera del mapa': 'Off the map', 'Demasiado cerca de la entrada o de la base': 'Too close to the entrance or the base',
  'Encima del camino': 'On the path', 'Pegada a otra torre': 'Right next to another tower', 'Ahí no': 'Not there',
  'Te faltan monedas': 'Not enough coins',

  // ---------------- avisos de la partida ----------------
  '¡Congelado!': 'Frozen!', '¡Paralizado!': 'Paralyzed!', '¡Aturdido!': 'Stunned!', '¡Confuso!': 'Confused!',
  '¡{x} derrotado!': '{x} defeated!', '¡Llega {x}!': 'Here comes {x}!', '{x} ha llegado a la base': '{x} reached the base',
  '¡Oleada {x} superada!': 'Wave {x} cleared!', '¡{x} ha evolucionado a {x}!': '{x} evolved into {x}!',
  '¡Habéis defendido la base! Ahora, sin fin: ¿hasta dónde llegáis?': 'You defended the base! Now it is endless: how far can you go?',
  'Compra torres en la tienda y plántalas junto al camino': 'Buy towers in the shop and place them along the path',
  'Defended juntos: cada uno compra sus torres con sus monedas': 'Defend together: each of you buys towers with your own coins',
  'Las torres de {x} pasan al anfitrión': '{x}\'s towers now belong to the host',
  'El anfitrión ha terminado la partida': 'The host has ended the game',

  // ---------------- resumen ----------------
  '¡Victoria! · las {x} oleadas': 'Victory! · all {x} waves', '¡Victoria! · y en el sin fin, hasta la oleada {x}': 'Victory! · and in endless mode, up to wave {x}',
  'La base ha caído · oleada {x}': 'The base has fallen · wave {x}', 'Defensa terminada · oleada {x}': 'Defense over · wave {x}',
  'oleadas {x} · derrotados {x} · victoria {x}': 'waves {x} · defeated {x} · victory {x}', 'oleadas {x} · derrotados {x}': 'waves {x} · defeated {x}',
  'Partida tocada desde la consola: sin premio': 'Game modified from the console: no reward',
  'Oleadas superadas': 'Waves cleared',

  // ---------------- sala ----------------
  'Modo:': 'Mode:', 'Hordas': 'Hordes', 'Modo: {x}': 'Mode: {x}', 'Defensa · {x}': 'Defense · {x}',
  'Tower defense · solo o en grupo': 'Tower defense · solo or in a group',

  // ---------------- ranking ----------------
  'Defensa en grupo': 'Group Defense', '{x} Defensa en grupo': '{x} Group Defense',

  // ---------------- misiones y logros ----------------
  'Supera {x} oleadas en una partida de Defensa': 'Clear {x} waves in a Defense game',
  'Gana una partida de Defensa (las 30 oleadas)': 'Win a Defense game (all 30 waves)', 'Gana {x} partidas de Defensa': 'Win {x} Defense games',
  'Primera línea': 'Front line', 'Supera 10 oleadas en una partida de Defensa.': 'Clear 10 waves in a Defense game.',
  'Defensor': 'Defender', 'Gana una partida de Defensa (las 30 oleadas).': 'Win a Defense game (all 30 waves).',
  'Muralla': 'Rampart', 'Gana una partida de Defensa sin perder ninguna vida.': 'Win a Defense game without losing a single life.',
  'Sin fin': 'Endless', 'Supera la oleada 40 (en el modo sin fin).': 'Clear wave 40 (in endless mode).',
  'Fortaleza': 'Fortress', 'Gana una partida de Defensa en grupo.': 'Win a Defense game in a group.', 'Guardián': 'Guardian',
});
