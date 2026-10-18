import { G } from '../g';
/* ============ settings.js — ajustes de este dispositivo ============
 * Se guardan en el navegador (no en la cuenta): cada PC o móvil tiene los
 * suyos. El volumen lo guarda audio.js aparte.
 *
 *   quality     'auto' | 'high' | 'mid' | 'low'   efectos y partículas
 *   dmgNumbers  true/false                        números de daño
 *   calm        true/false                        menos sacudidas y destellos
 *   fps         true/false                        contador de FPS
 *   stick       0.8 | 1 | 1.25                    tamaño del joystick táctil
 *   stickMode   'follow' | 'fixed'                joystick táctil: aparece donde tocas, o fijo abajo a la izquierda
 *   res         'auto' | 'high' | 'normal'        resolución del lienzo (auto según la pantalla, ×1,5 o ×1)
 *   chat        'all' | 'quick' | 'off'           chat de la sala: todo, sólo frases rápidas o nada
 *   chatFilter  true/false                        tachar palabrotas y enlaces del chat (sólo lo que ves tú)
 *   gachaSkip   true/false                        el gacha enseña el resultado sin la tragaperras
 *   aimCursor   true/false                        PC: apuntar hacia el cursor en vez de al enemigo más cercano
 *
 *   G.Settings.get('quality')  ·  G.Settings.set('fps', true)  ·  G.Settings.on(fn)
 *   G.Settings.fx   nivel efectivo 0 (bajo) .. 2 (alto), ya resuelto el 'auto'
 */
export interface SettingsData {
  quality: 'auto' | 'high' | 'mid' | 'low';
  dmgNumbers: boolean;
  calm: boolean;
  fps: boolean;
  stick: number;
  stickMode: 'follow' | 'fixed';
  res: 'auto' | 'high' | 'normal';
  /** Versión de `res`: sin ella, el 'high' guardado era el de antes por defecto y pasa a 'auto'. */
  resV?: number;
  chat: 'all' | 'quick' | 'off';
  chatFilter: boolean;
  gachaSkip: boolean;
  aimCursor: boolean;
}

export const Settings = (() => {
  const KEY = 'ps.settings';
  const DEF: SettingsData = { quality: 'auto', dmgNumbers: true, calm: false, fps: false, stick: 1, stickMode: 'follow', res: 'auto', chat: 'all', chatFilter: false, gachaSkip: false, aimCursor: false };
  let s: SettingsData = Object.assign({}, DEF);
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* nada */ }
  // 'high' era lo de por defecto (y se guardaba al cambiar cualquier otro ajuste): pasa a 'auto', que en un
  // portátil con pantalla Retina dibuja la mitad de píxeles (se calentaban). Quien quiera, vuelve a elegir Alta.
  if (!s.resV) { if (s.res === 'high') s.res = 'auto'; s.resV = 1; }
  const fns = new Set<(k: string, v: unknown) => void>();

  // Calidad automática: empieza alta (media en móvil) y baja si va a tirones.
  const touchy = matchMedia('(pointer: coarse)').matches;
  let autoLevel = touchy ? 1 : 2;
  let acc = 0, frames = 0, slowT = 0, fastT = 0;

  function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* nada */ } }
  function get<K extends keyof SettingsData>(k: K): SettingsData[K];
  function get(k: string): unknown;
  function get(k: string) { return s[k as keyof SettingsData]; }
  function set<K extends keyof SettingsData>(k: K, v: SettingsData[K]): void;
  function set(k: string, v: unknown): void;
  function set(k: string, v: unknown) { (s as unknown as Record<string, unknown>)[k] = v; save(); fns.forEach(fn => { try { fn(k, v); } catch (e) { /* nada */ } }); }

  /** Lo llama el bucle del juego en cada fotograma (sólo durante la partida). */
  function sample(dt: number) {
    if (s.quality !== 'auto' || dt <= 0) return;
    acc += dt; frames++;
    if (acc < 1) return;
    const fps = frames / acc;
    acc = 0; frames = 0;
    // 3 s seguidos por debajo de 45 FPS: baja un nivel; 8 s por encima de 57: sube.
    if (fps < 45) { slowT++; fastT = 0; } else if (fps > 57) { fastT++; slowT = 0; } else { slowT = fastT = 0; }
    if (slowT >= 3 && autoLevel > 0) { autoLevel--; slowT = 0; }
    if (fastT >= 8 && autoLevel < (touchy ? 1 : 2)) { autoLevel++; fastT = 0; }
  }

  return {
    get, set, sample, DEF,
    on(fn: (k: string, v: unknown) => void) { fns.add(fn); },
    get all() { return Object.assign({}, s); },
    get fx() { return s.quality === 'auto' ? autoLevel : s.quality === 'high' ? 2 : s.quality === 'mid' ? 1 : 0; },
    get autoLevel() { return autoLevel; },
    get touch() { return touchy; }
  };
})();
G.Settings = Settings;

declare module '../g' {
  interface Registry { Settings: typeof Settings }
}
