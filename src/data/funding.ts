import { G } from '../g';
/* ============ funding.js — donaciones ============
 * Las donaciones son voluntarias, no dan ninguna ventaja en el juego y se
 * usan sólo para mantenerlo en línea: servidores y dominio.
 * Este archivo es la fuente de lo que se enseña en el juego (botón "Apoyar")
 * y en la página /apoyar/. Se actualiza a mano:
 *
 *   kofi      usuario de Ko-fi (vacío = el botón no sale)
 *   sponsors  usuario de GitHub Sponsors (para quien entra al repositorio)
 *   costs     gastos [concepto, euros al mes]; si el coste no es fijo, un texto
 */
export const Funding = {
  kofi: '',
  sponsors: '',
  costs: [
    ['Servidor (partidas, cuentas, ranking y multijugador)', 'VPS propia']
  ],
  get url() { return this.kofi ? 'https://ko-fi.com/' + this.kofi : ''; }
};
G.Funding = Funding;

declare module '../g' {
  interface Registry { Funding: typeof Funding }
}
