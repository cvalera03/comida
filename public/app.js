'use strict';
/* Comida — PWA de batch cooking. JS sin dependencias ni build. */

// ------------------------------------------------------------ utilidades --
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const parseNum = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const stars = (q) => (q ? '★'.repeat(q) + '☆'.repeat(5 - q) : '');

const store = {
  get(k, d) { try { const v = localStorage.getItem('comida.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('comida.' + k, JSON.stringify(v)); } catch { /* modo privado */ } },
};

const CATEGORIES = ['Frutas y verduras', 'Carne', 'Pescado', 'Lácteos y huevos', 'Panadería', 'Despensa',
  'Especias', 'Conservas', 'Congelados', 'Bebidas', 'Limpieza', 'Otros'];

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  store: '<svg viewBox="0 0 24 24"><path d="M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 8 13"><path d="m1 1 6 5.5L1 12"/></svg>',
};

// ----------------------------------------------------------------- estado --
const S = {
  data: store.get('state', null),
  tab: store.get('tab', 'semana'),
  ui: {
    qRecetas: '', qDespensa: '', fDespensa: 'todo',
    opt: store.get('opt', { maxStores: 2, minQuality: 0, qWeight: 0 }),
  },
  outbox: store.get('outbox', []),
  online: true,
  sheet: null, // { kind, id }
  es: null,
};
let IDX = {};

function index() {
  const d = S.data;
  if (!d) return;
  const products = new Map(d.products.map((p) => [p.id, p]));
  const stores = new Map(d.stores.map((s) => [s.id, s]));
  const prices = {};
  for (const p of d.prices) (prices[p.product_id] ||= {})[p.store_id] = p;
  const shoppingByProduct = new Map(d.shopping.filter((s) => !s.checked).map((s) => [s.product_id, s]));
  const usedIn = {};
  for (const r of d.recipes) for (const i of r.ingredients) (usedIn[i.product_id] ||= []).push(r);
  const categories = [...new Set([...CATEGORIES, ...d.products.map((p) => p.category).filter(Boolean)])];
  IDX = { products, stores, prices, shoppingByProduct, usedIn, categories };
}

function bestPrice(pid) {
  const ps = IDX.prices[pid];
  if (!ps) return null;
  let best = null;
  for (const p of Object.values(ps)) {
    if (p.price == null || !IDX.stores.has(p.store_id)) continue;
    if (!best || p.price < best.price) best = p;
  }
  return best && { ...best, store: IDX.stores.get(best.store_id).name };
}

// ------------------------------------------------------------------- red ---
class ApiError extends Error {}

async function api(method, url, body, opts = {}) {
  if (opts.optimistic && S.data) { opts.optimistic(S.data); index(); render(); }
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    setOnline(false);
    if (opts.queue) {
      S.outbox.push({ method, url, body, apply: opts.queue });
      store.set('outbox', S.outbox);
      cacheState();
      updateBanner();
      return { queued: true };
    }
    if (!opts.silent) toast('Sin conexión. Inténtalo de nuevo cuando vuelva la red.');
    if (opts.optimistic) loadState();
    throw e;
  }
  setOnline(true);
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new ApiError('No autenticado'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error || 'Error ' + res.status);
    if (!opts.silent) toast(err.message);
    if (opts.optimistic) loadState();
    throw err;
  }
  if (method !== 'GET') scheduleRefresh();
  return data;
}

// Cambios hechos sin conexión (marcar en la compra / en la despensa): se reaplican
// sobre el estado recibido y se envían cuando vuelve la red.
function applyQueued(d, a) {
  if (!a) return;
  if (a.kind === 'shop') { const s = d.shopping.find((x) => x.id === a.id); if (s) s.checked = a.checked; }
  if (a.kind === 'stock') { const p = d.products.find((x) => x.id === a.id); if (p) p.in_stock = a.in_stock; }
}

async function flushOutbox() {
  while (S.outbox.length) {
    const op = S.outbox[0];
    try {
      const r = await fetch(op.url, { method: op.method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: op.body ? JSON.stringify(op.body) : undefined });
      if (r.status === 401) return false;
    } catch { return false; }
    S.outbox.shift();
    store.set('outbox', S.outbox);
  }
  return true;
}

function cacheState() { if (S.data) store.set('state', S.data); }

let loading = null;
async function loadState() {
  if (loading) return loading;
  loading = (async () => {
    try {
      await flushOutbox();
      const d = await api('GET', '/api/state', null, { silent: true });
      for (const op of S.outbox) applyQueued(d, op.apply);
      S.data = d;
      cacheState();
      index();
      render();
      if (S.sheet?.live) S.sheet.live();
    } catch { /* sin red: seguimos con la copia local */ } finally { loading = null; }
  })();
  return loading;
}

let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadState, 120); }

function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    setOnline(true);
    try { const { version } = JSON.parse(e.data); if (!S.data || version !== S.data.version) scheduleRefresh(); } catch { /* ping */ }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (S.es === es) connectEvents(); }, 5000);
  };
  S.es = es;
}

function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  updateBanner();
  if (v) loadState();
}

function updateBanner() {
  const b = $('#banner');
  b.hidden = S.online;
  b.textContent = S.outbox.length ? `Sin conexión · ${plural(S.outbox.length, 'cambio pendiente', 'cambios pendientes')}` : 'Sin conexión · mostrando la última copia';
}

// ----------------------------------------------------------------- render --
function render() {
  if (!S.data) return;
  const view = $('#view');
  const active = document.activeElement;
  const keep = active && active.id && view.contains(active) ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;
  view.innerHTML = VIEWS[S.tab]();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch { /* no es texto */ } }
  }
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const pending = S.data.shopping.filter((s) => !s.checked).length;
  const badge = $('#badge-compra');
  badge.hidden = !pending;
  badge.textContent = pending;
}

function header(title, sub, button = '') {
  return `<header class="header"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${button}</header>`;
}

