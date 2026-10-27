import { G } from '../g';
/* ============ ranking-ui.js — pantalla del ranking ============
 * Pestañas Solo / Grupo / Defensa / Defensa en grupo / Arena, periodo (diario ... histórico), todos o sólo amigos,
 * filtro por Pokémon (sólo en el histórico) y tu puesto abajo aunque no salgas
 * en el top. En Solo y Grupo se puede ordenar por tiempo o por daño a Arceus (sólo salen las marcas con daño). Las listas y los puestos los calcula el servidor (ver ranking.ts).
 * La Arena no lleva marcas sino un podio por cuenta (victorias, podios y partidas; server/arena.ts):
 * sin filtro por Pokémon ni reportes.
 */
type RankRow = Awaited<ReturnType<typeof G.Ranking.top>>[number];
type MyRank = NonNullable<Awaited<ReturnType<typeof G.Ranking.myRank>>>;
type ArenaRow = Awaited<ReturnType<typeof G.Ranking.topArena>>['rows'][number];

export const RankingUI = (() => {
  const $ = G.UI.$;
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  let mode = 's', period = 'w', scope = 'all', dex: number | null = null, sort: 't' | 'arceus' = 't';
  let token = 0;

  function init() {
    const dl = $('rk-dl');
    dl.innerHTML = G.DEX.map(p => `<option value="${esc(p.name)}">`).join('');
    $<HTMLInputElement>('rk-poke').onchange = () => {
      const v = $<HTMLInputElement>('rk-poke').value.trim().toLowerCase();
      const p = G.DEX.find(x => x.name.toLowerCase() === v);
      if (!v) { setDex(null); return; }
      if (!p) { G.UI.toast('No hay ningún Pokémon con ese nombre'); return; }
      setDex(p.dex);
    };
    $('rk-clear').onclick = () => { $<HTMLInputElement>('rk-poke').value = ''; setDex(null); };
    $('rk-mod').onclick = () => G.ModUI.open();
  }

  /** El filtro por Pokémon sólo existe en el histórico: al elegir uno se pasa a esa pestaña. */
  function setDex(d: number | null) {
    dex = d;
    if (d && period !== 'a') period = 'a';
    $('rk-clear').classList.toggle('hidden', !d);
    tabs(); load();
  }

  function open() {
    if (!G.SocialUI.needOnline()) return;
    G.UI.show('scr-rank', true);
    if (!G.Social.started) G.Social.start();
    $('rk-mod').classList.toggle('hidden', !G.Ranking.isAdmin());
    tabs();
    load();
  }

  function tabs() {
    const mk = (box: HTMLElement, items: [string, string][], cur: string, set: (k: string) => void, cls: string) => {
      box.innerHTML = '';
      for (const [k, label] of items) {
        const b = document.createElement('button');
        b.className = cls + (k === cur ? ' on' : '');
        b.innerHTML = label;
        b.onclick = () => { set(k); tabs(); load(); };
        box.appendChild(b);
      }
    };
    mk($('rk-mode'), [['s', `<b>${G.Icons.html('user', 16)} Solo</b>`], ['g', `<b>${G.Icons.html('friends', 16)} Grupo</b>`],
                      ['d', `<b>${G.Icons.html('shield', 16)} Defensa</b>`], ['e', `<b>${G.Icons.html('shield', 16)} Defensa en grupo</b>`],
                      ['a', `<b>${G.Icons.html('crown', 16)} Arena</b>`]],
       mode, k => {
         mode = k;
         // En Defensa y en la Arena no hay tablas por Pokémon ni daño a Arceus.
         if ((defense() || arena()) && dex) { dex = null; $<HTMLInputElement>('rk-poke').value = ''; $('rk-clear').classList.add('hidden'); }
         if (defense() || arena()) sort = 't';
       }, 'gen-tab');
    // Ordenar por tiempo o por daño a Arceus (sólo en el Survivor).
    $('rk-sort').classList.toggle('hidden', defense() || arena());
    mk($('rk-sort'), [['t', 'Tiempo'], ['arceus', 'Daño a Arceus']], sort, k => { sort = k as 't' | 'arceus'; }, 'chip');
    $<HTMLInputElement>('rk-poke').classList.toggle('hidden', defense() || arena());
    $('rk-what').textContent = arena() ? '· podio y victorias' : defense() ? '· oleadas superadas' : byDmg() ? '· daño a Arceus' : '· tiempo aguantado';
    mk($('rk-period'), G.Ranking.PERIODS, period, k => {
      period = k;
      if (k !== 'a' && dex) { dex = null; $<HTMLInputElement>('rk-poke').value = ''; $('rk-clear').classList.add('hidden'); }
    }, 'chip');
    mk($('rk-scope'), [['all', 'Todos'], ['friends', 'Sólo amigos']], scope, k => { scope = k; }, 'chip');
  }

  const fmtT = (t: number) => t >= 3600 ? Math.floor(t / 3600) + ':' + G.U.mmss(t % 3600).padStart(5, '0') : G.U.mmss(t);
  /** La marca: tiempo, o en Defensa la puntuación oleadas·100 + vidas (td-waves.ts, defenseScore). */
  /** ¿Pestaña de Defensa (solo o en grupo)? Su marca es una puntuación, no un tiempo. */
  const defense = () => mode === 'd' || mode === 'e';
  /** ¿Pestaña de la Arena? No tiene marcas: es un podio por cuenta. */
  const arena = () => mode === 'a';
  const fmt = (t: number) => !defense() ? fmtT(t) : G.I18n.f('Oleada {x}', Math.floor(t / 100));
  /** ¿Lista por daño a Arceus? (sólo en Solo y Grupo) */
  const byDmg = () => sort === 'arceus' && !defense() && !arena();
  const fmtDmg = (n: number) => Math.round(n).toLocaleString(G.I18n.lang === 'en' ? 'en-US' : 'es-ES');
  /** En Defensa, las vidas que quedaban. */
  const livesOf = (t: number) => t % 100;

  async function load() {
    const my = ++token;
    const list = $('rk-list');
    list.innerHTML = '<p class="sub">Cargando…</p>';
    $('rk-me').innerHTML = '';
    if (arena()) { await loadArena(my); return; }
    let rows: RankRow[] = [], me: MyRank | null = null;
    try {
      [rows, me] = await Promise.all([
        G.Ranking.top(mode, period, dex, scope === 'friends', byDmg() ? 'arceus' : 't'),
        G.Social.me ? G.Ranking.myRank(mode, period, dex, byDmg() ? 'arceus' : 't') : Promise.resolve(null)
      ]);
    } catch (e) {
      if (my !== token) return;
      const err = e as { code?: string; message?: string };
      list.innerHTML = '<p class="sub">No se pudo cargar el ranking (' + esc(err.code || err.message) + ').</p>';
      return;
    }
    if (my !== token) return;
    // El servidor dice si eres admin con cada lista: aquí ya se sabe.
    $('rk-mod').classList.toggle('hidden', !G.Ranking.isAdmin());
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = byDmg() ? '<p class="sub">Todavía no hay daño a Arceus aquí. ¡Sé el primero!</p>' : '<p class="sub">Todavía no hay marcas aquí. ¡Sé el primero!</p>';
    }
    const uid = G.Social.uid;
    const b = G.Ranking.board(mode, period, dex), done = G.Ranking.reported();
    rows.forEach((r, i) => list.appendChild(rowEl(r, i + 1, r.uids.includes(uid!), b, done)));

    // La frase se monta en cada idioma (traducirla por trozos sale rara).
    const en = G.I18n.lang === 'en';
    const pn = en ? { d: 'today', w: 'this week', m: 'this month', y: 'this year', a: 'of all time' }[period]
                  : { d: 'de hoy', w: 'de esta semana', m: 'de este mes', y: 'de este año', a: 'de siempre' }[period];
    const mon = dex ? G.DEX_BY[dex].name : '';
    const where = en ? ({ s: 'solo', g: 'group', d: 'in Defense', e: 'in group Defense' }[mode]) + (dex ? ' with ' + mon : '')
                     : ({ s: 'en solitario', g: 'en grupo', d: 'en Defensa', e: 'en Defensa en grupo' }[mode]) + (dex ? ' con ' + mon : '');
    const mine = me ? (byDmg() ? fmtDmg(me.arceus) : fmt(me.t)) : '';
    $('rk-me').innerHTML = !G.Social.me ? 'Elige un apodo (en Amigos) para salir en el ranking.'
      : me ? (en ? `<span translate="no">Your best ${where} rank ${pn}${byDmg() ? ' (damage to Arceus)' : ''}: <b class="gold">#${me.pos}</b> · ${mine}</span>`
                 : `Tu mejor puesto ${pn} ${where}${byDmg() ? ' (daño a Arceus)' : ''}: <b class="gold">#${me.pos}</b> · ${mine}`)
      : (en ? `<span translate="no">You don't have a ${where} ${byDmg() ? 'damage to Arceus' : 'record'} ${pn} yet.</span>` : `Aún no tienes ${byDmg() ? 'daño a Arceus' : 'marca'} ${pn} ${where}.`);
  }

  /** "3 victorias · 5 podios · 12 partidas" (con el singular cuando toca). */
  function arenaStats(r: ArenaRow) {
    const one = (n: number, s: string, p: string) => G.I18n.f(n === 1 ? s : p, n);
    return [one(r.wins, '{x} victoria', '{x} victorias'), one(r.podiums, '{x} podio', '{x} podios'), one(r.games, '{x} partida', '{x} partidas')].join(' · ');
  }

  async function loadArena(my: number) {
    const list = $('rk-list');
    let res: Awaited<ReturnType<typeof G.Ranking.topArena>>;
    try {
      res = await G.Ranking.topArena(period, scope === 'friends');
    } catch (e) {
      if (my !== token) return;
      const err = e as { code?: string; message?: string };
      list.innerHTML = '<p class="sub">No se pudo cargar el ranking (' + esc(err.code || err.message) + ').</p>';
      return;
    }
    if (my !== token) return;
    $('rk-mod').classList.toggle('hidden', !G.Ranking.isAdmin());
    list.innerHTML = '';
    if (!res.rows.length) list.innerHTML = '<p class="sub">Todavía no hay partidas de Arena aquí. ¡Sé el primero!</p>';
    const uid = G.Social.uid;
    res.rows.forEach((r, i) => list.appendChild(arenaRowEl(r, i + 1, r.uid === uid)));

    const en = G.I18n.lang === 'en';
    const pn = en ? { d: 'today', w: 'this week', m: 'this month', y: 'this year', a: 'of all time' }[period]
                  : { d: 'de hoy', w: 'de esta semana', m: 'de este mes', y: 'de este año', a: 'de siempre' }[period];
    const me = res.mine;
    $('rk-me').innerHTML = !G.Social.me ? 'Elige un apodo (en Amigos) para salir en el ranking.'
      : me ? (en ? `<span translate="no">Your Arena rank ${pn}: <b class="gold">#${me.pos}</b> · ${arenaStats(me)}</span>`
                 : `Tu puesto en la Arena ${pn}: <b class="gold">#${me.pos}</b> · ${arenaStats(me)}`)
      : (en ? `<span translate="no">You haven't played an Arena game ${pn} yet.</span>` : `Aún no has jugado ninguna partida de Arena ${pn}.`);
  }

  /** Una cuenta del podio de la Arena: puesto, Pokémon de su última partida, nombre y "V victorias · P podios · N partidas". */
  function arenaRowEl(r: ArenaRow, pos: number, mine: boolean) {
    const el = document.createElement('div');
    el.className = 'rk-row' + (mine ? ' mine' : '') + (pos <= 3 ? ' top' + pos : '');
    el.insertAdjacentHTML('beforeend', `<span class="pos">${pos <= 3 ? G.Icons.html('trophy', 20) : ''}${pos}</span>`);
    const mons = document.createElement('span');
    mons.className = 'mons';
    if (G.DEX_BY[r.dex]) mons.appendChild(G.UI.spriteCanvas(r.dex, 44, 40, { scale: 1, shiny: r.shiny }));
    el.appendChild(mons);
    el.insertAdjacentHTML('beforeend',
      `<span class="who"><b translate="no"><a href="#" class="plink" data-u="${esc(r.uid)}">${esc(r.name)}</a></b><small>${arenaStats(r)}</small></span>
       <span class="time">${r.wins}</span>`);
    el.querySelectorAll<HTMLAnchorElement>('.plink').forEach(a => { a.onclick = e => { e.preventDefault(); G.ProfileUI.show(a.dataset.u!); }; });
    el.appendChild(document.createElement('span'));          // (sin reportes: aquí no hay marcas que reportar)
    return el;
  }

  function rowEl(r: RankRow, pos: number, mine: boolean, b: string, done: Set<string>) {
    const el = document.createElement('div');
    el.className = 'rk-row' + (mine ? ' mine' : '') + (pos <= 3 ? ' top' + pos : '');
    el.insertAdjacentHTML('beforeend', `<span class="pos">${pos <= 3 ? G.Icons.html('trophy', 20) : ''}${pos}</span>`);
    const mons = document.createElement('span');
    mons.className = 'mons';
    r.dex.forEach((d, i) => { if (G.DEX_BY[d]) mons.appendChild(G.UI.spriteCanvas(d, 44, 40, { scale: 1, shiny: !!r.shiny[i] })); });
    el.appendChild(mons);
    el.insertAdjacentHTML('beforeend',
      `<span class="who"><b translate="no">${r.names.map((n, i) => `<a href="#" class="plink" data-u="${esc(r.uids[i] || '')}">${esc(n)}</a>`).join(' · ')}</b><small>${defense() ? G.I18n.f('{x} vidas', livesOf(r.t)) : 'Nv. ' + (r.lv || 1)} · ${(r.kills || 0).toLocaleString('es')} derrotados${!defense() && !byDmg() && r.arceus > 0 ? ' · ' + G.I18n.f('{x} de daño a Arceus', fmtDmg(r.arceus)) : ''}${byDmg() ? ' · ' + fmt(r.t) : ''}</small></span>
       <span class="time">${byDmg() ? fmtDmg(r.arceus) : fmt(r.t)}</span>`);
    el.querySelectorAll<HTMLAnchorElement>('.plink').forEach(a => { a.onclick = e => { e.preventDefault(); G.ProfileUI.show(a.dataset.u!); }; });
    // Reportar una marca sospechosa (no la tuya). Lo revisa el admin (mod-ui.js).
    if (!mine && G.Social.me) {
      const rep = document.createElement('button');
      const sent = done.has(b + '__' + r.id);
      rep.className = 'rk-rep' + (sent ? ' sent' : '');
      rep.title = sent ? 'Ya la has reportado' : 'Reportar marca sospechosa';
      rep.innerHTML = G.Icons.html('flag', 16);
      rep.onclick = async () => {
        if (rep.classList.contains('sent')) { G.UI.toast('Ya has reportado esta marca'); return; }
        if (!confirm('¿Reportar la marca de ' + r.names.join(', ') + ' como trampa?')) return;
        rep.classList.add('sent'); rep.title = 'Ya la has reportado';
        await G.Ranking.report(b, r);
        G.UI.toast('Gracias: la revisaremos');
      };
      el.appendChild(rep);
    } else el.appendChild(document.createElement('span'));
    return el;
  }

  return { init, open };
})();
G.RankingUI = RankingUI;

declare module '../g' {
  interface Registry { RankingUI: typeof RankingUI }
}
