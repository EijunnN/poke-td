import { G } from '../g';
import { ROLES, AURAS, AURA_KINDS, SUPPORT, auraStrength, START_MONEY, REFUND, EVOLVE_AT, MAX_LEVEL, type AuraKind } from '../modes/td-geom';
import { WAVES, START_LIVES, leakCost } from '../modes/td-waves';
/* ============ guide-ui.ts — "Cómo se juega" ============
 * Guía para los jugadores dentro del juego: lo básico, la Supervivencia, la
 * Defensa y preguntas frecuentes. Se abre desde la barra de arriba, desde
 * Ajustes y desde la pantalla de favoritos de la Defensa.
 *
 * Cada texto va en español y en inglés (como las Novedades) y con
 * translate="no", para que i18n no lo toque. Las tablas de la Defensa (poder de
 * cada tipo, apoyos, calendario de oleadas) y sus números salen de los mismos
 * datos que usa el juego: si se cambia el balance, la guía no se queda vieja.
 */
export const GuideUI = (() => {
  const $ = G.UI.$;
  type Tab = 'basics' | 'survivor' | 'td' | 'faq';
  const TABS: [Tab, string, string][] = [
    ['basics', 'Lo básico', 'Basics'],
    ['survivor', 'Supervivencia', 'Survival'],
    ['td', 'Defensa', 'Defense'],
    ['faq', 'Preguntas', 'FAQ'],
  ];
  let tab: Tab = 'basics';
  const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const en = () => G.I18n.lang === 'en';
  /** El texto en el idioma del juego. */
  const T = (es: string, eng: string) => en() ? eng : es;
  const pct = (x: number) => Math.round(x * 100) + '%';
  const h = (es: string, eng: string) => `<h3>${T(es, eng)}</h3>`;
  const ul = (items: [string, string][]) => `<ul>${items.map(([a, b]) => `<li>${T(a, b)}</li>`).join('')}</ul>`;
  const chip = (t: string) => `<i class="guide-type" style="background:${G.U.TYPE_COLOR[t] || '#888'}">${esc(en() ? t[0].toUpperCase() + t.slice(1) : G.U.TYPE_NAME[t] || t)}</i>`;
  const name = (dex: number) => esc((G.DEX_BY[dex] && G.DEX_BY[dex].name) || '#' + dex);

  function basics() {
    return h('Controles', 'Controls')
      + ul([
        ['<b>PC:</b> muévete con <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> o las flechas. Cambia de ataque con <kbd>1</kbd>–<kbd>4</kbd>, <kbd>Q</kbd>/<kbd>E</kbd> o haciendo clic en su icono. Pausa con <kbd>Esc</kbd> o <kbd>P</kbd>.',
         '<b>PC:</b> move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the arrow keys. Switch attacks with <kbd>1</kbd>–<kbd>4</kbd>, <kbd>Q</kbd>/<kbd>E</kbd> or by clicking its icon. Pause with <kbd>Esc</kbd> or <kbd>P</kbd>.'],
        ['<b>Móvil o tablet (en horizontal):</b> arrastra el dedo en cualquier parte para moverte (el joystick sale donde tocas), toca un ataque para cambiarlo y el botón de arriba a la derecha para pausar.',
         '<b>Phone or tablet (landscape):</b> drag your finger anywhere to move (the joystick appears where you touch), tap an attack to switch to it and the top-right button to pause.'],
      ])
      + h('Tu compañero', 'Your partner')
      + ul([
        ['Llevas a un Pokémon que <b>ataca solo</b> con su movimiento activo. Tú te encargas de moverte, esquivar y elegir el ataque.',
         'You control a Pokémon that <b>attacks on its own</b> with its active move. You move, dodge and choose the attack.'],
        ['La <b>tabla de tipos</b> de los juegos cuenta: un número amarillo y grande es un golpe muy eficaz; uno gris, poco eficaz.',
         'The games\' <b>type chart</b> applies: a big yellow number is a super-effective hit; a grey one, not very effective.'],
        ['Con las <b>monedas</b> compras mejoras permanentes para cada compañero (en el menú, Mejoras).',
         'With <b>coins</b> you buy permanent upgrades for each partner (Upgrades, in the menu).'],
      ])
      + h('Tu colección', 'Your collection')
      + ul([
        ['Consigues Pokémon nuevos en el <b>gacha</b>, por región, con tickets que se ganan jugando. No se compran con dinero real.',
         'You get new Pokémon from the <b>gacha</b>, by region, with tickets you earn by playing. They cannot be bought with real money.'],
        ['<b>Shinies:</b> 1 de cada 4096 Pokémon salvajes, y un 1% en el gacha.',
         '<b>Shinies:</b> 1 in 4096 wild Pokémon, and 1% in the gacha.'],
        ['Con una <b>cuenta</b> (nombre y contraseña) tu partida se guarda en el servidor y la sigues en cualquier dispositivo. Como invitado se juega al momento, pero no se guarda.',
         'With an <b>account</b> (name and password) your progress is saved on the server and you can continue on any device. As a guest you play right away, but nothing is saved.'],
      ]);
  }

  function survivor() {
    return h('El objetivo', 'The goal')
      + `<p>${T('Aguanta todo lo que puedas mientras las hordas de Pokémon salvajes intentan rodearte. Cuanto más tiempo, más duras.',
               'Survive as long as you can while hordes of wild Pokémon try to surround you. The longer you last, the tougher they get.')}</p>`
      + h('Crecer en la partida', 'Growing during a run')
      + ul([
        ['Recoge la <b>experiencia</b> que sueltan los enemigos para subir de nivel y elige entre tres cartas: movimientos nuevos, mejorar los que tienes o potenciar a tu Pokémon.',
         'Pick up the <b>experience</b> enemies drop to level up, then choose one of three cards: new moves, upgrading the ones you have, or boosting your Pokémon.'],
        ['Los <b>movimientos evolucionan</b>: al nivel máximo y con la mejora adecuada, Ascuas pasa a Llamarada, Burbuja a Surf…',
         '<b>Moves evolve</b>: at max level and with the right upgrade, Ember becomes Fire Blast, Bubble becomes Surf…'],
        ['Los jefes sueltan <b>objetos equipables</b> (Restos, Cinta Elección, Vidasfera…).',
         'Bosses drop <b>held items</b> (Leftovers, Choice Band, Life Orb…).'],
      ])
      + h('Lo que te vas a encontrar', 'What you will find')
      + ul([
        ['Enemigos con personalidad: unos <b>curan</b>, otros ponen <b>escudos</b>, invocan a su manada, explotan o disparan rayos. Los que curan o protegen llevan un icono encima: ve a por ellos primero.',
         'Enemies with personality: some <b>heal</b>, others put up <b>shields</b>, call their pack, explode or fire beams. Healers and shielders have an icon above them: take them out first.'],
        ['Los <b>avisos en el suelo</b> (círculos y rayas que se llenan) son ataques a punto de caer: sal de ellos.',
         '<b>Warnings on the ground</b> (circles and lines that fill up) are attacks about to land: get out of them.'],
        ['<b>Grietas:</b> portales que aparecen de vez en cuando. Dentro luchas contra un legendario en una arena de su tipo.',
         '<b>Rifts:</b> portals that appear now and then. Inside you fight a legendary in an arena of its type.'],
        ['<b>Clima:</b> con lluvia el Agua se potencia y el Fuego se debilita; también hay sol, arena, nieve y niebla.',
         '<b>Weather:</b> rain powers up Water and weakens Fire; there is also sun, sand, snow and fog.'],
        ['En el <b>minuto 30</b> llega la Sentencia de Arceus: invencible, cada vez más rápido y con un legendario más cada pocos segundos. ¿Cuánto aguantas?',
         'At <b>minute 30</b> the Judgment of Arceus arrives: invincible, faster and faster, with another legendary every few seconds. How long can you last?'],
      ])
      + h('En grupo', 'With friends')
      + ul([
        ['Hasta <b>4 jugadores</b>: añade a tus amigos por su nombre, invítalos a tu sala y empezad. Para revivir a un compañero caído, quédate a su lado.',
         'Up to <b>4 players</b>: add your friends by name, invite them to your room and start. To revive a fallen teammate, stay next to them.'],
      ])
      + h('Consejos', 'Tips')
      + ul([
        ['No te quedes quieto: muévete en círculos amplios para que las hordas te sigan en fila.',
         'Do not stand still: move in wide circles so the hordes follow you in a line.'],
        ['Cambia al ataque que sea muy eficaz contra lo que tienes delante.',
         'Switch to the attack that is super effective against what is in front of you.'],
      ]);
  }

  function auraLine(k: AuraKind) {
    const a = AURAS[k];
    const who = Object.keys(SUPPORT).map(Number).filter(d => SUPPORT[d] === k && G.DEX_BY[d]).map(name).join(', ');
    const what = en() ? a.en[1] : a.what;
    return `<tr><td><b style="color:${a.color}">${esc(en() ? a.en[0] : a.move)}</b></td>
      <td>+${pct(auraStrength(k, 1))} → +${pct(auraStrength(k, MAX_LEVEL))} ${esc(what)}</td><td>${who}</td></tr>`;
  }

  function td() {
    const types = Object.keys(ROLES).sort((a, b) => (G.U.TYPE_NAME[a] || a).localeCompare(G.U.TYPE_NAME[b] || b));
    return h('El objetivo', 'The goal')
      + `<p>${T(`Los enemigos siguen el camino hasta tu base. Aguanta las <b>${WAVES.length} oleadas</b>. Empiezas con <b>${START_LIVES} vidas</b>: cada enemigo que llega quita ${leakCost(false, false)}, un jefe ${leakCost(true, false)} y un legendario ${leakCost(true, true)}.`,
               `Enemies follow the path to your base. Survive all <b>${WAVES.length} waves</b>. You start with <b>${START_LIVES} lives</b>: each enemy that gets through takes ${leakCost(false, false)}, a boss ${leakCost(true, false)} and a legendary ${leakCost(true, true)}.`)}</p>`
      + h('Paso a paso', 'Step by step')
      + `<ol>${[
        ['Antes de empezar eliges hasta 6 <b>favoritos</b>: salen los primeros en la tienda. Puedes comprar cualquier Pokémon de tu colección.',
         'Before starting you pick up to 6 <b>favorites</b>: they come first in the shop. You can buy any Pokémon from your collection.'],
        [`Empiezas con <b>${START_MONEY} monedas</b>. Ganas más por cada enemigo derrotado, por cada oleada superada y un extra si llamas a la siguiente antes de tiempo (botón <b>Ya</b> o tecla <kbd>N</kbd>).`,
         `You start with <b>${START_MONEY} coins</b>. You earn more for each enemy defeated, for each wave cleared, and a bonus for calling the next one early (<b>Now</b> button or <kbd>N</kbd>).`],
        ['En la <b>tienda</b> (izquierda) eliges un Pokémon y haces clic en el mapa para plantarlo. Lo rojo no se puede ocupar (el camino, la entrada, la base, junto a otra torre) y abajo te dice por qué. <kbd>Esc</kbd> o clic derecho cancelan.',
         'In the <b>shop</b> (left) pick a Pokémon and click on the map to plant it. Red areas cannot be used (the path, the entrance, the base, next to another tower) and the bar at the bottom tells you why. <kbd>Esc</kbd> or right click cancel.'],
        ['Cada torre ataca sólo a lo que está dentro de su <b>alcance</b> (el círculo que ves al colocarla).',
         'Each tower only attacks what is inside its <b>range</b> (the circle you see when placing it).'],
        [`Haz clic en una torre para <b>mejorarla</b> (hasta el nivel ${MAX_LEVEL}; en los niveles ${EVOLVE_AT.join(' y ')} <b>evoluciona</b>, y si puede evolucionar en varios, eliges), elegir <b>a quién ataca</b> (el primero, el último, el más fuerte o el más cercano) o <b>venderla</b> (te devuelven el ${pct(REFUND)} de lo gastado).`,
         `Click a tower to <b>upgrade</b> it (up to level ${MAX_LEVEL}; at levels ${EVOLVE_AT.join(' and ')} it <b>evolves</b>, and if it has several evolutions you choose), choose <b>who it attacks</b> (first, last, strongest or nearest) or <b>sell</b> it (you get back ${pct(REFUND)} of what you spent).`],
        ['Tu compañero también lucha: haz clic en él para mejorar su ataque. Si cae, se levanta a los pocos segundos.',
         'Your partner fights too: click on it to upgrade its attack. If it faints, it gets back up after a few seconds.'],
        ['El botón <b>×1/×2</b> (tecla <kbd>F</kbd>) acelera la partida.',
         'The <b>×1/×2</b> button (<kbd>F</kbd> key) speeds the game up.'],
      ].map(([a, b]) => `<li>${T(a, b)}</li>`).join('')}</ol>`
      + h('El poder de cada tipo', 'Each type\'s power')
      + `<p>${T('Además de su daño (con la tabla de tipos de los juegos), cada torre tiene un poder según el tipo de su ataque:',
               'Besides its damage (with the games\' type chart), each tower has a power depending on its attack type:')}</p>`
      + `<table class="guide-table">${types.map(t => {
        const r = ROLES[t];
        return `<tr><td>${chip(t)}</td><td><b>${esc(en() ? r.en[0] : r.name)}</b></td><td>${esc(en() ? r.en[1] : r.desc)}</td></tr>`;
      }).join('')}</table>`
      + h('Pokémon de apoyo', 'Support Pokémon')
      + `<p>${T('No atacan: dan un <b>aura</b> a las torres que tienen cerca (el anillo de su color). Al mejorarlos crece su fuerza y su radio. Dos auras de la misma clase no se suman: cuenta la más fuerte.',
               'They do not attack: they give an <b>aura</b> to nearby towers (the ring in their colour). Upgrading them raises their strength and radius. Two auras of the same kind do not stack: the strongest counts.')}</p>`
      + `<table class="guide-table">${AURA_KINDS.map(auraLine).join('')}</table>`
      + h('Las oleadas', 'The waves')
      + `<p>${T('Siempre son las mismas, y antes de cada una se anuncia su tema y una pista. Cada 5 sale un jefe y cada 10 un legendario.',
               'They are always the same, and before each one its theme and a hint are shown. Every 5th wave brings a boss and every 10th a legendary.')}</p>`
      + `<table class="guide-table waves">${WAVES.map((w, i) =>
        `<tr${w.boss ? ' class="boss"' : ''}><td>${i + 1}</td><td><b>${esc(en() ? w.en[0] : w.theme)}</b></td><td>${esc(en() ? w.en[1] : w.hint)}</td></tr>`).join('')}</table>`
      + h('Consejos', 'Tips')
      + ul([
        ['Planta en las <b>esquinas</b> del camino, por dentro de la curva: así una torre cubre dos tramos.',
         'Plant on the <b>corners</b> of the path, on the inside of the bend: one tower then covers two stretches.'],
        ['Mira la pista de la próxima oleada y compra lo que le pega fuerte. Contra los dragones de la 19 y la 27, Hielo, Dragón y Hada.',
         'Read the next wave\'s hint and buy what hits it hard. Against the dragons of waves 19 and 27: Ice, Dragon and Fairy.'],
        ['Hielo y Eléctrico paran a los enemigos: ponlos delante de las torres que más pegan.',
         'Ice and Electric stop enemies: put them in front of your hardest-hitting towers.'],
      ]);
  }

  function faq() {
    const qa: [string, string, string, string][] = [
      ['¿Es gratis?', 'Is it free?',
       'Sí. Es un juego de fans sin ánimo de lucro, sin anuncios ni compras.',
       'Yes. It is a non-profit fan game, with no ads and no purchases.'],
      ['¿Hay que descargar algo?', 'Do I need to download anything?',
       'No. Se juega en el navegador, en PC, tablet o móvil. Si quieres, puedes instalarlo como app con «Añadir a pantalla de inicio».',
       'No. It runs in the browser, on PC, tablet or phone. You can install it as an app with “Add to home screen” if you like.'],
      ['¿Está en inglés?', 'Is it in English?',
       'Sí: sale en español o en inglés según tu navegador, y se cambia en Ajustes.',
       'Yes: it shows in Spanish or English depending on your browser, and you can change it in Settings.'],
      ['¿Cuántos Pokémon hay?', 'How many Pokémon are there?',
       `${G.DEX.length} Pokémon de las 9 regiones, todos jugables como compañero y como torre.`,
       `${G.DEX.length} Pokémon from all 9 regions, all playable as a partner and as a tower.`],
      ['¿La Defensa da recompensas?', 'Does Defense give rewards?',
       'Todavía no: está en pruebas. Lo que ganas en ella (monedas y nivel) es sólo para esa partida.',
       'Not yet: it is in testing. What you earn there (coins and levels) only lasts for that game.'],
      ['¿Es un juego oficial de Pokémon?', 'Is it an official Pokémon game?',
       'No. Es un proyecto de fans, gratuito y sin ánimo de lucro, sin relación con Nintendo, GAME FREAK ni The Pokémon Company.',
       'No. It is a free, non-profit fan project, not affiliated with Nintendo, GAME FREAK or The Pokémon Company.'],
    ];
    return qa.map(([qe, qn, ae, an]) => `<h3>${T(qe, qn)}</h3><p>${T(ae, an)}</p>`).join('');
  }

  function paint() {
    const tabs = $('guide-tabs'), body = $('guide-body');
    tabs.innerHTML = TABS.map(([k, es, eng]) => `<div class="tab${k === tab ? ' on' : ''}" data-tab="${k}" translate="no">${T(es, eng)}</div>`).join('');
    tabs.querySelectorAll('.tab').forEach((el: HTMLElement) => el.onclick = () => { tab = el.dataset.tab as Tab; paint(); });
    body.innerHTML = { basics, survivor, td, faq }[tab]();
    body.scrollTop = 0;
    $('guide-title').textContent = T('Cómo se juega', 'How to play');
  }

  function init() {
    const b = $('btn-guide');
    b.innerHTML = G.Icons.html('cards', 18) + ' <span>Guía</span>';
    b.onclick = () => open();
    $('guide-close').onclick = close;
  }
  /** Abre la guía (en una pestaña concreta si se pide). */
  function open(at?: Tab) {
    if (at) tab = at;
    paint();
    $('scr-guide').classList.remove('hidden');
  }
  function close() { $('scr-guide').classList.add('hidden'); }
  const isOpen = () => !$('scr-guide').classList.contains('hidden');

  return { init, open, close, isOpen };
})();
G.GuideUI = GuideUI;

declare module '../g' {
  interface Registry { GuideUI: typeof GuideUI }
}