function empty(title, text, action = '') {
  return `<div class="card empty"><b>${esc(title)}</b>${esc(text)}${action ? `<div class="spacer"></div>${action}` : ''}</div>`;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()].sort((a, b) => catOrder(a[0]) - catOrder(b[0]) || a[0].localeCompare(b[0]));
}
function catOrder(c) { if (!c) return 999; const i = CATEGORIES.indexOf(c); return i < 0 ? 500 : i; }

// ---------------------------------------------------------------- semana ---
function plannedNeeds() {
  const needs = new Map();
  for (const r of S.data.recipes.filter((r) => r.planned)) {
    for (const i of r.ingredients) {
      const p = IDX.products.get(i.product_id);
      if (!p) continue;
      const n = needs.get(p.id) || { p, qty: [], recipes: [] };
      if (i.quantity) n.qty.push(i.quantity);
      n.recipes.push(r.name);
      needs.set(p.id, n);
    }
  }
  return [...needs.values()];
}

function viewSemana() {
  const planned = S.data.recipes.filter((r) => r.planned);
  const needs = plannedNeeds();
  const missing = needs.filter((n) => !n.p.in_stock);
  const notListed = missing.filter((n) => !IDX.shoppingByProduct.has(n.p.id));
  const servings = planned.reduce((a, r) => a + (r.servings || 0), 0);
  const others = S.data.recipes.filter((r) => !r.planned)
    .sort((a, b) => (a.last_cooked || 0) - (b.last_cooked || 0));

  let h = header('Esta semana', planned.length
    ? `${plural(planned.length, 'receta', 'recetas')}${servings ? ` · ${plural(servings, 'ración', 'raciones')}` : ''}`
    : 'Qué cocinamos el domingo');

  if (!planned.length) {
    h += empty('Aún no hay nada planificado', 'Elige las recetas que haréis este domingo.',
      S.data.recipes.length ? '' : `<button class="btn primary" data-act="new-recipe">Crear la primera receta</button>`);
  } else {
    h += `<div class="card"><div class="list">${planned.map((r) => {
      const miss = r.ingredients.filter((i) => !IDX.products.get(i.product_id)?.in_stock).length;
      return `<button class="row" data-act="open-recipe" data-id="${r.id}">
        <span class="main"><div class="title">${esc(r.name)}</div>
        <div class="meta">${r.servings ? plural(r.servings, 'ración', 'raciones') + ' · ' : ''}${plural(r.ingredients.length, 'ingrediente', 'ingredientes')}</div></span>
        <span class="pill ${miss ? 'warn' : 'ok'}">${miss ? `Faltan ${miss}` : 'Todo listo'}</span>${ICON.chev}</button>`;
    }).join('')}</div></div>`;

    h += `<div class="btn-row">
      <button class="btn primary" data-act="generate-list" ${notListed.length ? '' : 'disabled'}>
        ${notListed.length ? `Añadir lo que falta (${notListed.length})` : missing.length ? 'Todo en la lista ✓' : 'No falta nada ✓'}</button>
    </div>
    <div class="btn-row">
      <button class="btn" data-act="cooked">Ya hemos cocinado</button>
      <button class="btn danger" data-act="clear-plan">Vaciar semana</button>
    </div>`;

    if (missing.length) {
      h += `<div class="section-title">Os falta</div><div class="card"><ul class="list ing-list">${missing.map((n) => `
        <li><span class="dot ${n.p.staple ? 'staple' : 'no'}"></span>
        <span>${esc(n.p.name)}<div class="meta muted small">${esc(n.recipes.join(', '))}</div></span>
        <span class="q">${esc(n.qty.join(' + '))}${IDX.shoppingByProduct.has(n.p.id) ? '<br><span class="pill ok">En la lista</span>' : ''}</span></li>`).join('')}
      </ul></div>`;
    }
  }

  if (others.length) {
    h += `<div class="section-title">Añadir a la semana</div><div class="card"><div class="list">${others.map((r) => `
      <div class="row" data-act="open-recipe" data-id="${r.id}">
        <button class="check" data-act="toggle-plan" data-id="${r.id}" aria-label="Añadir ${esc(r.name)} a la semana">${ICON.check}</button>
        <span class="main"><div class="title">${esc(r.name)}</div>
        <div class="meta">${r.last_cooked ? 'Última vez ' + new Date(r.last_cooked * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : 'Sin cocinar todavía'}</div></span>
      </div>`).join('')}</div></div>`;
  }
  return h;
}

// --------------------------------------------------------------- recetas ---
function viewRecetas() {
  return header('Recetas', plural(S.data.recipes.length, 'receta', 'recetas'),
    `<button class="icon-btn" data-act="new-recipe" aria-label="Nueva receta">${ICON.plus}</button>`)
    + `<input id="q-recetas" class="search" type="search" placeholder="Buscar receta o ingrediente" value="${esc(S.ui.qRecetas)}" data-input="q-recetas" autocomplete="off">`
    + `<div id="list-area">${recetasList()}</div>`;
}

function recetasList() {
  const q = norm(S.ui.qRecetas);
  const list = S.data.recipes.filter((r) => !q || norm(r.name).includes(q)
    || r.ingredients.some((i) => norm(IDX.products.get(i.product_id)?.name).includes(q)));
  if (!S.data.recipes.length) return empty('Sin recetas', 'Añade las recetas que soléis preparar para la semana.', `<button class="btn primary" data-act="new-recipe">Nueva receta</button>`);
  if (!list.length) return empty('Nada encontrado', 'Prueba con otro nombre o ingrediente.');
  return `<div class="card"><div class="list">${list.map((r) => {
    const miss = r.ingredients.filter((i) => !IDX.products.get(i.product_id)?.in_stock).length;
    return `<div class="row" data-act="open-recipe" data-id="${r.id}">
      <button class="check ${r.planned ? 'on' : ''}" data-act="toggle-plan" data-id="${r.id}" aria-label="Esta semana">${ICON.check}</button>
      <span class="main"><div class="title">${esc(r.name)}</div>
      <div class="meta">${plural(r.ingredients.length, 'ingrediente', 'ingredientes')}${r.servings ? ' · ' + plural(r.servings, 'ración', 'raciones') : ''}${miss ? ` · faltan ${miss}` : ''}</div></span>
      ${r.planned ? '<span class="pill ok">Semana</span>' : ''}${ICON.chev}</div>`;
  }).join('')}</div></div><p class="hint">Marca el círculo para añadir la receta a esta semana.</p>`;
}

// ---------------------------------------------------------------- compra ---
function shoppingEstimate(items) {
  let total = 0; let priced = 0;
  for (const s of items) { const b = bestPrice(s.product_id); if (b) { total += b.price; priced++; } }
  return { total, priced };
}

function viewCompra() {
  const pending = S.data.shopping.filter((s) => !s.checked);
  const checked = S.data.shopping.filter((s) => s.checked);
  const est = shoppingEstimate(pending);
  let h = header('Compra', pending.length
    ? `${plural(pending.length, 'pendiente', 'pendientes')}${est.priced ? ` · desde ${eur(est.total)}` : ''}`
    : 'Lista vacía');

  h += `<form class="card pad" data-form="add-shopping" autocomplete="off">
    <div class="ing-row" style="grid-template-columns:1fr 90px auto;margin:0">
      <input class="input" name="name" list="dl-products" placeholder="Añadir producto" required>
      <input class="input" name="quantity" placeholder="Cant.">
      <button class="icon-btn" aria-label="Añadir">${ICON.plus}</button>
    </div>${datalistProducts()}</form>`;

  if (!S.data.shopping.length) {
    h += `<div class="spacer"></div>` + empty('Nada que comprar', 'Genera la lista desde «Semana» o añade cosas a mano. Al marcar algo como agotado en la despensa también aparece aquí.');
    return h;
  }

  for (const [cat, items] of groupBy(pending, (s) => s.category || '')) {
    h += `<div class="section-title">${esc(cat || 'Sin categoría')}</div><div class="card"><div class="list">${items.map(shopRow).join('')}</div></div>`;
  }
  if (pending.length) {
    h += `<div class="btn-row"><button class="btn" data-tab-go="ahorro">Ver dónde es más barato</button></div>`;
  }
  if (checked.length) {
    h += `<div class="section-title">En el carro (${checked.length})</div><div class="card"><div class="list">${checked.map(shopRow).join('')}</div></div>
      <div class="btn-row"><button class="btn primary" data-act="finish-shopping">Terminar compra y pasar a la despensa</button></div>`;
  }
  h += `<div class="btn-row"><button class="btn danger small" data-act="clear-shopping">Vaciar lista</button></div>`;
  return h;
}

function shopRow(s) {
  const b = bestPrice(s.product_id);
  const meta = [s.quantity, s.source].filter(Boolean).join(' · ');
  return `<div class="row" data-act="toggle-shop" data-id="${s.id}">
    <button class="check ${s.checked ? 'on' : ''}" aria-label="Marcar">${ICON.check}</button>
    <span class="main"><div class="title" style="${s.checked ? 'text-decoration:line-through;opacity:.55' : ''}">${esc(s.name)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</span>
    ${b ? `<span class="end num">${eur(b.price)}<div class="small">${esc(b.store)}</div></span>` : ''}
    <button class="btn small" data-act="shop-menu" data-id="${s.id}" aria-label="Opciones">···</button></div>`;
}

function datalistProducts() {
  return `<datalist id="dl-products">${S.data.products.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>`;
}

// -------------------------------------------------------------- despensa ---
function viewDespensa() {
  const have = S.data.products.filter((p) => p.in_stock).length;
  const seg = [['todo', 'Todo'], ['tengo', 'Tengo'], ['falta', 'Falta'], ['basicos', 'Especias y básicos']];
  return header('Despensa', `${have} de ${S.data.products.length} en casa`,
    `<button class="icon-btn" data-act="new-product" aria-label="Nuevo producto">${ICON.plus}</button>`)
    + `<input id="q-despensa" class="search" type="search" placeholder="Buscar producto" value="${esc(S.ui.qDespensa)}" data-input="q-despensa" autocomplete="off">`
    + `<div class="segmented">${seg.map(([k, l]) => `<button data-act="f-despensa" data-f="${k}" class="${S.ui.fDespensa === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
    + `<div id="list-area">${despensaList()}</div>`;
}

function despensaList() {
  const q = norm(S.ui.qDespensa);
  const f = S.ui.fDespensa;
  const list = S.data.products.filter((p) => (!q || norm(p.name).includes(q) || norm(p.category).includes(q))
    && (f === 'todo' || (f === 'tengo' && p.in_stock) || (f === 'falta' && !p.in_stock) || (f === 'basicos' && p.staple)));
  if (!S.data.products.length) return empty('Despensa vacía', 'Añade productos o crea recetas: sus ingredientes aparecerán aquí.');
  if (!list.length) return empty('Nada por aquí', 'No hay productos con este filtro.');
  let h = '';
  for (const [cat, items] of groupBy(list, (p) => p.category || '')) {
    h += `<div class="section-title">${esc(cat || 'Sin categoría')}</div><div class="card"><div class="list">${items.map((p) => {
      const b = bestPrice(p.id);
      const meta = [p.staple ? 'Básico' : '', p.unit, b ? `${eur(b.price)} en ${b.store}` : ''].filter(Boolean).join(' · ');
      return `<div class="row" data-act="open-product" data-id="${p.id}">
        <span class="dot ${p.in_stock ? 'ok' : 'no'}"></span>
        <span class="main"><div class="title">${esc(p.name)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</span>
        <button class="pill ${p.in_stock ? 'ok' : 'no'}" style="border:0;padding:6px 10px;cursor:pointer" data-act="toggle-stock" data-id="${p.id}">${p.in_stock ? 'Tengo' : 'Falta'}</button></div>`;
    }).join('')}</div></div>`;
  }
  return h + '<p class="hint">Pulsa «Tengo» cuando algo se acabe: se marcará como agotado y se añadirá a la compra. Los básicos (especias, aceite…) no se gastan al cocinar; márcalos vosotros.</p>';
}

// ---------------------------------------------------------------- ahorro ---
/**
 * Elige el conjunto de supermercados (hasta maxStores) que minimiza el coste
 * de la lista. Cada producto va al súper del conjunto con mejor puntuación,
 * donde puntuación = precio × (1 + qWeight × (5 − calidad) / 4).
 * Prioridad: cubrir más productos > menor coste ponderado > menos tiendas.
 */
function optimize(items, opt) {
  const stores = S.data.stores;
  const options = items.map((it) => {
    const ps = IDX.prices[it.product_id] || {};
    return stores.map((s) => {
      const p = ps[s.id];
      if (!p || p.price == null) return null;
      if (opt.minQuality && p.quality && p.quality < opt.minQuality) return null;
      const q = p.quality || 3;
      return { store_id: s.id, price: p.price, quality: p.quality, score: p.price * (1 + opt.qWeight * (5 - q) / 4) };
    }).filter(Boolean);
  });
  const useful = stores.filter((s) => options.some((o) => o.some((x) => x.store_id === s.id))).map((s) => s.id);
  const max = Math.min(opt.maxStores || useful.length, useful.length);
  let best = null;
  const evaluate = (subset) => {
    let missing = 0; let score = 0; let cost = 0;
    const assign = options.map((o) => {
      let pick = null;
      for (const x of o) if (subset.includes(x.store_id) && (!pick || x.score < pick.score)) pick = x;
      if (pick) { score += pick.score; cost += pick.price; } else missing++;
      return pick;
    });
    const used = new Set(assign.filter(Boolean).map((x) => x.store_id)).size;
    const cand = { missing, score, cost, assign, used };
    if (!best || missing < best.missing || (missing === best.missing && (score < best.score - 1e-9
      || (Math.abs(score - best.score) < 1e-9 && used < best.used)))) best = cand;
  };
  const rec = (start, subset) => {
    if (subset.length) evaluate(subset);
    if (subset.length === max) return;
    for (let i = start; i < useful.length; i++) rec(i + 1, [...subset, useful[i]]);
  };
  rec(0, []);
  // Comparativa: qué costaría comprar todo lo posible en un único súper.
  const single = stores.map((s) => {
    let cost = 0; let covered = 0;
    for (const o of options) { const x = o.find((y) => y.store_id === s.id); if (x) { cost += x.price; covered++; } }
    return { store: s, cost, covered };
  }).sort((a, b) => b.covered - a.covered || a.cost - b.cost);
  return { best, single, options };
}

function viewAhorro() {
  const opt = S.ui.opt;
  const items = S.data.shopping.filter((s) => !s.checked && s.product_id);
  const nStores = S.data.stores.length;
  let h = header('Ahorro', 'Dónde comprar la lista para que salga más barata',
    `<button class="icon-btn ghost" data-act="stores" aria-label="Supermercados">${ICON.store}</button>`);

  if (!nStores) return h + empty('Sin supermercados', 'Añade los supermercados a los que soléis ir.', `<button class="btn primary" data-act="stores">Añadir supermercados</button>`);

  const maxOpts = [[1, '1 súper'], [2, '2'], [3, '3'], [0, 'Todos']].filter(([v]) => v <= nStores);
  const qOpts = [[0, 'Cualquiera'], [2, '★2+'], [3, '★3+'], [4, '★4+']];
  h += `<div class="card pad">
    <div class="small muted" style="margin:0 2px 6px">Máximo de supermercados</div>
    <div class="segmented">${maxOpts.map(([v, l]) => `<button data-act="opt" data-k="maxStores" data-v="${v}" class="${opt.maxStores === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="small muted" style="margin:0 2px 6px">Calidad mínima</div>
    <div class="segmented">${qOpts.map(([v, l]) => `<button data-act="opt" data-k="minQuality" data-v="${v}" class="${opt.minQuality === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="small muted" style="margin:0 2px 2px;display:flex;justify-content:space-between"><span>Solo precio</span><span>Importa la calidad</span></div>
    <input class="range" type="range" min="0" max="100" step="10" value="${Math.round(opt.qWeight * 100)}" data-change="opt-weight" aria-label="Importancia de la calidad">
  </div>`;

  if (!items.length) return h + '<div class="spacer"></div>' + empty('La lista de la compra está vacía', 'Cuando haya productos en la lista verás aquí la ruta más barata.');

  const { best, single, options } = optimize(items, opt);
  const unpriced = items.filter((_, i) => !options[i].length);
  const noQuality = items.filter((_, i) => options[i].length && best && !best.assign[i]);

  if (best && best.cost > 0) {
    const bestSingle = single.find((s) => s.covered === items.length - best.missing);
    const saving = bestSingle && bestSingle.store && best.used > 1 ? bestSingle.cost - best.cost : 0;
    h += `<div class="spacer"></div><div class="stat-grid">
      <div class="stat"><div class="label">Total estimado</div><div class="value accent num">${eur(best.cost)}</div></div>
      <div class="stat"><div class="label">${saving > 0.004 ? `Ahorro vs. solo ${esc(bestSingle.store.name)}` : 'Supermercados'}</div>
        <div class="value num">${saving > 0.004 ? eur(saving) : best.used}</div></div></div>`;

    const byStore = new Map();
    best.assign.forEach((x, i) => { if (x) { if (!byStore.has(x.store_id)) byStore.set(x.store_id, []); byStore.get(x.store_id).push({ it: items[i], x }); } });
    for (const [sid, list] of [...byStore.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const sub = list.reduce((a, l) => a + l.x.price, 0);
      h += `<div class="spacer"></div><div class="card"><div class="store-head">${esc(IDX.stores.get(sid).name)}<span>${eur(sub)}</span></div>
        <div class="list">${list.map(({ it, x }) => `<div class="row" data-act="open-product" data-id="${it.product_id}">
          <span class="main"><div class="title">${esc(it.name)}</div><div class="meta">${esc(it.quantity || IDX.products.get(it.product_id)?.unit || '')}
          ${x.quality ? `<span class="stars-ro">${stars(x.quality)}</span>` : ''}</div></span>
          <span class="end num">${eur(x.price)}</span></div>`).join('')}</div></div>`;
    }
  }

  if (unpriced.length || noQuality.length) {
    h += `<div class="section-title">Sin precio${noQuality.length ? ' o sin la calidad pedida' : ''}</div><div class="card"><div class="list">${[...unpriced, ...noQuality].map((it) => `
      <button class="row" data-act="open-product" data-id="${it.product_id}"><span class="main"><div class="title">${esc(it.name)}</div>
      <div class="meta">${unpriced.includes(it) ? 'Añade su precio en algún súper' : 'Ningún súper cumple la calidad mínima'}</div></span>${ICON.chev}</button>`).join('')}</div></div>`;
  }

  h += `<div class="section-title">Todo en un solo súper</div><div class="card"><table class="compare">
    <tr><th>Supermercado</th><th>Tiene</th><th>Coste</th></tr>
    ${single.map((s) => `<tr><td>${esc(s.store.name)}</td><td class="num">${s.covered}/${items.length}</td><td class="num">${s.covered ? eur(s.cost) : '—'}</td></tr>`).join('')}
  </table></div><p class="hint">Los precios son por la unidad o formato de cada producto. Los productos sin calidad puntuada cuentan como ★3.</p>`;
  return h;
}

const VIEWS = { semana: viewSemana, recetas: viewRecetas, compra: viewCompra, despensa: viewDespensa, ahorro: viewAhorro };

// ----------------------------------------------------------------- hojas ---
function openSheet(html, meta = {}) {
  const sh = $('#sheet');
  sh.innerHTML = html;
  sh.hidden = false;
  $('#sheet-backdrop').hidden = false;
  sh.scrollTop = 0;
  S.sheet = meta;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  S.sheet = null;
  document.body.style.overflow = '';
}
function sheetHead(title, left = 'Cerrar', right = '', rightAct = '') {
  return `<div class="sheet-head"><button data-act="close-sheet">${esc(left)}</button><h2>${esc(title)}</h2>
    <button ${rightAct ? `data-act="${rightAct}"` : 'style="visibility:hidden"'}>${esc(right)}</button></div>`;
}

// Receta: vista
function openRecipe(id) {
  const r = S.data.recipes.find((x) => x.id === id);
  if (!r) return closeSheet();
  const ings = r.ingredients.map((i) => ({ ...i, p: IDX.products.get(i.product_id) })).filter((i) => i.p);
  const html = sheetHead(r.name, 'Cerrar', 'Editar', 'edit-recipe') + `
    <div class="card"><div class="switch-row"><div>Cocinar esta semana<small>${r.times_cooked ? `Cocinada ${plural(r.times_cooked, 'vez', 'veces')}` : 'Aún no la habéis cocinado'}</small></div>
      <label class="switch"><input type="checkbox" ${r.planned ? 'checked' : ''} data-change="plan-recipe" data-id="${r.id}"><i></i></label></div>
      ${r.servings ? `<div class="switch-row"><div>Raciones</div><b>${r.servings}</b></div>` : ''}
      ${r.url ? `<div class="switch-row"><div>Enlace</div><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">Abrir receta</a></div>` : ''}
    </div>
    <div class="section-title">Ingredientes</div>
    <div class="card">${ings.length ? `<ul class="list ing-list">${ings.map((i) => `<li data-act="open-product" data-id="${i.p.id}" style="cursor:pointer">
      <span class="dot ${i.p.in_stock ? 'ok' : 'no'}"></span><span>${esc(i.p.name)}${i.p.staple ? ' <span class="pill">básico</span>' : ''}</span>
      <span class="q">${esc(i.quantity)}</span></li>`).join('')}</ul>` : '<div class="empty">Sin ingredientes</div>'}</div>
    <p class="hint"><span class="dot ok"></span> lo tenéis · <span class="dot no"></span> falta</p>
    ${r.instructions ? `<div class="section-title">Preparación</div><div class="card pad recipe-body">${esc(r.instructions)}</div>` : ''}
    ${r.notes ? `<div class="section-title">Notas</div><div class="card pad recipe-body">${esc(r.notes)}</div>` : ''}
    <div class="btn-row"><button class="btn danger" data-act="delete-recipe" data-id="${r.id}">Eliminar receta</button></div>`;
  openSheet(html, { kind: 'recipe', id, live: () => openRecipeKeepScroll(id) });
}
function openRecipeKeepScroll(id) { const y = $('#sheet').scrollTop; openRecipe(id); $('#sheet').scrollTop = y; }
function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : 'https://' + u; }

// Receta: formulario
function editRecipe(id) {
  const r = id ? S.data.recipes.find((x) => x.id === id) : null;
  const ings = r ? r.ingredients.map((i) => ({ name: IDX.products.get(i.product_id)?.name || '', quantity: i.quantity })) : [];
  while (ings.length < 3) ings.push({ name: '', quantity: '' });
  const html = sheetHead(r ? 'Editar receta' : 'Nueva receta', 'Cancelar', 'Guardar', 'save-recipe') + `
    <form id="recipe-form" data-form="recipe" data-id="${r ? r.id : ''}" autocomplete="off">
      <label class="field"><span>Nombre</span><input name="name" required value="${esc(r?.name)}" placeholder="Lentejas con verduras"></label>
      <div class="grid2">
        <label class="field"><span>Raciones / táper</span><input name="servings" inputmode="numeric" value="${esc(r?.servings ?? '')}" placeholder="4"></label>
        <label class="field"><span>Enlace (opcional)</span><input name="url" inputmode="url" value="${esc(r?.url)}" placeholder="https://…"></label>
      </div>
      <div class="field"><span>Ingredientes y cantidad</span><div id="ing-rows">${ings.map(ingRow).join('')}</div>
        <button type="button" class="btn small" data-act="add-ing">+ Ingrediente</button>
        <p class="hint">Los ingredientes nuevos se añaden a la despensa como «falta».</p></div>
      <label class="field"><span>Preparación</span><textarea name="instructions" placeholder="Pasos…">${esc(r?.instructions)}</textarea></label>
      <label class="field"><span>Notas</span><textarea name="notes" style="min-height:70px" placeholder="Se congela bien, aguanta 4 días…">${esc(r?.notes)}</textarea></label>
      <button class="btn primary block" type="submit">Guardar</button>
      ${datalistProducts()}
    </form>`;
  openSheet(html, { kind: 'recipe-edit', id });
}
function ingRow(i) {
  return `<div class="ing-row"><input class="input" name="ing-name" list="dl-products" placeholder="Ingrediente" value="${esc(i.name)}">
    <input class="input" name="ing-qty" placeholder="200 g" value="${esc(i.quantity)}">
    <button type="button" class="x" data-act="rm-ing" aria-label="Quitar">×</button></div>`;
}

async function saveRecipe(form) {
  const fd = new FormData(form);
  const names = fd.getAll('ing-name'); const qtys = fd.getAll('ing-qty');
  const body = {
    name: fd.get('name'), servings: fd.get('servings'), url: fd.get('url'),
    instructions: fd.get('instructions'), notes: fd.get('notes'),
    ingredients: names.map((n, i) => ({ name: n, quantity: qtys[i] })).filter((i) => i.name.trim()),
  };
  if (!body.name.trim()) return toast('Ponle un nombre a la receta');
  const id = form.dataset.id ? Number(form.dataset.id) : null;
  const res = id ? await api('PUT', `/api/recipes/${id}`, body) : await api('POST', '/api/recipes', body);
  await loadState();
  openRecipe(res.id || id);
  toast('Receta guardada');
}

// Producto
function openProduct(id) {
  const p = id ? IDX.products.get(id) : null;
  const used = p ? (IDX.usedIn[p.id] || []) : [];
  const best = p && bestPrice(p.id);
  const html = sheetHead(p ? p.name : 'Nuevo producto', 'Cerrar', 'Guardar', 'save-product') + `
    <form id="product-form" data-form="product" data-id="${p ? p.id : ''}" autocomplete="off">
      <label class="field"><span>Nombre</span><input name="name" required value="${esc(p?.name)}" placeholder="Garbanzos cocidos"></label>
      <div class="grid2">
        <label class="field"><span>Categoría</span><input name="category" list="dl-cats" value="${esc(p?.category)}" placeholder="Despensa"></label>
        <label class="field"><span>Unidad / formato</span><input name="unit" value="${esc(p?.unit)}" placeholder="bote 400 g"></label>
      </div>
      <datalist id="dl-cats">${IDX.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="card">
        <div class="switch-row"><div>Lo tenemos en casa</div><label class="switch"><input type="checkbox" name="in_stock" ${p?.in_stock ? 'checked' : ''}><i></i></label></div>
        <div class="switch-row"><div>Básico / especia<small>No se gasta al cocinar; avisad vosotros cuando se acabe</small></div><label class="switch"><input type="checkbox" name="staple" ${p?.staple ? 'checked' : ''}><i></i></label></div>
      </div>
      <div class="spacer"></div>
      <label class="field"><span>Notas</span><textarea name="notes" style="min-height:60px" placeholder="Marca preferida, dónde está…">${esc(p?.notes)}</textarea></label>
      ${p ? '' : '<button class="btn primary block" type="submit">Crear producto</button>'}
    </form>
    ${p ? `
      <div class="section-title">Precio por ${esc(p.unit || 'unidad')} y calidad<button class="btn small link" data-act="stores">Supermercados</button></div>
      ${S.data.stores.length ? `<div class="card">${S.data.stores.map((s) => priceRow(p, s, best)).join('')}</div>
      <p class="hint">Se guarda al salir de cada casilla. Deja el precio vacío si no lo venden.</p>` : empty('Sin supermercados', 'Añade supermercados para comparar precios.')}
      ${used.length ? `<div class="section-title">Se usa en</div><div class="card"><div class="list">${used.map((r) => `<button class="row" data-act="open-recipe" data-id="${r.id}"><span class="main">${esc(r.name)}</span>${ICON.chev}</button>`).join('')}</div></div>` : ''}
      <div class="btn-row">
        ${IDX.shoppingByProduct.has(p.id) ? '<button class="btn" disabled>Ya está en la compra</button>' : `<button class="btn" data-act="product-to-list" data-id="${p.id}">Añadir a la compra</button>`}
      </div>
      <div class="btn-row"><button class="btn danger" data-act="delete-product" data-id="${p.id}">Eliminar producto</button></div>` : ''}`;
  openSheet(html, { kind: 'product', id });
}
function priceRow(p, s, best) {
  const pr = IDX.prices[p.id]?.[s.id] || {};
  const isBest = best && best.store_id === s.id;
  return `<div class="price-row"><div><div class="store">${esc(s.name)} ${isBest ? '<span class="pill ok">Más barato</span>' : ''}</div>
    <div class="stars" role="group" aria-label="Calidad en ${esc(s.name)}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${pr.quality >= n ? 'on' : ''}" data-act="set-quality" data-p="${p.id}" data-s="${s.id}" data-q="${n}" aria-label="${n} estrellas">★</button>`).join('')}</div></div>
    <input class="input num" inputmode="decimal" placeholder="€" value="${pr.price != null ? String(pr.price).replace('.', ',') : ''}" data-change="set-price" data-p="${p.id}" data-s="${s.id}"></div>`;
}

async function saveProduct(form) {
  const fd = new FormData(form);
  const body = {
    name: fd.get('name'), category: fd.get('category'), unit: fd.get('unit'), notes: fd.get('notes'),
    in_stock: fd.get('in_stock') === 'on', staple: fd.get('staple') === 'on',
  };
  if (!body.name.trim()) return toast('Ponle un nombre');
  const id = form.dataset.id ? Number(form.dataset.id) : null;
  if (id) {
    await api('PATCH', `/api/products/${id}`, body);
    closeSheet();
    toast('Guardado');
  } else {
    const p = await api('POST', '/api/products', body);
    await loadState();
    openProduct(p.id);
    toast('Creado. Ahora puedes añadir precios.');
  }
}

// Supermercados
function openStores() {
  const html = sheetHead('Supermercados', 'Listo') + `
    <div class="card">${S.data.stores.map((s) => `<div class="price-row" style="grid-template-columns:1fr auto">
      <input class="input" style="text-align:left" value="${esc(s.name)}" data-change="rename-store" data-id="${s.id}" aria-label="Nombre">
      <button class="btn small danger" data-act="delete-store" data-id="${s.id}">Borrar</button></div>`).join('') || '<div class="empty">Ninguno todavía</div>'}</div>
    <div class="spacer"></div>
    <form data-form="add-store" class="ing-row" style="grid-template-columns:1fr auto" autocomplete="off">
      <input class="input" name="name" placeholder="Nuevo supermercado" required>
      <button class="btn primary small">Añadir</button></form>`;
  openSheet(html, { kind: 'stores', live: () => { if (!document.activeElement || !$('#sheet').contains(document.activeElement)) openStores(); } });
}

// Elemento de la lista
function openShopItem(id) {
  const s = S.data.shopping.find((x) => x.id === id);
  if (!s) return;
  const html = sheetHead(s.name, 'Cerrar') + `
    <form data-form="shop-item" data-id="${s.id}" autocomplete="off">
      <label class="field"><span>Cantidad</span><input name="quantity" value="${esc(s.quantity)}" placeholder="2 kg"></label>
      ${s.source ? `<p class="hint">Para: ${esc(s.source)}</p>` : ''}
      <button class="btn primary block">Guardar</button></form>
    <div class="btn-row"><button class="btn" data-act="open-product" data-id="${s.product_id}">Ver producto y precios</button></div>
    <div class="btn-row"><button class="btn danger" data-act="delete-shop" data-id="${s.id}">Quitar de la lista</button></div>`;
  openSheet(html, { kind: 'shop', id });
}

// Hemos cocinado
function openCooked() {
  const needs = plannedNeeds();
  const consumable = needs.filter((n) => !n.p.staple);
  const staples = needs.filter((n) => n.p.staple);
  const html = sheetHead('¡A comer!', 'Cancelar', 'Confirmar', 'confirm-cooked') + `
    <p class="muted" style="margin:4px 4px 12px">Marca lo que se ha gastado. Pasará a «falta» en la despensa. Las recetas saldrán de la semana.</p>
    ${consumable.length ? `<div class="card"><div class="list">${consumable.map((n) => `
      <label class="row"><input type="checkbox" name="consume" value="${n.p.id}" checked style="width:22px;height:22px;accent-color:var(--accent)">
      <span class="main"><div class="title">${esc(n.p.name)}</div><div class="meta">${esc(n.qty.join(' + '))}</div></span></label>`).join('')}</div></div>` : ''}
    ${staples.length ? `<div class="section-title">Básicos (no se gastan)</div><div class="card pad small muted">${esc(staples.map((n) => n.p.name).join(', '))}</div>` : ''}
    <div class="btn-row"><button class="btn primary" data-act="confirm-cooked">Confirmar</button></div>`;
  openSheet(html, { kind: 'cooked' });
}

// ---------------------------------------------------------------- acciones --
const ACTIONS = {
  'close-sheet': () => closeSheet(),
  'new-recipe': () => editRecipe(null),
  'open-recipe': (t) => openRecipe(Number(t.dataset.id)),
  'edit-recipe': () => editRecipe(S.sheet.id),
  'save-recipe': () => { const f = $('#recipe-form'); if (f.reportValidity()) saveRecipe(f); },
  'add-ing': () => { $('#ing-rows').insertAdjacentHTML('beforeend', ingRow({ name: '', quantity: '' })); $$('#ing-rows input[name="ing-name"]').pop().focus(); },
  'rm-ing': (t) => t.closest('.ing-row').remove(),
  'delete-recipe': async (t) => {
    if (!confirm('¿Eliminar esta receta?')) return;
    await api('DELETE', `/api/recipes/${t.dataset.id}`);
    closeSheet(); toast('Receta eliminada');
  },
  'toggle-plan': (t) => {
    const id = Number(t.dataset.id);
    const r = S.data.recipes.find((x) => x.id === id);
    const planned = !r.planned;
    api('PATCH', `/api/recipes/${id}`, { planned }, { optimistic: (d) => { d.recipes.find((x) => x.id === id).planned = planned ? 1 : 0; } });
  },
  'generate-list': async () => {
    const r = await api('POST', '/api/plan/generate-list');
    toast(r.added ? `${plural(r.added, 'producto añadido', 'productos añadidos')} a la compra` : 'La lista ya estaba al día');
  },
  'cooked': () => openCooked(),
  'confirm-cooked': async () => {
    const ids = $$('#sheet input[name="consume"]:checked').map((i) => Number(i.value));
    await api('POST', '/api/plan/cooked', { consume_ids: ids });
    closeSheet(); toast('¡Semana cocinada! Despensa actualizada.');
  },
  'clear-plan': async () => { if (confirm('¿Quitar todas las recetas de esta semana?')) await api('POST', '/api/plan/clear'); },

  'toggle-shop': (t) => {
    const id = Number(t.dataset.id);
    const s = S.data.shopping.find((x) => x.id === id);
    const checked = s.checked ? 0 : 1;
    api('PATCH', `/api/shopping/${id}`, { checked: !!checked }, {
      optimistic: (d) => { d.shopping.find((x) => x.id === id).checked = checked; },
      queue: { kind: 'shop', id, checked },
    });
  },
  'shop-menu': (t) => openShopItem(Number(t.dataset.id)),
  'delete-shop': async (t) => { await api('DELETE', `/api/shopping/${t.dataset.id}`); closeSheet(); },
  'finish-shopping': async () => {
    const r = await api('POST', '/api/shopping/finish');
    toast(`${plural(r.stocked, 'producto', 'productos')} a la despensa`);
  },
  'clear-shopping': async () => { if (confirm('¿Vaciar toda la lista de la compra?')) await api('POST', '/api/shopping/clear'); },

  'new-product': () => openProduct(null),
  'open-product': (t) => openProduct(Number(t.dataset.id)),
  'save-product': () => { const f = $('#product-form'); if (f.reportValidity()) saveProduct(f); },
  'delete-product': async (t) => {
    const used = IDX.usedIn[Number(t.dataset.id)] || [];
    if (!confirm(used.length ? `Se quitará también de ${plural(used.length, 'receta', 'recetas')}. ¿Eliminar?` : '¿Eliminar este producto?')) return;
    await api('DELETE', `/api/products/${t.dataset.id}`);
    closeSheet(); toast('Producto eliminado');
  },
  'toggle-stock': async (t) => {
    const id = Number(t.dataset.id);
    const p = IDX.products.get(id);
    if (p.in_stock) {
      const r = await api('POST', `/api/products/${id}/out`, { add_to_list: true }, { optimistic: (d) => { d.products.find((x) => x.id === id).in_stock = 0; } });
      if (r.added) toast(`${p.name}: añadido a la compra`);
    } else {
      api('PATCH', `/api/products/${id}`, { in_stock: true }, {
        optimistic: (d) => { d.products.find((x) => x.id === id).in_stock = 1; },
        queue: { kind: 'stock', id, in_stock: 1 },
      });
    }
  },
  'product-to-list': async (t) => {
    const p = IDX.products.get(Number(t.dataset.id));
    await api('POST', '/api/shopping', { name: p.name });
    closeSheet(); toast('Añadido a la compra');
  },
  'f-despensa': (t) => { S.ui.fDespensa = t.dataset.f; render(); },
  'set-quality': async (t) => {
    const pid = Number(t.dataset.p); const sid = Number(t.dataset.s); const q = Number(t.dataset.q);
    const cur = IDX.prices[pid]?.[sid] || {};
    const quality = cur.quality === q ? null : q;
    $$(`#sheet .stars button[data-p="${pid}"][data-s="${sid}"]`).forEach((b) => b.classList.toggle('on', quality >= Number(b.dataset.q)));
    await api('PUT', '/api/prices', { product_id: pid, store_id: sid, price: cur.price ?? null, quality });
  },

  'stores': () => openStores(),
  'delete-store': async (t) => {
    if (!confirm('¿Borrar este supermercado y sus precios?')) return;
    await api('DELETE', `/api/stores/${t.dataset.id}`);
    await loadState(); openStores();
  },
  'opt': (t) => { S.ui.opt[t.dataset.k] = Number(t.dataset.v); store.set('opt', S.ui.opt); render(); },
};

const CHANGES = {
  'plan-recipe': (t) => ACTIONS['toggle-plan'](t),
  'set-price': async (t) => {
    const pid = Number(t.dataset.p); const sid = Number(t.dataset.s);
    const price = t.value.trim() === '' ? null : parseNum(t.value);
    if (t.value.trim() !== '' && price == null) return toast('Precio no válido');
    const cur = IDX.prices[pid]?.[sid] || {};
    await api('PUT', '/api/prices', { product_id: pid, store_id: sid, price, quality: cur.quality ?? null });
    toast('Precio guardado');
  },
  'rename-store': (t) => { if (t.value.trim()) api('PATCH', `/api/stores/${t.dataset.id}`, { name: t.value }); },
  'opt-weight': (t) => { S.ui.opt.qWeight = Number(t.value) / 100; store.set('opt', S.ui.opt); render(); },
};

const INPUTS = {
  'q-recetas': (t) => { S.ui.qRecetas = t.value; $('#list-area').innerHTML = recetasList(); },
  'q-despensa': (t) => { S.ui.qDespensa = t.value; $('#list-area').innerHTML = despensaList(); },
};

const FORMS = {
  'recipe': (f) => saveRecipe(f),
  'product': (f) => saveProduct(f),
  'add-shopping': async (f) => {
    const fd = new FormData(f);
    await api('POST', '/api/shopping', { name: fd.get('name'), quantity: fd.get('quantity') });
    f.reset(); f.querySelector('input').focus();
  },
  'add-store': async (f) => {
    await api('POST', '/api/stores', { name: new FormData(f).get('name') });
    await loadState(); openStores();
  },
  'shop-item': async (f) => {
    await api('PATCH', `/api/shopping/${f.dataset.id}`, { quantity: new FormData(f).get('quantity') });
    closeSheet();
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab], [data-tab-go]');
  if (tab) { switchTab(tab.dataset.tab || tab.dataset.tabGo); return; }
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  if (t.tagName === 'LABEL' || e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  Promise.resolve(ACTIONS[t.dataset.act]?.(t, e)).catch(() => {});
});
document.addEventListener('change', (e) => { const h = CHANGES[e.target.dataset.change]; if (h) Promise.resolve(h(e.target)).catch(() => {}); });
document.addEventListener('input', (e) => { const h = INPUTS[e.target.dataset.input]; if (h) h(e.target); });
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  Promise.resolve(FORMS[f.dataset.form](f)).catch(() => {});
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) closeSheet(); });

function switchTab(tab) {
  if (!VIEWS[tab]) return;
  S.tab = tab;
  store.set('tab', tab);
  render();
  window.scrollTo(0, 0);
}

// ----------------------------------------------------------------- avisos --
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ----------------------------------------------------------------- acceso --
function showLogin() {
  if (S.es) { S.es.close(); S.es = null; }
  document.body.classList.add('logged-out');
  closeSheet();
  $('#view').innerHTML = $('#login-tpl').innerHTML;
  const form = $('#login-form');
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', '/api/login', { password: new FormData(form).get('password') });
      start();
    } catch { btn.disabled = false; }
  });
}

async function start() {
  document.body.classList.remove('logged-out');
  if (S.data) { index(); render(); }
  const ok = await fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.status !== 401).catch(() => true);
  if (!ok) return showLogin();
  await loadState();
  connectEvents();
}

document.addEventListener('visibilitychange', () => {
  // iOS corta las conexiones al pasar la app a segundo plano: reconectamos al volver.
  if (document.visibilityState === 'visible' && !document.body.classList.contains('logged-out')) { loadState(); connectEvents(); }
});
window.addEventListener('online', () => loadState());
window.addEventListener('offline', () => setOnline(false));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
