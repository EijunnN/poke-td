import { G } from '../g';
/* ============ changelog.js — novedades del juego ============
 * Lo que ve la gente en el botón "Novedades" de la barra de arriba: cambios
 * de juego y fallos arreglados (nada de servidores ni bases de datos).
 * La fecha más nueva, arriba. En cada fecha, por apartados:
 *   new  lo nuevo · chg  cambios y ajustes · fix  fallos arreglados
 * Cada línea en español y en inglés.
 */
/** Par [español, inglés]. */
export type Bilingual = [string, string];

/** Una fecha de novedades (ver cabecera). */
export interface ChangelogEntry {
  d: string;
  title: Bilingual;
  new?: Bilingual[];
  chg?: Bilingual[];
  fix?: Bilingual[];
}

export const CHANGELOG: ChangelogEntry[] = [
  { d: '2026-10-18', title: ['Mapas de la Defensa y menos calor', 'Defense maps and less heat'], new: [
    ['Survivor: cuando pasas tu mejor tiempo (en solitario o en grupo) sale «¡Nuevo récord!» y empieza a sonar un tema nuevo, que sigue hasta el final aunque salga un jefe.',
     'Survivor: when you beat your best time (solo or in a group) you get “New record!” and a new theme starts playing, all the way to the end, even through bosses.'],
  ], fix: [
    ['En el móvil, a veces un trozo del suelo se quedaba negro el resto de la partida (sobre todo tras salir un momento a otra app). Ahora se vuelve a pintar.',
     'On phones, a patch of the ground sometimes stayed black for the rest of the run (especially after briefly switching apps). It is now redrawn.'],
  ], chg: [
    ['Defensa: buscador por nombre o número al elegir tus favoritos y en la tienda de la partida (busca en toda la tienda, sin importar el filtro de tipo). Y un icono de chat nuevo.',
     'Defense: search by name or number when picking your favorites and in the in-game shop (it searches the whole shop, whatever the type filter). And a new chat icon.'],
    ['Resolución «Auto», ahora la de por defecto (Ajustes → Resolución): en portátiles y monitores dibuja a ×1, menos de la mitad de píxeles, y en el móvil sigue nítida. En los Mac con pantalla Retina el juego calentaba mucho el equipo; si prefieres la de antes, elige «Alta». Y algo menos de trabajo en cada fotograma (la niebla y los enemigos). Idea de joorgecamacho.',
     '“Auto” resolution, now the default (Settings → Resolution): on laptops and monitors it draws at ×1, less than half the pixels, and it stays sharp on phones. On Macs with Retina displays the game made the computer run very hot; if you prefer the old one, choose “High”. And a bit less work every frame (fog and enemies). Idea by joorgecamacho.'],
    ['Defensa: al elegir mapa se ve para cuántos jugadores va mejor y cuántos caben (Valle, 1–3; Zigzag, 1–4; Espiral, 2–5; Cruce, 2–6; Tridente, 3–8). Los de varias entradas piden más gente.',
     'Defense: when picking a map you can see how many players it suits best and how many fit (Valley, 1–3; Zigzag, 1–4; Spiral, 2–5; Crossing, 2–6; Trident, 3–8). Maps with several entrances need more people.'],
  ] },
  { d: '2026-10-17', title: ['Pausa con estadísticas, colección con buscador y arreglos', 'Stats in the pause, collection search and fixes'], new: [
    ['Pausa con pestañas: Resumen de la partida (tiempo, nivel, derrotados, jefes, movimientos y objeto), Estadísticas de tu Pokémon (con cuántas cartas de cada mejora llevas) y Daño, un medidor por movimiento (y por compañero en grupo) que también sale al acabar la partida. Las cartas de nivel dicen cuánto sube cada mejora y la barra de experiencia muestra números. Ideas de ZeroTrace, Saimon-NM y emiramirez24.',
     'The pause screen now has tabs: Summary of your run (time, level, defeated, bosses, moves and held item), Stats of your Pokémon (with how many cards of each upgrade you have) and Damage, a meter per move (and per teammate in a group) that also shows on the end screen. Level-up cards tell you how much each upgrade adds and the XP bar shows numbers. Ideas by ZeroTrace, Saimon-NM and emiramirez24.'],
    ['Colección: buscador por nombre o número, filtros combinables (tipo, rareza, generación, tengo/me faltan, shiny), nuevos órdenes y favoritos con estrella, que se ven de todas las generaciones y se guardan en tu cuenta. Idea de Saimon-NM (PR #177) y de jtvaldivia (buscador, PR #169); también la pedían guydoron23 (#154) y Oscarbm99 (#137).',
     'Collection: search by name or number, combinable filters (type, rarity, generation, owned/missing, shiny), new sort orders and starred favorites that show across all generations and are saved to your account. Idea by Saimon-NM (PR #177) and jtvaldivia (search box, PR #169); also requested by guydoron23 (#154) and Oscarbm99 (#137).'],
    ['Al pasar el ratón por un movimiento de la barra sale su ficha con tipo, daño, recarga, nivel y evolución (idea de Yoyiyoniu). Nuevo ajuste «Apuntar hacia el cursor (solo PC)»: tus ataques salen hacia donde apunta el ratón (idea de username0239409j).',
     'Hovering a move in the bar now shows its card with type, damage, cooldown, level and evolution (idea by Yoyiyoniu). New setting “Aim at the cursor (PC only)”: your attacks go where the mouse points (idea by username0239409j).'],
  ], fix: [
    ['Cambiar de movimiento y volver enseguida ya no acorta su recarga (bastaba con ir y venir para lanzarlo casi el triple de seguido). Ahora los movimientos que no usas se recargan solos, hasta que les queda un 35 %; el resto, cuando vuelves a ellos..',
     'Switching moves and switching straight back no longer shortens the cooldown (going back and forth let you cast almost three times as often). Moves you are not using now recharge on their own until 35 % is left; the rest, once you switch back to them..'],
    ['Con un jefe cerca, los ataques cuerpo a cuerpo ya no se quedan quietos esperando a tenerlo a tiro: pegan a los enemigos que tienes al lado y van a por el jefe cuando lo alcanzan (también las torres de la Defensa)..',
     'With a boss nearby, melee attacks no longer stand still waiting for it to come within reach: they hit the enemies next to you and go for the boss once it is in range (Defense towers too)..'],
    ['Grupo: si el jefe está lejos de ti, su barra y su flecha ya no se quedan señalando donde salió: el anfitrión te manda siempre su posición..',
     'Group: if the boss is far from you, its bar and arrow no longer keep pointing at where it appeared: the host always sends you its position..'],
  ] },
  { d: '2026-10-16', title: ['Arena, códigos de sala y arreglos', 'Arena, room codes and fixes'], chg: [
    ['Ideas de la comunidad del PokéSurvivor original, adaptadas: «Volver a intentarlo» al acabar una partida en solitario (Survivor o Defensa; Esc menú · Intro otra vez), de limcross. El primer objeto que recoges también se elige: equiparlo o seguir sin objeto, de eloy-garrido. Los efectos activos (Danza Espada, Agilidad…) y los poderes de altar salen como un icono con un aro que marca el tiempo que les queda, de ZeroTrace. El apuntado automático golpea los cofres pequeños cercanos, de Balhus. Y en el gacha, «Abrir sin animación» enseña el resultado al momento, de egrossetto. ¡Gracias!',
     'Community ideas from the original PokéSurvivor, adapted: “Try again” when a solo run ends (Survivor or Defense; Esc menu · Enter again), by limcross. The first item you pick up is also a choice: equip it or stay without an item, by eloy-garrido. Active effects (Swords Dance, Agility…) and altar powers show as an icon with a ring that marks the time left, by ZeroTrace. Auto-aim hits nearby small chests, by Balhus. And in the gacha, “Open without animation” shows the result right away, by egrossetto. Thanks!'],
    ['Más ideas de la comunidad: en grupo, «Volver a intentarlo» te deja listo y, cuando lo están todos, empieza otra partida sin pasar por la sala (de limcross). En el móvil, en Ajustes → Controles, el joystick puede seguir al dedo o quedarse fijo abajo a la izquierda (lo pidieron muchos; de ElChusky). Y se puede jugar con mando: stick o cruceta para moverte, botones para los ataques y las cartas, y en Ajustes puedes cambiar qué hace cada botón (de ZeroTrace).',
     'More community ideas: in a group, “Try again” marks you ready and, once everyone is, another game starts without going back to the room (by limcross). On mobile, in Settings → Controls, the joystick can follow your finger or stay fixed at the bottom left (many asked for it; by ElChusky). And you can play with a controller: stick or D-pad to move, buttons for moves and cards, and in Settings you can change what each button does (by ZeroTrace).'],
  ], fix: [
    ['Defensa: los enemigos ya no rebotan al chocar con tu héroe (con el héroe plantado en el camino se frenaba hasta a los jefes). Lo que los hace retroceder es el Agua, por el camino, y el Psíquico al confundirlos; y su animación de herido sólo sale con golpes fuertes (con tantas torres pegando, parecía que retrocedían). Tampoco sale el aviso de "un compañero puede levantarte": en la Defensa el héroe se levanta solo.',
     'Defense: enemies no longer bounce off your hero (standing on the path used to stop even bosses). What pushes them back is Water, along the path, and Psychic when it confuses them; and their hurt animation only plays on big hits (with so many towers hitting, they seemed to be pushed back). The "a teammate can revive you" notice no longer shows either: in Defense your hero gets back up on their own.'],
    ['Perfil: «Mejor tiempo» contaba también las partidas en grupo. Ahora hay dos marcas, «Mejor tiempo solo» y «Mejor tiempo en grupo» (si tu mejor marca era en grupo, la de solo empieza de nuevo).',
     'Profile: “Best time” also counted group games. Now there are two records, “Best solo time” and “Best group time” (if your best was in a group, the solo one starts over).'],
    ['Survivor: al salir de una grieta tienes 2 s de protección y los enemigos de alrededor se apartan; antes volvías en medio del grupo que te seguía.',
     'Survivor: when you leave a rift you get 2 s of protection and nearby enemies are pushed away; before, you came back in the middle of the crowd that was following you.'],
    ['Las pantallas de subir de nivel, de objeto y de vínculo ignoran las pulsaciones del primer instante: ya no eliges carta sin querer por estar cambiando de movimiento con 1-4.',
     'The level-up, item and bond screens ignore presses in the first instant: you no longer pick a card by accident while switching moves with 1-4.'],
    ['Al aprender un movimiento ya no se cambia solo a él (te podía dejar con uno que no ataca), y con la Cinta Elección ya no te quedas fijado en un movimiento de potenciar.',
     'Learning a move no longer switches to it on its own (it could leave you with one that does not attack), and with the Choice Band you no longer get stuck on a boosting move.'],
    ['Si recargas o cierras la pestaña en mitad de una partida, el navegador te pregunta antes.',
     'If you reload or close the tab in the middle of a game, the browser asks you first.'],
  ], new: [
    ['Defensa: nueva variante Arena (de 2 a 8), al estilo Line Tower Wars. Cada uno tiene su carril sin camino: los monstruos van por la ruta más corta y tus torres son el laberinto (con Sudowoodo, un muro barato); no se puede tapar el paso, y al colocar ves la ruta que quedaría. Envía monstruos al carril de tus rivales para subir tus ingresos; cada 30 s llega una oleada igual para todos. Gana el último en pie: podio con premio y su propio ranking de victorias y podios.',
     'Defense: new Arena variant (2 to 8 players), Line Tower Wars style. Everyone has a lane with no path: monsters take the shortest route and your towers are the maze (with Sudowoodo, a cheap wall); you cannot block the way, and while placing you see the route that would be left. Send monsters to your rivals’ lanes to raise your income; every 30 s a wave arrives, the same for everyone. The last one standing wins: a podium with prizes and its own ranking of wins and podiums.'],
    ['Cada sala tiene un código (p. ej. K7QM4X) y un enlace para compartir: quien lo tenga entra en la sala aunque no sea tu amigo, también si es privada. Se escribe en «Salas públicas» → «Entrar con código», o se abre el enlace.',
     'Every room has a code (e.g. K7QM4X) and a link to share: whoever has it joins the room even if they are not your friend, private rooms too. Type it in “Public rooms” → “Join with code”, or open the link.'],
    ['El anfitrión puede cambiar el código (el de antes deja de valer) y sacar a alguien de la sala antes de empezar.',
     'The host can change the code (the old one stops working) and remove someone from the room before starting.'],
  ] },
  { d: '2026-10-15', title: ['PokéTD: chat en las salas', 'PokéTD: room chat'], chg: [
    ['El juego pasa a llamarse PokéTD: tiene hordas, defensa de torres y juego en grupo. (Nació como fork de PokéSurvivor.)',
     'The game is now called PokéTD: it has hordes, tower defense and group play. (It started as a fork of PokéSurvivor.)']
  ], new: [
    ['Defensa: dos mapas nuevos con varias entradas, Cruce (2) y Tridente (3). Los enemigos salen por todas a la vez y los caminos se juntan poco antes de la base; cada jefe llega por una de ellas, y se avisa por cuál. En grupo, cada uno puede defender su entrada.',
     'Defense: two new maps with several entrances, Crossing (2) and Trident (3). Enemies come out of all of them at once and the paths join just before the base; each boss arrives through one of them, and you are told which. In a group, each player can defend their own entrance.'],
    ['Survivor en grupo: si caes, puedes mover la cámara (las teclas de andar o el joystick) para ver cómo va la partida; Tab la lleva a seguir a un compañero o vuelve a tu Pokémon.',
     'Group Survivor: when you are down you can move the camera (the movement keys or the joystick) to see how the game goes; Tab makes it follow a teammate or goes back to your Pokémon.'],
    ['Chat en las salas y en la partida en grupo: escribe lo que quieras o usa las frases rápidas («¡Ayuda!», «¡Voy!», «¡Bien jugado!»…). Lo que dice cada uno sale como bocadillo sobre su Pokémon y en unas líneas pequeñas que se apagan solas.',
     'Chat in rooms and in group games: write anything or use quick phrases ("Help!", "On my way!", "Well played!"…). What each player says shows as a bubble over their Pokémon and in a few small lines that fade on their own.'],
    ['En PC: Enter (o T) abre el chat ya para escribir, y Enter envía; V, las frases rápidas (luego 1-8). En el móvil, el botón de arriba a la derecha.',
     'On PC: Enter (or T) opens the chat ready to type, and Enter sends; V, the quick phrases (then 1-8). On mobile, the button at the top right.'],
    ['Señales en el mapa: Alt + clic (también en el minimapa de la Defensa) marca un punto para todos, con tu color, un aviso sonoro y una flecha si queda fuera de la pantalla. En el móvil, el botón 📍 y luego toca el mapa.',
     'Map pings: Alt + click (also on the Defense minimap) marks a spot for everyone, in your color, with a sound and an arrow if it is off screen. On mobile, the 📍 button and then tap the map.'],
    ['En una sala, antes de empezar, puedes elegir «Sólo mirar la partida»: la ves como espectador sin ocupar sitio de jugador ni contar para el ranking, y al acabar vuelves a la sala.',
     'In a room, before starting, you can choose "Just watch the game": you watch it as a spectator without taking a player slot or counting for the ranking, and afterwards you are back in the room.'],
    ['Toca el nombre de alguien para silenciarlo. En Ajustes puedes censurar palabrotas y enlaces (sólo en lo que ves tú), dejar sólo las frases rápidas o quitar el chat.',
     'Tap someone’s name to mute them. In Settings you can censor swear words and links (only in what you see), keep only quick phrases or turn the chat off.']
  ] },
  { d: '2026-10-14', title: ['Salas públicas y espectadores', 'Public rooms and spectators'], new: [
    ['Salas públicas: el anfitrión marca «Sala pública» y su sala sale en «Salas públicas» (en el menú), con su modo y su mapa. Cualquiera entra sin invitación ni ser amigos.',
     'Public rooms: the host ticks “Public room” and the room shows in “Public rooms” (in the menu), with its mode and map. Anyone can join without an invitation or being friends.'],
     ['Si la partida ya ha empezado, se puede mirar como espectador, en Survivor y en Defensa: la cámara sigue al jugador que elijas (Tab) y no se juega ni se gana nada.',
     'If the game has already started, you can watch it as a spectator, in Survivor and Defense: the camera follows the player you choose (Tab), and you do not play or earn anything.'],
    ['Minimapa en la Defensa: pulsa en él para mirar cualquier parte del mapa sin mover a tu héroe.',
     'Minimap in Defense: click it to look at any part of the map without moving your hero.']
  ], chg: [
    ['Defensa: tras congelar, paralizar, confundir o empujar a un enemigo, queda un momento inmune a otro de esos efectos.',
     'Defense: after freezing, paralyzing, confusing or pushing an enemy, it is briefly immune to another of those effects.'],
    ['Los curanderos ya no se curan entre ellos ni a los jefes, y cada enemigo sólo recibe una curación cada pocos segundos: un grupo de curanderos ya no es inmortal.',
     'Healers no longer heal each other or bosses, and each enemy only gets one heal every few seconds: a group of healers is no longer immortal.'],
    ['Todos los Pokémon chocan con el mismo tamaño: los grandes (Moltres, Gyarados...) ya no se atascan.',
     'Every Pokémon collides with the same size: big ones (Moltres, Gyarados...) no longer get stuck.'],
    ['Los Pokémon de 5★ que no son legendarios salen como "Élite".', '5★ Pokémon that are not legendary show as "Elite".'],
    ['Ajustes → Gráficos → Resolución: "Normal" va más fluido en móviles y portátiles. Los menús y la pausa gastan menos batería.',
     'Settings → Graphics → Resolution: "Normal" runs smoother on phones and laptops. Menus and pause use less battery.']
  ], fix: [
    ['Grupo: la partida ya no se queda parada "esperando" a alguien que ya eligió, ni con la pantalla morada al salir de la grieta.',
     'Group: the game no longer gets stuck "waiting" for someone who already chose, nor with a purple screen after the rift.'],
    ['Grupo: al salir de la grieta, los invitados ya ven a los enemigos.', 'Group: after the rift, guests can see the enemies again.'],
    ['Grupo: si cambias de Pokémon en la sala, los demás ven el nuevo.', 'Group: if you change Pokémon in the room, the others see the new one.'],
    ['Al revivir tienes 2 s de protección de verdad (antes las zonas de los jefes y las trampas te tumbaban al momento).',
     'When revived you really get 2 s of protection (boss zones and traps used to knock you out instantly).'],
    ['Un jefe lejano ya no impide que salgan grietas; una flecha señala dónde está, y si se queda muy atrás vuelve.',
     'A far-away boss no longer stops rifts from appearing; an arrow shows where it is, and if it falls far behind it comes back.'],
    ['Tóxico y Rueda Fuego (y otros rastros) juntos ya funcionan los dos.', 'Toxic and Flame Wheel (and other trails) now both work together.'],
    ['Móvil: la pantalla ya no se queda estirada al girar el teléfono, el joystick no se desplaza y la música se para al salir del juego.',
     'Mobile: the screen no longer stays stretched after rotating the phone, the joystick stays put and the music stops when you leave the game.'],
    ['Si una partida no entra en el ranking, se dice por qué.', 'If a run does not make it into the ranking, you are told why.'],
    ['Defensa: tocar un icono de ataque ya no planta ni selecciona la torre que hay debajo.', 'Defense: tapping an attack icon no longer places or selects the tower underneath.']
  ] },
  { d: '2026-10-14', title: ['Defensa en grupo', 'Group Defense'], new: [
    ['Defensa en grupo, de 2 a 4: desde una sala, el anfitrión elige Defensa y el mapa. Las vidas son de todos y las monedas de cada uno; cada torre es de quien la compra.',
     'Group Defense, for 2 to 4 players: from a room, the host chooses Defense and the map. Lives are shared and coins are each player\'s own; each tower belongs to whoever buys it.'],
    ['Tres mapas para la Defensa: Valle, Zigzag y Espiral (o uno al azar).',
     'Three maps for Defense: Valley, Zigzag and Spiral (or a random one).'],
    ['Tras ganar las 30 oleadas sigue el modo sin fin: ¿hasta dónde llegas?',
     'After winning all 30 waves, endless mode follows: how far can you go?'],
    ['La Defensa da Pokémonedas al acabar (por oleadas, derrotados y victoria), tiene misiones y logros propios, y ranking en solitario y en grupo.',
     'Defense gives Pokécoins when it ends (for waves, defeated enemies and winning), has its own missions and achievements, and solo and group leaderboards.'],
    ['Cada torre ataca a su manera: un ataque de sus tipos (proyectil, rayo, onda, órbita, minas...) que cambia al evolucionar. Con monedas puedes enseñarle hasta 2 más.',
     'Each tower attacks in its own way: an attack of its types (projectile, beam, wave, orbit, mines...) that changes when it evolves. With coins you can teach it up to 2 more.'],
    ['Trofeos: el jefe o legendario que derrotas se une a tu tienda para el resto de la partida (caro).',
     'Trophies: the boss or legendary you defeat joins your shop for the rest of the game (expensive).'],
    ['Si no tienes ningún Pokémon de apoyo de una clase, la tienda te presta uno.',
     'If you have no support Pokémon of a kind, the shop lends you one.']
  ], chg: [
    ['La Defensa se puede jugar entera en inglés.', 'Defense can be played fully in English.'],
    ['Las etiquetas de tipo se leen bien sobre cualquier color.', 'Type labels are readable on any colour.'],
    ['Los Pokémon de apoyo cuestan siempre 90 monedas, y sus auras son más fuertes y llegan más lejos: antes no compensaban.',
     'Support Pokémon always cost 90 coins, and their auras are stronger and reach further: before, they were not worth it.'],
    ['El resumen de la Defensa enseña oleadas superadas y vidas.', 'The Defense summary shows waves cleared and lives.']
  ] },
  { d: '2026-10-14', title: ['Servidores nuevos', 'New servers'], new: [
    ['Puedes cambiar tu contraseña en Ajustes → Cuenta. Si la olvidas, el administrador te pone una temporal.',
     'You can change your password in Settings → Account. If you forget it, the administrator gives you a temporary one.'],
    ['Las partidas en grupo siguen si alguien pierde la conexión un momento (o si se reinicia el servidor): al volver recupera los enemigos, el clima, la grieta y lo que ganasteis mientras no estaba.',
     'Group games carry on if someone loses connection for a moment (or the server restarts): when they come back they get the enemies, the weather, the rift and anything you won while they were away.']
  ], chg: [
    ['El juego tiene sus propios servidores: cuentas, partida guardada, ranking, amigos y partidas en grupo.',
     'The game has its own servers: accounts, saved game, leaderboard, friends and group games.'],
    ['Las cuentas son sólo de nombre y contraseña; ya no se entra con Google. No se pide correo.',
     'Accounts are name and password only; Google sign-in is gone. No email is required.'],
    ['Las partidas en grupo van por el servidor: funcionan en cualquier red y nadie ve la IP de nadie.',
     "Group games go through the server: they work on any network and nobody can see anyone else's IP."],
    ['El ranking comprueba en el servidor que cada marca sea posible.',
     'The leaderboard checks on the server that every record is possible.'],
    ['Victini, Meowscarada y Barraskewda tienen los sprites nuevos de SpriteCollab, y Barraskewda ya tiene versión shiny.',
     'Victini, Meowscarada and Barraskewda have the new SpriteCollab sprites, and Barraskewda now has a shiny version.']
  ] },
  { d: '2026-10-14', title: ['Modo Defensa', 'Defense mode'], new: [
    ['Modo Defensa, en pruebas: 30 oleadas que siguen un camino hasta tu base, cada una con su tema (bichos, voladores, fantasmas...) y una pista para defenderte. Cada 5 sale un jefe y cada 10 un legendario, hasta Mewtwo.',
     'Defense mode, in testing: 30 waves follow a path to your base, each with its theme (bugs, flyers, ghosts...) and a hint on how to defend. Every 5th wave brings a boss and every 10th a legendary, up to Mewtwo.'],
    ['Con las monedas de la partida compras en la tienda cualquier Pokémon de tu colección y lo plantas donde quieras como torre. Al mejorarlo sube su ataque y evoluciona en los niveles 3 y 5. Puedes elegir a quién ataca y venderlo.',
     'With the coins you earn in the game you buy any Pokémon from your collection in the shop and plant it anywhere as a tower. Upgrading it raises its attack and it evolves at levels 3 and 5. You can choose who it attacks and sell it.'],
    ['Cada tipo tiene su poder: Hielo congela, Fuego quema, Eléctrico paraliza, Psíquico confunde, Agua arrastra hacia atrás, Siniestro remata... y la tabla de tipos manda (Tierra no le hace nada a un volador).',
     'Each type has its power: Ice freezes, Fire burns, Electric paralyzes, Psychic confuses, Water drags back, Dark finishes off... and the type chart rules (Ground does nothing to a flyer).'],
    ['Pokémon de apoyo: no atacan, refuerzan a las torres cercanas. Scyther (Danza Espada, +daño), Togekiss (Viento Afín, +velocidad), Lucario y Absol (Foco Energía, +crítico), Meowth (Día de Pago, +monedas) y Noctowl (Vista Lince, +alcance). Dos auras iguales no se suman.',
     'Support Pokémon: they do not attack, they boost nearby towers. Scyther (Swords Dance, +damage), Togekiss (Tailwind, +speed), Lucario and Absol (Focus Energy, +crits), Meowth (Pay Day, +coins) and Noctowl (Keen Eye, +range). Two auras of the same kind do not stack.'],
    ['Al colocar una torre se ve su alcance, lo que no se puede ocupar y por qué.',
     'When placing a tower you see its range, where you cannot build and why.'],
    ['Ranking de Defensa: en la pantalla del ranking, la pestaña Defensa ordena por oleadas superadas y, a igualdad, por las vidas que te quedaban.',
     'Defense leaderboard: in the leaderboard screen, the Defense tab ranks by waves cleared and, on a tie, by the lives you had left.']
  ] },
  { d: '2026-10-13', title: ['La Sentencia de Arceus', 'The Judgment of Arceus'], new: [
    ['La Sentencia de Arceus: al llegar al minuto 30, Arceus baja del cielo y te lleva a las Ruinas del Juicio. Es invencible, te persigue cada vez más deprisa y lanza pilares de luz, rayos y ondas; si te toca, te quita casi media vida. Cada 5 segundos acude un legendario con el doble de vida y de daño que el anterior. ¿Cuánto aguantarás?',
     'The Judgment of Arceus: at minute 30, Arceus descends from the sky and takes you to the Ruins of Judgment. It is invincible, chases you faster and faster and casts pillars of light, beams and shockwaves; if it touches you, you lose almost half your HP. Every 5 seconds a legendary joins, each with twice the HP and damage of the previous one. How long can you last?'],
    ['Tres logros nuevos: La Sentencia (llega al minuto 30), Ante el Creador (aguanta 1 minuto ante Arceus) y Desafío divino (derrota a 3 legendarios ante Arceus en una partida).',
     'Three new achievements: The Judgment (reach minute 30), Before the Creator (survive 1 minute against Arceus) and Divine challenge (defeat 3 legendaries against Arceus in a single run).'],
    ['Música nueva para la pelea contra Arceus.', 'New music for the fight against Arceus.'],
    ['Botón para reportar marcas sospechosas en el ranking (la banderita de cada fila).',
     'A button to report suspicious records on the leaderboard (the little flag on each row).']
  ], chg: [
    ['El ranking histórico empieza de cero: ahora que las partidas acaban ante Arceus, las marcas de antes ya no se podrían alcanzar. Las tablas de hoy, de la semana y del mes siguen igual.',
     'The all-time leaderboard starts from scratch: now that runs end against Arceus, older records could no longer be reached. The daily, weekly and monthly boards are unchanged.'],
    ['Se quita el tiempo extra del minuto 60 (ya no se llega hasta ahí).',
     'Overtime from minute 60 is removed (runs no longer get that far).'],
    ['Desde el minuto 28 ya no se abren grietas, para que la Sentencia no te pille dentro de una.',
     'Rifts no longer open from minute 28 on, so the Judgment does not catch you inside one.'],
    ['Ranking protegido contra trampas: el servidor comprueba que cada marca se ha jugado de verdad. Nunca se pierde nada de lo que ganas jugando.',
     'Leaderboard protected against cheating: the server checks that every record was really played. You never lose anything you earn by playing.'],
    ['Se han quitado del ranking las marcas de más de 35 minutos: con la Sentencia de Arceus ya no son posibles.',
     'Records over 35 minutes have been removed from the leaderboard: with the Judgment of Arceus they are no longer possible.']
  ], fix: [
    ['Las tiradas del gacha, los Pokémon nuevos y los premios se guardan en la nube al momento. Si abriste el juego en otro aparato o navegador y te faltaba algo, vuelve a abrirlo donde lo conseguiste: se recupera solo.',
     'Gacha pulls, new Pokémon and rewards are saved to the cloud right away. If you opened the game on another device or browser and something was missing, open it again where you got it: it comes back on its own.']
  ] },
  { d: '2026-10-12', title: ['Tiempo extra y grietas con menos azar', 'Overtime and less random rifts'], new: [
    ['Tiempo extra: desde el minuto 60 los Pokémon salvajes se vuelven cada vez más fuertes (más vida y más daño), y cada vez más deprisa. Antes, con las mejoras al máximo, algunas partidas no acababan nunca; ahora las mejores rondarán la hora y media.',
     'Overtime: from minute 60 on, wild Pokémon keep getting stronger (more HP and more damage), faster and faster. Before, with maxed upgrades, some runs never ended; now the best ones will last about an hour and a half.'],
    ['El juego se actualiza solo cuando sale una versión nueva: si estás en el menú, a los 5 segundos; si estás jugando, al acabar la partida (sin perder nada).',
     'The game now updates itself when a new version is out: within 5 seconds if you are in the menu, or after your run if you are playing (without losing anything).'],
    ['Botón de Novedades (esta ventana) con todos los cambios del juego.',
     'A "What\'s new" button (this window) with every change to the game.'],
    ['Números más fáciles de leer: el 2, el 5 y el 8 ya no se confunden.',
     'Easier to read numbers: 2, 5 and 8 no longer look alike.'],
    ['Elige la versión normal o shiny de tu compañero desde el menú principal, debajo de él.',
     'Pick the normal or shiny version of your partner right from the main menu, under it.'],
    ['Mejoras nuevas para cada Pokémon: Golpe Crítico (+3 % de críticos por nivel, que hacen x1,5 de daño), Cambio de cartas (+1 cambio de las cartas de nivel por run) y Veto (bloquea movimientos para que no te salgan en las cartas; se eligen en Mejoras).',
     'New upgrades for each Pokémon: Critical Hit (+3% critical chance per level, crits deal x1.5 damage), Card reroll (+1 level-up card reroll per run) and Ban (block moves so they never show up in your cards; pick them in Upgrades).'],
    ['Atajos de movimientos (en Mejoras, para cada Pokémon): elige qué movimiento va siempre en cada hueco, por ejemplo Confusión siempre en el 1, para la memoria muscular.',
     'Move shortcuts (in Upgrades, for each Pokémon): choose which move always goes in each slot, for example Confusion always on 1, for muscle memory.']
  ], chg: [
    ['Avalancha hace menos daño (21 en vez de 26): derrotaba casi el doble que la media de los movimientos.',
     'Rock Slide deals less damage (21 instead of 26): it defeated almost twice as many as the average move.'],
    ['Los cambios de cartas de nivel ya no se ganan venciendo jefes: tienes 1 gratis por run y el resto se compra en Mejoras.',
     'Level-up card rerolls are no longer earned by defeating bosses: you get 1 free per run and can buy more in Upgrades.'],
    ['Los legendarios de grieta ya no dan siempre tickets x10: dan uno la mitad de las veces (antes daban 2 siempre y salían demasiados).',
     'Rift legendaries no longer always drop x10 tickets: they drop one half of the time (they used to always drop 2, which was too many).'],
    ['Cooperativo: si vuestras redes no consiguen conectar entre sí, la sala lo avisa y lo reintenta sola, en vez de jugar a tirones por un servidor lento.',
     'Co-op: if your networks cannot connect to each other, the room says so and keeps retrying, instead of playing laggy through a slow server.'],
    ['Hemos cambiado de servidores para que el juego siga siendo gratis: puede que tengas que volver a iniciar sesión (con la misma cuenta y contraseña, o con Google). Tu partida y tus Pokémon siguen igual.',
     'We moved to new servers so the game can stay free: you may need to sign in again (with the same account and password, or with Google). Your save and your Pokémon are unchanged.'],
    ['Gacha: los shiny ya no salen repetidos. Si te toca uno que ya tienes, sale otro de la misma rareza que te falte.',
     'Gacha: shinies no longer come out as duplicates. If you roll one you already have, you get another of the same rarity that you are missing.'],
    ['Grietas con menos azar: cada vez que no sale una, la siguiente es más probable (como mucho 2,5 minutos sin grieta).',
     'Less random rifts: every time one does not show up, the next one is more likely (at most 2.5 minutes without a rift).'],
    ['Los legendarios que aún no has vencido salen 4 veces más en las grietas.',
     'Legendaries you have not beaten yet show up 4 times as often in rifts.'],
    ['Los curanderos curan más cuanto más fuerte pegas, pero cada vez menos y con un tope (como mucho el 2,5x).',
     'Healers heal more the harder you hit, but with diminishing returns and a cap (2.5x at most).'],
    ['Ataques cuerpo a cuerpo más fuertes: mientras llevas uno activo recibes un 25 % menos de daño, llegan un 25 % más lejos y hacen un 20 % más de daño.',
     'Stronger melee attacks: while one is active you take 25% less damage, and they reach 25% further and deal 20% more damage.'],
    ['Cooperativo: al elegir con qué objeto quedarte, la partida se para para todos (antes seguía y te pegaban mientras elegías).',
     'Co-op: choosing which held item to keep now pauses the run for everyone (it used to keep going and you got hit while choosing).'],
    ['Cooperativo: mientras alguien elige una fusión, la partida se para para todos.',
     'Co-op: while someone is choosing a fusion, the run pauses for everyone.'],
    ['Cooperativo: si el anfitrión cambia de pestaña o se le para el juego, la partida se pausa para todos hasta que vuelva.',
     'Co-op: if the host switches tabs or their game stalls, the run pauses for everyone until they are back.'],
    ['Las runs de menos de 1 minuto ya no cuentan para el ranking.',
     'Runs shorter than 1 minute no longer count for the leaderboard.']
  ], fix: [
    ['Quitadas del ranking las marcas rotas por el fallo del minuto 84 (el reloj seguía corriendo con el juego parado) y alguna imposible. Si tenías una, tu próxima partida vuelve a contar.',
     'Removed broken records from the leaderboard caused by the minute 84 bug (the clock kept running while the game was frozen) and a few impossible ones. If you had one, your next run counts again.'],
    ['iPhone (Safari y Chrome): a veces no se podía cambiar de movimiento tocando los iconos, sobre todo con el otro dedo en el joystick. Además los botones quedan por encima de la barra de inicio.',
     'iPhone (Safari and Chrome): sometimes you could not switch moves by tapping the icons, especially with your other finger on the joystick. Buttons also sit above the home bar now.'],
    ['En las partidas de más de 84 minutos la pantalla se quedaba en negro, el juego se paraba o empezabas a subir de nivel sin fin. Ya puedes jugar todo lo que aguantes.',
     'In runs longer than 84 minutes the screen went black, the game froze or you kept levelling up forever. Now you can play for as long as you survive.'],
    ['Si el juego fallara, la partida se cierra sola y se guarda (tiempo, derrotados, récords y ranking) en vez de perderse.',
     'If the game ever crashes, the run ends by itself and is saved (time, defeated, records and leaderboard) instead of being lost.'],
    ['Las partidas muy largas a veces se tomaban por trampas y no contaban para el ranking.',
     'Very long runs were sometimes flagged as cheating and did not count for the leaderboard.'],
    ['Cooperativo: si el anfitrión cambiaba de pestaña, los enemigos se quedaban quietos y los demás jugaban con ventaja.',
     'Co-op: if the host switched tabs, enemies stood still and everyone else got a free advantage.'],
    ['iPhone: mantener el dedo en el joystick sacaba "Copiar / Seleccionar todo".',
     'iPhone: holding your finger on the joystick brought up "Copy / Select all".'],
    ['iPhone: a veces no salía la pantalla completa. Ahora el botón explica cómo tenerla (Compartir y "Añadir a pantalla de inicio").',
     'iPhone: fullscreen sometimes did not show up. Now the button explains how to get it (Share and "Add to Home Screen").']
  ] },
  { d: '2026-10-11', title: ['Vínculos', 'Bonds'], new: [
    ['Vínculos: al vencer a un legendario fusionas movimientos que se lanzan a la vez desde un solo hueco (hasta 4).',
     'Bonds: defeating a legendary lets you fuse moves that fire at the same time from a single slot (up to 4).'],
    ['Botón para cambiar las cartas de subir de nivel.',
     'A button to reroll the level-up cards.']
  ], chg: [
    ['Más grietas.', 'More rifts.'],
    ['Movimientos psíquicos y curanderos más flojos.', 'Weaker psychic moves and healers.'],
    ['Las mejoras de las cartas de nivel (velocidad, recarga, experiencia, imán, coraza y potencia) tienen un tope de veces.',
     'Level-up card upgrades (speed, cooldown, experience, magnet, armor and power) can only be taken a limited number of times.'],
    ['En el móvil, la ficha del Pokémon sale al lado; entrar es más rápido y el gacha x10 se puede cerrar.',
     'On mobile, the Pokémon details show alongside; logging in is faster and the x10 gacha can be closed.']
  ], fix: [
    ['Pantalla negra en partidas de más de una hora por llenarse la memoria de imágenes.',
     'Black screen in runs longer than an hour because image memory filled up.'],
    ['Los tickets se perdían si se cerraba la pestaña antes de acabar la partida: ahora se guardan al cogerlos.',
     'Tickets were lost if the tab closed before the run ended: now they are saved as soon as you pick them up.'],
    ['Una mejora comprada justo después de guardar se cobraba y no se apuntaba.',
     'An upgrade bought right after saving was charged but not applied.'],
    ['El juego se quedaba congelado para siempre si algo fallaba a mitad de partida.',
     'The game froze forever if something went wrong mid-run.']
  ] },
  { d: '2026-10-10', title: ['Más reto', 'More challenge'], new: [
    ['Jefes y legendarios con 4 ataques avisados que se enfurecen a media vida.',
     'Bosses and legendaries with 4 telegraphed attacks that get enraged at half health.'],
    ['12 movimientos nuevos y 8 formas de atacar nuevas: bumerán, cadena, minas, meteoros, torreta, embestida, rastro y abanico.',
     '12 new moves and 8 new ways to attack: boomerang, chain, mines, meteors, turret, dash, trail and spray.'],
    ['Eventos a mitad de partida (hordas de un tipo, hora dorada, Pokémon perdidos) y Meowth y Gholdengo que huyen cargados de monedas.',
     'Mid-run events (single-type hordes, golden hour, lost Pokémon) and Meowth and Gholdengo running away loaded with coins.'],
    ['Estatuas para los Pokémon grandes.', 'Statues for big Pokémon.']
  ], chg: [
    ['Más difícil: menos enemigos pero más duros.', 'Harder: fewer but tougher enemies.'],
    ['Subir de nivel es más lento, los tickets son más raros y los jefes dan ticket x10 una de cada tres veces.',
     'Levelling up is slower, tickets are rarer and bosses drop a x10 ticket one time in three.'],
    ['Carga más rápida.', 'Faster loading.']
  ], fix: [
    ['Los enemigos rezagados desaparecían delante de ti: ahora sólo fuera de la vista.',
     'Straggling enemies vanished in front of you: now only off-screen.'],
    ['Los menús y pantallas se montaban encima de la barra de arriba.',
     'Menus and screens overlapped the top bar.']
  ] },
  { d: '2026-10-09', title: ['Móvil e inglés', 'Mobile and English'], new: [
    ['Se puede jugar en móvil y tablet con joystick táctil, e instalar como app.',
     'Play on phones and tablets with a touch joystick, and install it as an app.'],
    ['El juego, en español y en inglés.', 'The game in English and Spanish.'],
    ['Pantalla de ajustes con calidad gráfica automática.', 'Settings screen with automatic graphics quality.']
  ], chg: [
    ['Menos enemigos en pantalla pero más fuertes.', 'Fewer but stronger enemies on screen.'],
    ['Gigadrenado pasa a ser Hierba Lazo (ya no cura).', 'Giga Drain becomes Grass Knot (no more healing).']
  ] },
  { d: '2026-10-08', title: ['Misiones, grietas y cooperativo', 'Missions, rifts and co-op'], new: [
    ['Misiones diarias y semanales, logros con medallas y títulos, y perfil público.',
     'Daily and weekly missions, achievements with medals and titles, and a public profile.'],
    ['Objetos equipables, evoluciones de movimientos y enemigos que curan, protegen, invocan o explotan.',
     'Held items, move evolutions and enemies that heal, shield, summon or explode.'],
    ['Grietas que llevan a 18 arenas legendarias, una por tipo, y clima que cambia la batalla.',
     'Rifts leading to 18 legendary arenas, one per type, and weather that changes the fight.'],
    ['Cooperativo con tu lista de amigos y ranking.', 'Co-op with your friends list and leaderboards.'],
    ['Mejoras para cada Pokémon, gacha tragaperras con tickets y tabla de tipos.',
     'Upgrades for each Pokémon, a slot-machine ticket gacha and a type chart.']
  ], chg: [
    ['Cámara más lejos y enemigos que rodean los obstáculos.', 'Camera further out and enemies that walk around obstacles.']
  ] },
  { d: '2026-10-07', title: ['Primera versión', 'First version'], new: [
    ['Primera versión pública de PokéSurvivor.', 'First public version of PokéSurvivor.']
  ] }
];
G.CHANGELOG = CHANGELOG;

declare module '../g' {
  interface Registry { CHANGELOG: typeof CHANGELOG }
}
