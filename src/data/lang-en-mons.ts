import { G } from '../g';
/* ============ lang-en-mons.ts — Tienda Kecleon, naturalezas, habilidades y MT en inglés ============
 * Como lang-en.ts (clave: el texto en español tal como sale; {x} = hueco). Los nombres de naturalezas,
 * habilidades, objetos y la descripción de cada habilidad no van aquí: llevan su traducción al lado
 * (data/natures.ts, abilities.ts, ability-fx.ts, shop.ts).
 */
G.I18n.add({
  // menú y tienda
  'Tienda Kecleon': 'Kecleon Shop', 'Mentas, Cápsulas y MT': 'Mints, Capsules and TMs', 'Mochila: {x} objetos · {x} MT': 'Bag: {x} items · {x} TMs',
  '¡Bienvenido! Mentas, Cápsulas y MT recién llegadas.': 'Welcome! Fresh Mints, Capsules and TMs.',
  'Las MT cambian cada día: lo que ves hoy, mañana no estará.': 'TMs change every day: what you see today will be gone tomorrow.',
  'Una Menta y tu Pokémon cambia de carácter.': 'One Mint and your Pokémon changes its nature.',
  'Una Cápsula y tu Pokémon descubre otra habilidad.': 'One Capsule and your Pokémon discovers another ability.',
  '¿Buscas algo para tu compañero? Mira las MT de hoy.': 'Looking for something for your partner? Check today’s TMs.',
  'Mochila:': 'Bag:', 'MT': 'TM', 'se usan desde la ficha de cada Pokémon.': 'use them from each Pokémon’s page.',
  'Tu Mochila está vacía. Lo que compres se usa desde la ficha de cada Pokémon (Pokémon → elige uno).': 'Your bag is empty. What you buy is used from each Pokémon’s page (Pokémon → pick one).',
  'Objetos en venta': 'Items for sale', 'MT de hoy': 'Today’s TMs',
  '8 nuevas cada día (a medianoche, hora de España). Enseñan un ataque a un Pokémon para siempre; se gasta al enseñarla.':
    '8 new ones every day (at midnight, Spanish time). They teach a move to a Pokémon for good; the TM is used up when taught.',
  'Ya la llevas en la Mochila': 'Already in your bag', 'Tu compañero puede aprenderla': 'Your partner can learn it',
  'La pueden aprender {x} de tus Pokémon': '{x} of your Pokémon can learn it', 'Ninguno de tus Pokémon puede aprenderla': 'None of your Pokémon can learn it',
  'Comprado: {x}': 'Bought: {x}',
  'Esa MT ya no está a la venta.': 'That TM is no longer for sale.', 'Ya tienes esa MT en la Mochila.': 'You already have that TM in your bag.',
  'La Mochila no admite más de ese objeto.': 'The bag cannot hold any more of that item.', 'No tienes Pokémonedas suficientes.': 'Not enough PokéCoins.',
  // ficha del Pokémon
  'Naturaleza': 'Nature', 'Habilidad': 'Ability', 'neutra': 'neutral', 'Habilidad oculta': 'Hidden ability',
  'Aún no ha aprendido ninguna': 'Has not learned any yet', 'Menta': 'Mint', 'Cápsula': 'Capsule', 'Cápsula Oculta': 'Hidden Capsule', 'Enseñar MT': 'Teach TM',
  'Mentas, Cápsulas y MT se compran en la Tienda Kecleon.': 'Mints, Capsules and TMs are sold at the Kecleon Shop.',
  '{x} ahora tiene naturaleza {x}': '{x} now has the {x} nature', '{x} ahora tiene la habilidad {x}': '{x} now has the ability {x}',
  '¡{x} ha aprendido {x}!': '{x} learned {x}!',
  // segundo movimiento inicial
  'Segundo movimiento inicial': 'Second starting move',
  'Eliges el segundo ataque con el que empiezas (necesita Repertorio)': 'Choose the second move you start with (needs Repertoire)',
  'Primero compra Repertorio': 'Buy Repertoire first', 'Necesita Repertorio': 'Needs Repertoire',
  'Elige el segundo ataque con el que empieza. Lo puedes cambiar cuando quieras, gratis.': 'Choose the second move it starts with. You can change it any time, for free.',
  '{x} empezará también con {x}': '{x} will also start with {x}', 'El segundo ataque saldrá al azar': 'The second move will be random',
  // habilidades en partida
  '¡Esquiva!': 'Dodged!', '¡Robustez!': 'Sturdy!', '¡Irascible!': 'Anger Point!',
  // cooperativo: mirar a un compañero estando caído
  'Viendo a {x}': 'Watching {x}', 'Ver a un compañero': 'Watch a teammate', 'cambiar': 'switch'
});
