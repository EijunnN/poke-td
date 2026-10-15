import { G } from '../g';
import type { CoopConfig } from './coop';
/* ============ spectate.ts — mirar la partida de una sala pública ============
 * Desde la lista de salas (ui/rooms-ui.ts), una sala pública que ya juega se puede MIRAR:
 * el servidor te apunta como espectador (server/realtime.ts, room.watch) y te da la partida
 * que mandó el anfitrión al empezar; con ella se monta la partida del modo que sea (Survivor
 * o Defensa) como un invitado más, pero sin Pokémon propio (net/coop.ts, `watching`).
 *
 * La cámara sigue a uno de los jugadores (Tab o los botones de la barra para cambiar; en la
 * Defensa, también el minimapa). Al acabar la partida, al cerrarse la sala o al salir, se
 * vuelve a la lista. No se gana nada mirando.
 *
 * También mira quien está en la sala pero eligió «Sólo mirar» (startInRoom): igual, pero al
 * acabar vuelve al lobby de su sala.
 *
 * Los modos llaman a: target() (a quién sigue la cámara), keys() (las teclas del espectador),
 * tick() (cada fotograma) y ended(msg) (cuando su partida se acaba para el espectador).
 */
export const Spectate = (() => {
  let on = false, idx = 0, shown = '';
  /** Miras la partida de tu propia sala (elegiste "Sólo mirar"): al acabar, de vuelta al lobby. */
  let inRoom = false;
  let bar: HTMLElement | null = null;
  const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  /** Empiezas a mirar la sala `id`. → true si ha empezado */
  async function start(id: string): Promise<boolean> {
    if (on || G.Game.state !== 'ui') return false;
    const r = await G.Social.watch(id);
    if (!r.ok || !r.cfg) { G.UI.toast(r.error || 'No se pudo entrar a mirar.', 2800); return false; }
    const w = G.Social.watching!;
    G.Net.open(w.room.id, false, w.room.host);
    on = true; idx = 0; shown = '';
    G.UI.hideAll();
    const cfg = { ...r.cfg, watch: true };
    if (cfg.mode === 'td') G.Game.start('td', { coop: cfg });
    else G.Game.startRun(cfg);
    showBar();
    return true;
  }

  /** Empieza a mirar la partida de tu sala (llega el inicio y elegiste sólo mirar). */
  function startInRoom(cfg: CoopConfig) {
    if (on) return;
    on = true; inRoom = true; idx = 0; shown = '';
    G.UI.hideAll();
    const c = { ...cfg, watch: true };
    if (c.mode === 'td') G.Game.start('td', { coop: c });
    else G.Game.startRun(c);
    showBar();
  }

  /** Los jugadores a los que se puede seguir (sus copias). */
  const targets = () => (G.Coop.active ? G.Coop.puppets() : []);
  /** El jugador al que sigue la cámara (o null si no queda nadie). */
  function target(): any {
    const t = targets();
    return t.length ? t[((idx % t.length) + t.length) % t.length] : null;
  }
  function next(d = 1) { idx += d; tick(); }

  /** Teclas del espectador: Tab / E, el siguiente jugador; Q, el anterior. */
  function keys() {
    if (G.Input.tap('tab') || G.Input.tap('keye')) next(1);
    if (G.Input.tap('keyq')) next(-1);
  }

  /** Cada fotograma: la barra dice a quién miras. */
  function tick() {
    if (!bar) return;
    const t = target();
    const name = t ? (t.tag || G.DEX_BY[t.dex]?.name || '?') : '';
    if (name === shown) return;
    shown = name;
    (bar.querySelector('[data-k=who]') as HTMLElement).innerHTML = name ? `Mirando a <b translate="no">${esc(name)}</b>` : 'Esperando a los jugadores…';
  }

  function showBar() {
    hideBar();
    bar = document.createElement('div');
    bar.id = 'spec-bar';
    bar.className = 'box';
    bar.innerHTML = `<span class="spec-tag">Espectador</span><span data-k="who"></span>
      <button class="btn small" data-a="prev" title="Anterior (Q)">◀</button><button class="btn small" data-a="next" title="Siguiente (Tab)">▶</button>
      <button class="btn small ghost" data-a="leave">Salir</button>`;
    bar.addEventListener('pointerdown', e => e.stopPropagation());
    (bar.querySelector('[data-a=prev]') as HTMLElement).onclick = () => next(-1);
    (bar.querySelector('[data-a=next]') as HTMLElement).onclick = () => next(1);
    (bar.querySelector('[data-a=leave]') as HTMLElement).onclick = () => G.Game.quit();
    document.body.appendChild(bar);
    tick();
  }
  function hideBar() { if (bar) bar.remove(); bar = null; }

  /** Se acabó lo que mirabas (o lo dejas): fuera de la partida y de vuelta a la lista de salas. */
  function ended(msg?: string) {
    if (!on) return;
    on = false;
    hideBar();
    if (inRoom) {
      inRoom = false;
      if (G.Coop.active) G.Coop.leave();
      if (msg) G.UI.toast(msg, 3000);
      G.Flow.afterRun();
      return;
    }
    if (G.Coop.active) G.Coop.leave();
    G.Social.unwatch();
    G.Net.close();
    if (msg) G.UI.toast(msg, 3000);
    G.Game.toUI();
    G.Flow.goMenu();
    G.RoomsUI.open();
  }

  // El servidor te saca (se acabó la partida, se cerró la sala, se cortó la conexión): la partida se cierra.
  G.Social.on(what => {
    if (what !== 'watch-ended' || !on) return;
    if (G.Game.state !== 'ui' && G.Game.state !== 'over') G.Game.quit();
    ended('La partida que mirabas ha terminado');
  });

  return { start, startInRoom, target, next, keys, tick, ended, get active() { return on; } };
})();
G.Spectate = Spectate;

declare module '../g' {
  interface Registry { Spectate: typeof Spectate }
}
