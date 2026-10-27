import { G } from '../g';
import type { Pokemon } from '../data/pokedex';
import type { PokeType } from '../data/types';
import type { DexSearch, DexSort } from '../data/dex-query';
import type { SaveData } from '../core/db';
/* ============ menu.js — menú principal, colección y mejoras ============ */
export const MenuUI = (() => {
  const $ = G.UI.$;
  const GEN_NAMES = ['Kanto', 'Johto', 'Hoenn', 'Sinnoh', 'Teselia', 'Kalos', 'Alola', 'Galar', 'Paldea'];
  let dexQ!: DexSearch, dexSel: number | null = null;

  function init() {
    const ICON: Record<string, string> = { play: 'ball', dex: 'book', upgrades: 'up', shop: 'shop', gacha: 'ball4', goals: 'medal3', friends: 'friends', rank: 'trophy', settings: 'gear', td: 'shield', rooms: 'user' };
    document.querySelectorAll<HTMLElement>('#scr-menu [data-go]').forEach(b => {
      b.insertAdjacentHTML('afterbegin', `<span class="mi-ico">${G.Icons.html(ICON[b.dataset.go!], 26)}</span>`);
      b.dataset.sfx = b.dataset.go === 'play' || b.dataset.go === 'td' ? 'confirm' : 'click';
      b.onclick = () => {
        const go = b.dataset.go;
        if (go === 'play') { if (G.Social.room) G.LobbyUI.open(); else G.Flow.play(); }
        else if (go === 'td') G.TD.openTeam();
        else if (go === 'dex') openDex();
        else if (go === 'upgrades') openUpgrades();
        else if (go === 'shop') G.ShopUI.open();
        else if (go === 'gacha') G.GachaUI.open();
        else if (go === 'goals') G.GoalsUI.open();
        else if (go === 'friends') G.FriendsUI.open();
        else if (go === 'rooms') G.RoomsUI.open();
        else if (go === 'rank') G.RankingUI.open();
        else if (go === 'settings') G.SettingsUI.open();
      };
    });
    document.querySelectorAll<HTMLElement>('[data-back]').forEach(b => { b.onclick = open; });
    G.Social.on(() => { if (G.UI.isOpen('scr-menu')) socialLine(); });
    $('btn-logout').onclick = () => {
      if (G.DB.guest && !confirm('Eres invitado: se perderá todo el progreso. ¿Salir?')) return;
      G.Audio.music(null);
      G.DB.logout().then(() => G.Flow.toLogin());
    };
  }

  // ---------------- menú principal ----------------

  function open() {
    const s = G.DB.save;
    const mon = G.DEX_BY[s.partner!];
    const shiny = !!s.partnerShiny && G.DB.ownsShiny(mon.dex);
    G.UI.chrome(true);
    G.UI.show('scr-menu');
    G.UI.sprite($('menu-partner'), mon.dex, { lively: true, scale: 4, hero: true, shiny });
    $('menu-partner').style.setProperty('--stage-c', shiny ? '#9ae6ff' : G.U.TYPE_COLOR[mon.types[0]]);
    $('menu-partner').classList.toggle('shiny', shiny);
    $('menu-partner-name').innerHTML = mon.name + (shiny ? ' ' + G.Icons.html('shiny', 24) : '');
    $('menu-partner-info').innerHTML = G.UI.typeChips(mon.types) + ' ' + G.UI.stars(mon.rarity);
    // Normal / shiny a mano, aquí mismo (en el móvil no se encontraba en la ficha).
    const seg = $('menu-shiny');
    seg.classList.toggle('hidden', !G.DB.ownsShiny(mon.dex));
    (seg.lastChild as HTMLElement).innerHTML = G.Icons.html('shiny', 12) + ' Shiny';
    seg.querySelectorAll('button').forEach((b: HTMLButtonElement) => {
      b.classList.toggle('on', (b.dataset.v === '1') === shiny);
      b.onclick = () => {
        if ((b.dataset.v === '1') === shiny) return;
        s.partnerShiny = b.dataset.v === '1';
        G.DB.commit();
        G.Social.refreshMember();             // si hay sala, los demás ven el sprite nuevo
        G.Audio.sfx('confirm');
        open();
      };
    });

    const owned = Object.keys(s.owned).filter(d => G.DEX_BY[+d]).length;
    const shinies = Object.keys(s.shiny || {}).length;
    $('menu-dex-count').textContent = `${owned} / ${G.DEX.length}` + (shinies ? ` · ${shinies} shiny` : '');
    // Tienda Kecleon: lo que llevas en la Mochila.
    const sum = (o?: Record<string, number>) => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0);
    const bag = sum(s.bag), tms = sum(s.tms);
    $('menu-shop-sub').textContent = bag || tms ? G.I18n.f('Mochila: {x} objetos · {x} MT', bag, tms) : 'Mentas, Cápsulas y MT';

    const st = s.stats;
    $('menu-stats').innerHTML =
      `Runs <b style="color:#fff">${st.runs}</b> · Mejor tiempo <b style="color:#fff">${G.U.mmss(st.bestTime)}</b><br>` +
      `Mejor nivel <b style="color:#fff">${st.bestLevel}</b> · Derrotados <b style="color:#fff">${st.totalKills.toLocaleString('es')}</b>` +
      (G.DB.guest ? '<br><span style="color:#ffb0b8">Modo invitado: no se guarda</span>' : '');

    socialLine();
    // Premios de misiones por recoger.
    G.Progress.checkAch();
    const pend = G.Progress.pending();
    $('menu-goals-sub').textContent = pend ? pend + (pend === 1 ? ' premio por recoger' : ' premios por recoger') : 'Misiones, logros y perfil';
    $('menu-goals-sub').classList.toggle('gold', pend > 0);
    // Con cuenta en la nube: amigos en línea, invitaciones y (una vez) el apodo.
    if (G.DB.online && !G.Social.started) {
      G.Social.start().then(r => {
        if (r === 'need-nick' && !G.NickUI.skipped && G.UI.isOpen('scr-menu')) G.NickUI.open();
        socialLine();
      });
    }
    G.InvitePop.refresh();
    G.RoomsUI.takeLink();
  }

  /** Texto bajo "Amigos" y "Jugar": quién está en línea, solicitudes, sala. */
  function socialLine() {
    const room = G.Social.room;
    const play = document.querySelector('#scr-menu [data-go=play] small');
    if (play) play.textContent = room ? 'Volver a tu sala (' + room.members.length + '/' + room.max + ')' : 'Entra en la mazmorra';
    const fr = G.Social.friends;
    const on = fr.filter(f => f.status === 'ok' && f.online).length;
    const req = fr.filter(f => f.status === 'in').length;
    const parts = [];
    if (on) parts.push(on + ' en línea');
    if (req) parts.push(req + (req === 1 ? ' solicitud' : ' solicitudes'));
    $('menu-friends-sub').textContent = parts.length ? parts.join(' · ') : 'Juega en grupo, hasta 4';
    $('menu-friends-sub').classList.toggle('gold', req > 0);
  }

  // ---------------- colección ----------------
  // Buscador, filtros y orden: la lógica está en data/dex-query.ts. La barra se monta una vez
  // (si no, el campo de búsqueda perdería el foco a cada letra) y cada cambio repinta lo que toque.

  const SORT_LABEL: Record<DexSort, string> = {
    num: 'Número', name: 'Nombre', rarity: 'Rareza', recent: 'Recién conseguidos', hp: 'Vida', atk: 'Ataque', spd: 'Velocidad',
  };
  const GRID_CHUNK = 72;         // celdas que se pintan de golpe; el resto, al bajar (cada una lleva un sprite animado)
  let dexBuilt = false, dexAdvOpen = false, searchT = 0;
  let dexList: Pokemon[] = [], dexShown = 0;

  function openDex() {
    G.UI.show('scr-dex', true);
    const s = G.DB.save;
    if (dexSel == null) dexSel = s.partner!;
    if (!dexBuilt) buildDexBar();
    refreshDex();
    showDetail(dexSel);
  }

  function buildDexBar() {
    dexBuilt = true;
    const q = dexQ = G.DexQuery.blank();
    q.gen = G.DEX_BY[G.DB.save.partner!].gen;      // la primera vez, la pestaña de tu compañero
    $('dex-tools').innerHTML = `
      <input class="field dex-search" type="search" placeholder="Buscar por nombre o número…" aria-label="Buscar"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <select class="field dex-sort" aria-label="Ordenar por">${G.DexQuery.SORTS.map(k => `<option value="${k}">${SORT_LABEL[k]}</option>`).join('')}</select>`;
    const search = $('dex-tools').querySelector<HTMLInputElement>('.dex-search')!;
    const sort = $('dex-tools').querySelector<HTMLSelectElement>('.dex-sort')!;
    search.oninput = () => {
      clearTimeout(searchT);
      searchT = window.setTimeout(() => {
        q.text = search.value;
        if (q.text.trim()) q.gen = 0;           // buscar es en toda la colección, no sólo en la pestaña abierta
        refreshDex();
      }, 140);
    };
    search.onkeydown = e => {
      if (e.key === 'Enter') search.blur();     // en el móvil, cierra el teclado
      else if (e.key === 'Escape' && search.value) { search.value = ''; q.text = ''; clearTimeout(searchT); refreshDex(); e.stopPropagation(); }
    };
    sort.onchange = () => { q.sort = sort.value as DexSort; G.Audio.sfx('select'); refreshDex(); };

    $('dex-gens').onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-g]');
      if (b) { q.gen = +b.dataset.g!; refreshDex(); }
    };
    $('dex-filters').onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
      if (!b) return;
      const k = b.dataset.k!;
      if (k === 'own' || k === 'miss') q.own = q.own === k ? 'all' : k;
      else if (k === 'shiny') q.shiny = !q.shiny;
      else if (k === 'fav') { q.fav = !q.fav; if (q.fav) q.gen = 0; }   // los favoritos se ven de todas las generaciones
      else if (k === 'clear') G.DexQuery.clear(q);
      else if (k === 'adv') { dexAdvOpen = !dexAdvOpen; paintDexBar(); return; }
      refreshDex();
    };

    // Rareza y tipo (varios a la vez): plegado, para que la rejilla tenga sitio en el móvil apaisado.
    $('dex-adv').innerHTML =
      `<div class="filters"><small class="sub">Rareza</small>${[5, 4, 3, 2, 1].map(r =>
        `<button class="chip" data-k="r:${r}">${G.Icons.rarity(r, 12)} ${G.Gacha.RARITY_NAME[r]}</button>`).join('')}</div>
       <div class="filters"><small class="sub">Tipo</small>${Object.keys(G.U.TYPE_NAME).map(t =>
        `<button class="chip" data-k="t:${t}"><i class="tdot" style="background:${G.U.TYPE_COLOR[t as PokeType]}"></i> ${G.U.TYPE_NAME[t as PokeType]}</button>`).join('')}</div>`;
    $('dex-adv').onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
      if (!b) return;
      const [kind, v] = b.dataset.k!.split(':');
      const list: (number | string)[] = kind === 'r' ? q.rarity : q.types;
      const val = kind === 'r' ? +v : v, i = list.indexOf(val);
      if (i >= 0) list.splice(i, 1); else list.push(val);
      refreshDex();
    };

    $('dex-grid').onscroll = () => {
      const g = $('dex-grid');
      if (dexShown < dexList.length && g.scrollTop + g.clientHeight > g.scrollHeight - 400) fillGrid(dexShown + GRID_CHUNK);
    };
  }

  /** Repinta la barra (pestañas, orden, chips) y la rejilla. `keep`: sin volver arriba. */
  function refreshDex(keep = false) {
    renderGrid(keep);
    paintDexBar();
  }

  function paintDexBar() {
    const s = G.DB.save, q = dexQ;
    const owned = Object.keys(s.owned).filter(d => G.DEX_BY[+d]).length;
    $('dex-total').textContent = `${owned} / ${G.DEX.length}`;

    // Pestañas de generación (la primera, todas), con cuántos tienes de cada una.
    const tabs = $('dex-gens');
    tabs.innerHTML = ['Todas', ...GEN_NAMES].map((name, g) => {
      const mine = g ? G.DEX.filter(p => p.gen === g) : G.DEX;
      const have = mine.filter(p => s.owned[p.dex]).length;
      return `<button class="gen-tab${g === q.gen ? ' on' : ''}" data-g="${g}"><b>${name}</b><small>${have}/${mine.length}</small></button>`;
    }).join('');
    const on = tabs.querySelector<HTMLElement>('.on');
    if (on) tabs.scrollLeft = Math.max(0, on.offsetLeft - tabs.clientWidth / 2 + on.offsetWidth / 2);

    const search = $('dex-tools').querySelector<HTMLInputElement>('.dex-search')!;
    if (search.value !== q.text) search.value = q.text;
    $('dex-tools').querySelector<HTMLSelectElement>('.dex-sort')!.value = q.sort;

    const favs = G.DexQuery.favCount(s), adv = q.rarity.length + q.types.length;
    const chip = (k: string, html: string, onNow: boolean) => `<button class="chip${onNow ? ' on' : ''}" data-k="${k}">${html}</button>`;
    const scope = q.gen ? G.DEX.filter(p => p.gen === q.gen).length : G.DEX.length;
    $('dex-filters').innerHTML =
      chip('own', 'Tengo', q.own === 'own') + chip('miss', 'Me faltan', q.own === 'miss') +
      chip('shiny', G.Icons.html('shiny', 12) + ' Shiny', q.shiny) +
      chip('fav', G.Icons.html('star', 12) + ' <span>Favoritos</span>' + (favs ? ` <small>${favs}</small>` : ''), q.fav) +
      chip('adv', `<span>Filtros</span>${adv ? ` <small>${adv}</small>` : ''} <i class="car">${dexAdvOpen ? '▴' : '▾'}</i>`, adv > 0) +
      (G.DexQuery.active(q) ? chip('clear', 'Limpiar', false) + `<span class="dex-count">Mostrando ${dexList.length} de ${scope}</span>` : '');
    $('dex-adv').classList.toggle('hidden', !dexAdvOpen);
    $('dex-adv').querySelectorAll<HTMLElement>('[data-k]').forEach(b => {
      const [kind, v] = b.dataset.k!.split(':');
      b.classList.toggle('on', kind === 'r' ? q.rarity.includes(+v) : q.types.includes(v));
    });
  }

  function renderGrid(keep = false) {
    const s = G.DB.save, grid = $('dex-grid');
    const top = keep ? grid.scrollTop : 0, want = keep ? Math.max(GRID_CHUNK, dexShown) : GRID_CHUNK;
    dexList = G.DexQuery.run(dexQ, s);
    dexShown = 0;
    grid.innerHTML = '';
    if (!dexList.length) {
      const none = dexQ.fav && !G.DexQuery.favCount(s) ? 'Aún no tienes favoritos: marca la estrella en la ficha de un Pokémon.' : 'Ninguno con este filtro.';
      grid.innerHTML = `<p class="sub" style="grid-column:1/-1">${none}</p>`;
      return;
    }
    fillGrid(want);
    grid.scrollTop = top;
  }

  /** Pinta celdas hasta la nº `upTo` y, si la rejilla aún no llena el hueco, algo más (para poder bajar). */
  function fillGrid(upTo: number) {
    const s = G.DB.save, grid = $('dex-grid');
    const add = (to: number) => { for (; dexShown < Math.min(to, dexList.length); dexShown++) grid.appendChild(makeCell(dexList[dexShown], s)); };
    add(upTo);
    while (dexShown < dexList.length && grid.clientHeight > 0 && grid.scrollHeight <= grid.clientHeight + 40) add(dexShown + GRID_CHUNK);
  }

  function makeCell(p: Pokemon, s: SaveData) {
    const own = !!s.owned[p.dex], sh = !!(s.shiny && s.shiny[p.dex]);
    const cell = document.createElement('div');
    cell.className = 'cell' + (own ? '' : ' locked') + (p.dex === dexSel ? ' on' : '');
    cell.insertAdjacentHTML('beforeend', `<span class="no">${String(p.dex).padStart(3, '0')}</span>`);
    if (G.DexQuery.isFav(s, p.dex)) cell.insertAdjacentHTML('beforeend', `<span class="fav-mark" title="Favorito">${G.Icons.html('star', 12)}</span>`);
    if (p.dex === s.partner) cell.insertAdjacentHTML('beforeend', `<span class="badge-r" title="Compañero">${G.Icons.html('crown', 14)}</span>`);
    else if (sh) cell.insertAdjacentHTML('beforeend', `<span class="badge-r" title="Tienes su shiny">${G.Icons.html('shiny', 12)}</span>`);
    const useShiny = sh && p.dex === s.partner && s.partnerShiny;
    cell.appendChild(G.UI.spriteCanvas(p.dex, 92, 80, { scale: 2, silhouette: !own, shadow: own, shiny: useShiny }));
    cell.insertAdjacentHTML('beforeend', `<b>${own ? p.name : '???'}</b>${G.UI.stars(p.rarity, 9)}`);
    cell.onclick = () => {
      dexSel = p.dex;
      $('dex-grid').querySelectorAll('.cell').forEach((c: Element) => c.classList.remove('on'));
      cell.classList.add('on');
      showDetail(p.dex);
    };
    return cell;
  }

  // Variante que se está viendo en la ficha (normal o shiny).
  let viewShiny = false;
  let lastDetail: number | undefined;

  function showDetail(dex: number) {
    const s = G.DB.save;
    const p = G.DEX_BY[dex];
    const own = !!s.owned[dex];
    const hasSh = G.DB.ownsShiny(dex);
    const isPartner = dex === s.partner;
    if (!hasSh) viewShiny = false;
    else if (isPartner && dex !== lastDetail) viewShiny = !!s.partnerShiny;
    if (dex !== lastDetail) extraOpen = '';
    // Al redibujar el mismo Pokémon (abrir el selector de una Menta, enseñar una MT...) no se vuelve arriba.
    const scrolls = dex === lastDetail ? [$('dex-detail'), $('dex-detail').closest<HTMLElement>('.box')].filter((el): el is HTMLElement => !!el).map(el => [el, el.scrollTop] as const) : [];
    lastDetail = dex;

    const max = { hp: 183, stat: 160, spd: 137 };
    const [sAtk, sSpa, sDef, sSpd] = G.statsOf(dex);
    // Con su naturaleza: lo que sube, en verde y con ▲; lo que baja, en rojo y con ▼.
    const nat = own ? G.Mons.natureOf(dex) : null;
    const bar = (label: string, v: number, m: number, txt: string | number, k?: string) => {
      const cls = !nat || !k ? '' : nat.up === k ? ' nat-up' : nat.down === k ? ' nat-down' : '';
      const mark = cls ? (cls === ' nat-up' ? ' ▲' : ' ▼') : '';
      return `<div class="stat${cls}"><span>${label}${mark}</span><div class="bar"><i style="width:${Math.min(100, v / m * 100)}%"></i></div><span>${txt}</span></div>`;
    };
    const usingThis = isPartner && (!hasSh || !!s.partnerShiny === viewShiny);
    const fav = G.DexQuery.isFav(s, dex);

    const box = $('dex-detail');
    box.innerHTML = `
      <canvas id="dex-big" class="stage" width="220" height="190"></canvas>
      ${hasSh ? `<div class="seg">
          <button class="${viewShiny ? '' : 'on'}" data-v="0">Normal</button>
          <button class="${viewShiny ? 'on' : ''}" data-v="1">${G.Icons.html('shiny', 12)} Shiny</button></div>` : ''}
      <div class="center">
        <div style="color:var(--muted);font-size:13px">Nº ${String(p.dex).padStart(3, '0')} · ${GEN_NAMES[p.gen - 1]}</div>
        <h3>${own ? p.name : '???'} <button id="dex-fav" class="fav-btn${fav ? ' on' : ''}" aria-pressed="${fav}" data-sfx="none"
          title="${fav ? 'Quitar de favoritos' : 'Marcar como favorito'}">${G.Icons.html(fav ? 'star' : 'starDim', 20)}</button></h3>
        <div style="color:${G.Gacha.RARITY_COLOR[p.rarity]}">${G.UI.stars(p.rarity, 24)} ${G.Gacha.rarityLabel(p.rarity, p.dex)}</div>
        <div style="margin:6px 0">${own ? G.UI.typeChips(p.types) : ''}</div>
      </div>
      ${own ? `
        ${bar('Vida', p.hp, max.hp, p.hp)}
        ${bar('Ataque', sAtk, max.stat, sAtk, 'pa')}
        ${bar('At. Esp.', sSpa, max.stat, sSpa, 'sa')}
        ${bar('Defensa', sDef, max.stat, sDef, 'df')}
        ${bar('Def. Esp.', sSpd, max.stat, sSpd, 'sd')}
        ${bar('Velocidad', p.spd, max.spd, p.spd, 'spd')}
        ${monExtras(dex)}
        ${p.types.length === 1 ? `<p class="sub center" style="margin:8px 0 0">Monotipo: +20 % de daño con sus ataques de tipo ${G.U.TYPE_NAME[p.types[0]]}</p>` : ''}
        <p style="font-size:14px;margin:10px 0 4px">Empieza con <b class="gold">${G.Moves.BY_ID[G.startMoveOf(dex)].name}</b></p>
        <p class="move-icons" title="Movimientos que puede aprender">
          ${G.Moves.poolFor(p, true).map(id => { const d = G.Moves.BY_ID[id];
            return `<span title="${G.T(d.name) + (d.cat ? ' · ' + G.T(G.Moves.CAT_NAME[d.cat]) : '')}">${G.Icons.html('move:' + id, 16)}</span>`; }).join('')}</p>
        ${usingThis
          ? '<button class="btn grow" disabled style="width:100%">Es tu compañero</button>'
          : `<button id="dex-pick" class="btn gold" data-sfx="confirm" style="width:100%">Elegir de compañero${viewShiny ? ' (shiny)' : ''}</button>`}
      ` : `<p class="center" style="color:var(--muted)">Aún no lo tienes.<br>Consíguelo en el banner de <b class="gold">${GEN_NAMES[p.gen - 1]}</b>
            o derrotándolo cuando salga shiny.</p>`}
    `;
    for (const [el, top] of scrolls) el.scrollTop = top;
    $('dex-big').style.setProperty('--stage-c', !own ? '#5b83d6' : viewShiny ? '#9ae6ff' : G.U.TYPE_COLOR[p.types[0]]);
    $('dex-big').classList.toggle('shiny', own && viewShiny);
    G.UI.sprite($('dex-big'), dex, { lively: own, spin: own, silhouette: !own, scale: 3, hero: true, shiny: own && viewShiny });
    box.querySelectorAll<HTMLElement>('.seg button').forEach(b => {
      b.onclick = () => { viewShiny = b.dataset.v === '1'; showDetail(dex); };
    });
    $('dex-fav').onclick = () => {
      G.DexQuery.toggleFav(s, dex);
      G.DB.commit();
      G.Audio.sfx('select');
      refreshDex(true);                 // con "sólo favoritos" la ficha sale de la lista, pero se queda a la vista
      showDetail(dex);
    };
    const pick = $('dex-pick');
    if (pick) pick.onclick = () => {
      s.partner = dex;
      s.partnerShiny = hasSh && viewShiny;
      G.DB.commit();
      G.Social.refreshMember();
      G.UI.toast(p.name + (s.partnerShiny ? ' shiny' : '') + ' es ahora tu compañero');
      renderGrid(true); showDetail(dex);
    };
    if (own) wireExtras(dex, box);
  }

  // ---------------- naturaleza, habilidad y MT (Tienda Kecleon) ----------------
  // Se ven en la ficha de cada Pokémon y aquí se gastan la Menta, las Cápsulas y las MT de la Mochila.
  const STAT_NAME: Record<string, string> = { pa: 'Ataque', sa: 'At. Esp.', df: 'Defensa', sd: 'Def. Esp.', spd: 'Velocidad' };
  let extraOpen = '';          // 'nat' | 'cap' | 'caph' | 'tm' | '' (qué selector está abierto)
  const natLine = (n: { up: string; down: string }) => (n.up ? `+${G.T(STAT_NAME[n.up])} −${G.T(STAT_NAME[n.down])}` : G.T('neutra'));
  /** Un nombre ya en el idioma del juego: que la traducción automática no lo toque. */
  const raw = (t: string) => `<span translate="no">${t}</span>`;

  function monExtras(dex: number): string {
    const p = G.DEX_BY[dex], n = G.Mons.natureOf(dex), ab = G.Mons.abilityOf(dex);
    const fx = G.AbilityFX.of(ab.id, p), taught = G.Mons.taught(dex);
    const tmsHere = G.Mons.learnable(dex).filter(id => G.Shop.tmCount(id) > 0);
    const btn = (key: string, icon: string, label: string, count: number) => count > 0
      ? `<button class="btn small" data-extra="${key}">${G.Icons.html(icon, 14)} <span>${label}</span> <small>×${count}</small></button>` : '';
    const capN = G.Mons.abilityChoices(dex, false).length ? G.Shop.count('cap') : 0;
    const caphN = G.Mons.abilityChoices(dex, true).length ? G.Shop.count('caph') : 0;
    const none = !G.Shop.count('mint') && !capN && !caphN && !tmsHere.length;
    return `<div class="mon-extra">
      <div class="mx-row"><span>Naturaleza</span><b>${raw(G.Mons.name(n.n))}</b><small>${natLine(n)}</small>
        ${btn('nat', 'mint', 'Menta', G.Shop.count('mint'))}</div>
      <div class="mx-row"><span>Habilidad</span><b>${raw(G.Mons.abilityName(ab.id))}</b>${ab.slot === 2 ? `<small class="gold">${G.T('Habilidad oculta')}</small>` : ''}
        ${btn('cap', 'capsule', 'Cápsula', capN)}${btn('caph', 'capsuleh', 'Cápsula Oculta', caphN)}</div>
      <p class="sub mx-desc">${raw(G.AbilityFX.describe(fx))}</p>
      <div class="mx-row"><span>MT</span>${taught.length
        ? `<span class="move-icons">${taught.map(id => `<span title="${G.Moves.BY_ID[id].name}">${G.Icons.html('move:' + id, 16)}</span>`).join('')}</span>`
        : `<small>${G.T('Aún no ha aprendido ninguna')}</small>`}
        ${btn('tm', 'tm', 'Enseñar MT', tmsHere.length)}</div>
      ${none ? `<p class="sub mx-desc">Mentas, Cápsulas y MT se compran en la Tienda Kecleon.</p>` : ''}
      <div id="mx-picker"></div>
    </div>`;
  }

  function wireExtras(dex: number, box: HTMLElement) {
    box.querySelectorAll<HTMLElement>('[data-extra]').forEach(b => {
      b.onclick = () => { extraOpen = extraOpen === b.dataset.extra ? '' : b.dataset.extra!; G.Audio.sfx('select'); showDetail(dex); };
    });
    const host = box.querySelector<HTMLElement>('#mx-picker');
    if (!host || !extraOpen) return;
    const mon = G.DEX_BY[dex];
    const chips = (list: { v: string; html: string }[], onPick: (v: string) => void) => {
      host.innerHTML = `<div class="panel ban-picker"><div class="ban-moves">${list.map(x => `<button class="chip" data-v="${x.v}">${x.html}</button>`).join('')}</div></div>`;
      host.querySelectorAll<HTMLElement>('[data-v]').forEach(c => { c.onclick = () => onPick(c.dataset.v!); });
    };
    const done = (msg: string) => { extraOpen = ''; G.DB.commit(true); G.Audio.sfx('buy'); G.UI.toast(msg, 2600); showDetail(dex); };
    if (extraOpen === 'nat' && G.Shop.count('mint')) {
      const cur = G.Mons.natureOf(dex).id;
      chips(G.NATURES.filter(n => n.id !== cur).map(n => ({ v: n.id, html: `<b>${raw(G.Mons.name(n.n))}</b> <small>${natLine(n)}</small>` })), id => {
        if (!G.Shop.take('mint')) return;
        G.Mons.setNature(dex, id);
        done(G.I18n.f('{x} ahora tiene naturaleza {x}', mon.name, G.Mons.name(G.NATURE_BY[id].n)));
      });
    } else if ((extraOpen === 'cap' || extraOpen === 'caph') && G.Shop.count(extraOpen)) {
      const l = G.Mons.slots(dex), kind = extraOpen;
      chips(G.Mons.abilityChoices(dex, kind === 'caph').map(i => ({ v: String(i), html: `<b>${raw(G.Mons.abilityName(l[i]))}</b>${i === 2 ? ` <small class="gold">${G.T('Habilidad oculta')}</small>` : ''}` })), v => {
        if (!G.Shop.take(kind)) return;
        G.Mons.setAbility(dex, +v);
        done(G.I18n.f('{x} ahora tiene la habilidad {x}', mon.name, G.Mons.abilityName(l[+v])));
      });
    } else if (extraOpen === 'tm') {
      const list = G.Mons.learnable(dex).filter(id => G.Shop.tmCount(id) > 0);
      chips(list.map(id => ({ v: id, html: `${G.Icons.html('move:' + id, 16)} ${G.Moves.BY_ID[id].name}` })), id => {
        if (!G.Mons.teach(dex, id)) return;
        done(G.I18n.f('¡{x} ha aprendido {x}!', mon.name, G.T(G.Moves.BY_ID[id].name)));
      });
    }
  }

  // ---------------- mejoras ----------------

  let upgDex!: number;    // el Pokémon elegido en la pantalla de mejoras

  function openUpgrades() {
    G.UI.show('scr-upgrades', true);
    const s = G.DB.save;
    if (!upgDex || !s.owned[upgDex]) upgDex = s.partner!;
    // Selector con tus Pokémon: el compañero primero, luego los que ya tienen mejoras.
    const sel = $<HTMLSelectElement>('upg-mon');
    const lv = (d: number) => (Object.values(s.pupg[d] || {}) as number[]).reduce((a, b) => a + b, 0);
    const mons = Object.keys(s.owned).map(Number).filter(d => G.DEX_BY[d])
      .sort((a, b) => Number(b === s.partner) - Number(a === s.partner) || lv(b) - lv(a) || a - b);
    sel.innerHTML = mons.map(d => `<option value="${d}">${G.DEX_BY[d].name}${d === s.partner ? ' (compañero)' : ''}${lv(d) ? ' · ' + lv(d) + ' niveles' : ''}</option>`).join('');
    sel.value = String(upgDex);
    sel.onchange = () => { upgDex = +sel.value; G.Audio.sfx('select'); renderUpgrades(); };
    renderUpgrades();
  }

  function renderUpgrades() {
    const s = G.DB.save;
    const levels = G.DB.upgradesOf(upgDex);
    const mon = G.DEX_BY[upgDex];
    const shiny = upgDex === s.partner && !!s.partnerShiny && G.DB.ownsShiny(upgDex);
    G.UI.sprite($('upg-stage'), upgDex, { lively: true, scale: 2, hero: true, shiny });
    $('upg-stage').style.setProperty('--stage-c', shiny ? '#9ae6ff' : G.U.TYPE_COLOR[mon.types[0]]);
    const box = $('upg-list');
    box.innerHTML = '';
    for (const u of G.Upgrades.LIST) {
      const lvl = levels[u.id] || 0;
      const maxed = lvl >= u.max;
      const cost = maxed ? 0 : G.Upgrades.cost(u.id, lvl);
      // Mejoras que necesitan otra (Segundo movimiento inicial → Repertorio).
      const locked = !maxed && !!u.needs && !levels[u.needs];
      const pick2 = u.id === 'start2' && lvl > 0 ? G.startMove2Of(upgDex) : null;
      const el = document.createElement('div');
      el.className = 'panel upg-item';
      el.innerHTML = `
        <div class="ic">${G.Icons.html(u.icon, 32)}</div>
        <div>
          <b>${u.name}</b> <span style="color:var(--muted);font-size:13px">${u.unit}</span>
          <div class="pips">${Array.from({ length: u.max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div>
        </div>
        <div class="upg-btns">
          ${u.id === 'ban' && lvl > 0 ? `<button class="btn small" data-ban>Elegir (${banList().length}/${lvl})</button>` : ''}
          ${u.id === 'start' && lvl > 0 ? `<button class="btn small" data-start>Elegir: ${G.Moves.BY_ID[G.startMoveOf(upgDex)].name}</button>` : ''}
          ${u.id === 'start2' && lvl > 0 ? `<button class="btn small" data-start2>Elegir: ${pick2 ? G.Moves.BY_ID[pick2].name : G.T('Al azar')}</button>` : ''}
          <button class="btn small ${maxed ? '' : 'gold'}" data-buy data-sfx="none" ${maxed || locked || s.coins < cost ? 'disabled' : ''}
            ${locked ? `title="${G.T('Primero compra Repertorio')}"` : ''}>
          ${maxed ? 'Máx.' : locked ? G.T('Necesita Repertorio') : `<span class="coin"></span> ${cost}`}</button></div>`;
      if (u.id === 'ban' && lvl > 0) el.querySelector<HTMLElement>('[data-ban]')!.onclick = () => { banOpen = !banOpen; renderUpgrades(); };
      if (u.id === 'start' && lvl > 0) el.querySelector<HTMLElement>('[data-start]')!.onclick = () => { startOpen = !startOpen; renderUpgrades(); };
      if (u.id === 'start2' && lvl > 0) el.querySelector<HTMLElement>('[data-start2]')!.onclick = () => { start2Open = !start2Open; renderUpgrades(); };
      el.querySelector<HTMLElement>('[data-buy]')!.onclick = () => {
        // Se vuelve a leer todo al pulsar (la partida puede haber cambiado desde que se dibujó).
        const sv = G.DB.save, lv = G.DB.upgradesOf(upgDex), now = lv[u.id] || 0;
        if (now >= u.max || (u.needs && !lv[u.needs])) { renderUpgrades(); return; }
        const price = G.Upgrades.cost(u.id, now);
        if (sv.coins < price) { renderUpgrades(); return; }
        sv.coins -= price;
        lv[u.id] = now + 1;
        G.DB.commit(true);
        G.Audio.sfx('buy');
        G.UI.refreshCoins();
        G.UI.toast(`${mon.name} · ${u.name}: nivel ${now + 1}`);
        renderUpgrades();
      };
      box.appendChild(el);
      if (u.id === 'ban' && lvl > 0 && banOpen) box.appendChild(banPicker(lvl));
      if (u.id === 'start' && lvl > 0 && startOpen) box.appendChild(startPicker());
      if (u.id === 'start2' && lvl > 0 && start2Open) box.appendChild(start2Picker());
    }
    box.appendChild(bindPanel());
  }

  // ---------------- atajos: hueco fijo para cada movimiento ----------------
  // save.pbind[dex] = [movimiento del hueco 1, del 2, del 3, del 4] (o null).
  function bindPanel() {
    const s = G.DB.save;
    s.pbind = s.pbind || {};
    const list = s.pbind[upgDex] || [null, null, null, null];
    const mon = G.DEX_BY[upgDex];
    const ids = G.Moves.poolFor(mon, true).concat([G.startMoveOf(upgDex)]).filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => G.Moves.BY_ID[a].name.localeCompare(G.Moves.BY_ID[b].name, 'es'));
    const el = document.createElement('div');
    el.className = 'panel bind-panel';
    el.innerHTML = `<b>Atajos de movimientos</b>
      <p class="sub" style="margin:2px 0 8px">Elige qué movimiento va siempre en cada hueco (teclas 1-4 o los iconos de abajo), para la memoria muscular. Si aún no tienes tantos movimientos, va al hueco más cercano.</p>
      <div class="bind-slots">${[0, 1, 2, 3].map(i => `<label class="bind-slot"><span>${i + 1}</span>
        <select class="field" data-slot="${i}"><option value="">Libre</option>${ids.map(id =>
          `<option value="${id}" ${list[i] === id ? 'selected' : ''}>${G.Moves.BY_ID[id].name}</option>`).join('')}</select></label>`).join('')}</div>`;
    el.querySelectorAll<HTMLSelectElement>('select[data-slot]').forEach(sel => {
      sel.onchange = () => {
        const l = (s.pbind![upgDex] || [null, null, null, null]).slice(0, 4);
        while (l.length < 4) l.push(null);
        const i = +sel.dataset.slot!, id = sel.value || null;
        // Un movimiento sólo puede estar en un hueco.
        for (let j = 0; j < 4; j++) if (id && l[j] === id) l[j] = null;
        l[i] = id;
        s.pbind![upgDex] = l;
        G.DB.commit();
        G.Audio.sfx('select');
        renderUpgrades();
      };
    });
    return el;
  }

  // ---------------- movimiento inicial (Mejoras → Movimiento inicial) ----------------
  // Lo elegido va en save.pstart[dex]; si es el de serie, se quita.
  let startOpen = false;
  function startPicker() {
    const s = G.DB.save, cur = G.startMoveOf(upgDex), base = G.baseStartOf(upgDex);
    const ids = G.startChoices(upgDex).sort((a, b) => G.Moves.BY_ID[a].name.localeCompare(G.Moves.BY_ID[b].name, 'es'));
    const el = document.createElement('div');
    el.className = 'panel ban-picker';
    el.innerHTML = `<p class="sub" style="margin:0 0 8px">Elige con qué ataque empieza. Lo puedes cambiar cuando quieras, gratis.</p>
      <div class="ban-moves">${ids.map(id => { const d = G.Moves.BY_ID[id];
        return `<button class="chip ${id === cur ? 'on' : ''}" data-id="${id}">${G.Icons.html('move:' + id, 16)} ${d.name}${id === base ? ' <small>(de serie)</small>' : ''}</button>`; }).join('')}</div>`;
    el.querySelectorAll<HTMLElement>('[data-id]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.id!;
        s.pstart = s.pstart || {};
        if (id === base) delete s.pstart[upgDex]; else s.pstart[upgDex] = id;
        // Si era el segundo inicial, el segundo vuelve a salir al azar.
        if (s.pstart2 && s.pstart2[upgDex] === id) delete s.pstart2[upgDex];
        // El de inicio no puede estar vetado.
        const l = banList(), i = l.indexOf(id);
        if (i >= 0) l.splice(i, 1);
        G.DB.commit();
        G.Audio.sfx('select');
        G.UI.toast(G.DEX_BY[upgDex].name + ' empezará con ' + G.Moves.BY_ID[id].name);
        renderUpgrades();
      };
    });
    return el;
  }

  // ---------------- segundo movimiento inicial (Mejoras → Segundo movimiento inicial, con Repertorio) ----------------
  // Lo elegido va en save.pstart2[dex]; sin elegir (o «Al azar»), el segundo sale al azar como siempre.
  let start2Open = false;
  function start2Picker() {
    const s = G.DB.save, cur = G.startMove2Of(upgDex), first = G.startMoveOf(upgDex);
    const ids = G.startChoices(upgDex).filter(id => id !== first)
      .sort((a, b) => G.Moves.BY_ID[a].name.localeCompare(G.Moves.BY_ID[b].name, 'es'));
    const el = document.createElement('div');
    el.className = 'panel ban-picker';
    el.innerHTML = `<p class="sub" style="margin:0 0 8px">Elige el segundo ataque con el que empieza. Lo puedes cambiar cuando quieras, gratis.</p>
      <div class="ban-moves"><button class="chip ${!cur ? 'on' : ''}" data-id="">${G.T('Al azar')}</button>${ids.map(id => { const d = G.Moves.BY_ID[id];
        return `<button class="chip ${id === cur ? 'on' : ''}" data-id="${id}">${G.Icons.html('move:' + id, 16)} ${d.name}</button>`; }).join('')}</div>`;
    el.querySelectorAll<HTMLElement>('[data-id]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.id!;
        s.pstart2 = s.pstart2 || {};
        if (!id) delete s.pstart2[upgDex]; else s.pstart2[upgDex] = id;
        // El elegido no puede estar vetado.
        const l = banList(), i = id ? l.indexOf(id) : -1;
        if (i >= 0) l.splice(i, 1);
        G.DB.commit();
        G.Audio.sfx('select');
        G.UI.toast(id ? G.I18n.f('{x} empezará también con {x}', G.DEX_BY[upgDex].name, G.Moves.BY_ID[id].name) : G.T('El segundo ataque saldrá al azar'));
        renderUpgrades();
      };
    });
    return el;
  }

  // ---------------- veto: movimientos bloqueados ----------------
  // Lista por Pokémon en save.pban[dex]; con N niveles de Veto, N movimientos.
  let banOpen = false;
  function banList() {
    const s = G.DB.save;
    s.pban = s.pban || {};
    return s.pban[upgDex] || (s.pban[upgDex] = []);
  }
  function banPicker(max: number) {
    const mon = G.DEX_BY[upgDex];
    const start = G.startMoveOf(upgDex), start2 = G.startMove2Of(upgDex);
    const ids = G.Moves.poolFor(mon, true).filter(id => id !== start && id !== start2)
      .sort((a, b) => G.Moves.BY_ID[a].name.localeCompare(G.Moves.BY_ID[b].name, 'es'));
    const list = banList();
    const el = document.createElement('div');
    el.className = 'panel ban-picker';
    el.innerHTML = `<p class="sub" style="margin:0 0 8px">Toca los movimientos que no quieres que te salgan en las cartas (${list.length}/${max}). El movimiento de inicio no se puede vetar.</p>
      <div class="ban-moves">${ids.map(id => { const d = G.Moves.BY_ID[id]; const on = list.includes(id);
        return `<button class="chip ${on ? 'on ban' : ''}" data-id="${id}">${G.Icons.html('move:' + id, 16)} ${d.name}${on ? ' ' + G.Icons.html('ban', 14) : ''}</button>`; }).join('')}</div>`;
    el.querySelectorAll<HTMLElement>('[data-id]').forEach(b => {
      b.onclick = () => {
        const l = banList(), id = b.dataset.id!, i = l.indexOf(id);
        if (i >= 0) l.splice(i, 1);
        else if (l.length >= max) { G.UI.toast('Ya tienes ' + max + ' vetados: quita uno primero'); return; }
        else l.push(id);
        G.DB.commit();
        G.Audio.sfx('select');
        renderUpgrades();
      };
    });
    return el;
  }

  return { init, open, GEN_NAMES };
})();
G.MenuUI = MenuUI;

declare module '../g' {
  interface Registry { MenuUI: typeof MenuUI }
}
