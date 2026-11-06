/* Dish costs (Invoices → Costs → Dishes): the cost of each dish on the menu.
   For every dish: the menu price, how much of each ingredient goes on one
   plate (g, kg, ml, l, each), and what that costs. A dish can have more than
   one size (e.g. Entrée and Main), each with its own price and amounts.
   A line's price comes from, in order:
     1. a product chosen for that line from the invoices (e.g. Prawns → HTC
        prawn cutlet 13/15), with what one invoice line buys (1 × 21 each);
     2. the ingredient's invoice link (Costs → Ingredient prices);
     3. a price typed by hand for the ingredient.
   A sauce or prep made in the kitchen costs what its own recipe costs per
   kg / litre / each (when "one batch makes" is filled in), or a price typed
   by hand. The sums are done here; the server only stores the numbers.
   Administrator and Kitchen Manager only (the server refuses everyone else). */
(() => {
const $ = id => document.getElementById(id);
const t = v => escapeHtml(String(v ?? ''));
const money = n => n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => { const s = String(v ?? '').trim().replace(',', '.'); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const fmt = n => Number(n).toLocaleString('en-AU', { maximumFractionDigits: 3 });
const UNITS = ['g', 'kg', 'ml', 'l', 'each'];
const PREP = ['Sauce', 'Dressing', 'Prep'];
const GST = 1.1;
const sizeName = (s, many) => s || (many ? 'Regular' : 'Standard');

/* ---------- the sums (pure; window.MarinaraDishCost for tests) ---------- */
const toBase = (qty, unit) => unit === 'g' ? { q: qty / 1000, u: 'kg' } : unit === 'ml' ? { q: qty / 1000, u: 'l' } : { q: qty, u: unit };
const sameKind = (a, b) => a === b || (a === 'kg' && b === 'l') || (a === 'l' && b === 'kg'); // sauces: 1 kg ≈ 1 litre
// What one invoice line buys, in kg / l / each, and the price of one of those.
function productPrice(pr) {
  if (!pr || pr.price == null) return null;
  const b = toBase(Number(pr.pack_count) * Number(pr.pack_size), pr.pack_unit);
  if (!(b.q > 0)) return null;
  return { price: Number(pr.price) / b.q, unit: b.u, src: 'product', label: `${pr.supplier}: ${pr.label || pr.product_key}` };
}
// One size of a recipe, as lines with their amounts.
function view(r, size) {
  const sizes = r.sizes || [];
  const s = (size == null ? sizes[0] : sizes.find(x => x.size === size)) || { size: size || '', portions: [] };
  const por = new Map((s.portions || []).map(p => [`${p.kind}|${p.ref_id}`, p]));
  return { ...r, size: s.size, sell_price: s.sell_price ?? null, yield_qty: s.yield_qty ?? null, yield_unit: s.yield_unit ?? null,
    lines: (r.lines || []).map(l => { const p = por.get(`${l.kind}|${l.ref_id}`); return { ...l, qty: p ? p.qty : null, unit: p ? p.unit : null, product: p ? p.product : null }; }) };
}
function engine(data) {
  const ing = new Map((data.ingredients || []).map(i => [i.id, i]));
  const rec = new Map((data.recipes || []).map(r => [r.id, r]));
  const memo = new Map();
  function priceOf(kind, id, seen) {
    if (kind === 'ingredient') {
      const i = ing.get(id);
      if (!i) return null;
      if (i.invoice) return { price: Number(i.invoice.price), unit: i.invoice.unit, src: 'invoice', label: `${i.invoice.supplier} invoice` };
      if (i.manual) return { price: Number(i.manual.price), unit: i.manual.unit, src: 'manual', label: i.manual.note || 'typed by hand' };
      return null;
    }
    const r = rec.get(id);
    if (!r) return null;
    const v = view(r);
    const c = cost(v, seen);
    if (c.complete && c.counted && v.yield_qty && v.yield_unit) {
      const y = toBase(Number(v.yield_qty), v.yield_unit);
      return { price: c.cost / y.q, unit: y.u, src: 'recipe', label: 'from its recipe' };
    }
    if (r.manual) return { price: Number(r.manual.price), unit: r.manual.unit, src: 'manual', label: r.manual.note || 'typed by hand' };
    return null;
  }
  function lineCost(l, seen) {
    if (!l.qty || !l.unit) return { counted: false };
    const p = productPrice(l.product) || priceOf(l.kind, l.ref_id, seen);
    if (!p) return { counted: true, missing: true };
    const b = toBase(Number(l.qty), l.unit);
    if (!sameKind(b.u, p.unit)) return { counted: true, mismatch: true, p };
    return { counted: true, cost: b.q * p.price, p };
  }
  // v: a recipe view (one size). seen: recipes on the way here (no loops).
  function cost(v, seen = new Set()) {
    const key = `${v.id}|${v.size}`;
    if (!seen.size && memo.has(key)) return memo.get(key);
    if (seen.has(v.id)) return { cost: 0, counted: 0, complete: false, lines: [] };
    const next = new Set(seen); next.add(v.id);
    let total = 0, counted = 0, complete = true;
    const lines = v.lines.map(l => {
      // A prep whose only line is itself (e.g. "Pizza dough") has no recipe yet.
      const self = l.kind === 'ingredient' && String(l.name).toLowerCase() === String(v.name).toLowerCase();
      const c = self ? { counted: false, self: true } : lineCost(l, next);
      if (c.counted) { counted++; if (c.cost == null) complete = false; else total += c.cost; }
      return { ...l, c };
    });
    const out = { cost: total, counted, complete, lines };
    if (!seen.size) memo.set(key, out);
    return out;
  }
  function dish(v) {
    const c = cost(v);
    const ex = v.sell_price ? Number(v.sell_price) / GST : null;
    return { ...c, ex, pct: ex && c.counted ? c.cost / ex * 100 : null, left: ex && c.counted ? ex - c.cost : null };
  }
  return { priceOf, cost, dish, view };
}
window.MarinaraDishCost = { engine, view, toBase, productPrice };

/* ---------- screen ---------- */
const state = { mode: 'dishes', data: null, eng: null, filter: 'dishes', q: '', open: null, size: null, draft: null, priceFor: null, pick: null, addSize: false, removeArm: false, busy: false };
let built = false;
function build() {
  if (built) return; built = true;
  const box = $('invCostsView');
  const old = document.createElement('div'); old.id = 'dcIngredients';
  while (box.firstChild) old.append(box.firstChild);
  box.innerHTML = `<div class="rm-chips dc-switch" id="dcSwitch">
      <button type="button" data-dc-mode="dishes" aria-pressed="true">Dishes</button>
      <button type="button" data-dc-mode="ingredients" aria-pressed="false">Ingredient prices</button></div>
    <div id="dcDishes">
      <p class="inv-hint">The cost of each dish: the menu price, how much of each ingredient goes on one plate, and its price from your invoices (or typed by hand). Tap a dish to change the amounts.</p>
      <div class="card"><div id="dcSummary" class="empty-state">Loading…</div></div>
      <div class="stock-chips" id="dcFilter">
        <button type="button" data-dc-filter="dishes" class="selected">Dishes</button>
        <button type="button" data-dc-filter="todo">Missing a price</button>
        <button type="button" data-dc-filter="prep">Sauces & prep</button></div>
      <input id="dcSearch" class="inv-search" type="search" placeholder="Search a dish" autocomplete="off">
      <div id="dcList" class="empty-state">Loading…</div>
    </div>`;
  box.append(old);
  $('dcSwitch').addEventListener('click', e => { const b = e.target.closest('[data-dc-mode]'); if (b) setMode(b.dataset.dcMode); });
  $('dcFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-dc-filter]'); if (!b) return;
    state.filter = b.dataset.dcFilter;
    document.querySelectorAll('#dcFilter [data-dc-filter]').forEach(x => x.classList.toggle('selected', x === b));
    render();
  });
  $('dcSearch').addEventListener('input', e => { state.q = e.target.value; render(); });
  $('dcList').addEventListener('click', onClick);
  $('dcList').addEventListener('input', onInput);
  $('dcList').addEventListener('change', onInput);
}
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('#dcSwitch [data-dc-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dcMode === m)));
  $('dcDishes').hidden = m !== 'dishes';
  $('dcIngredients').hidden = m !== 'ingredients';
  if (m === 'dishes') load();
}
async function load() {
  try {
    state.data = await managerApi('manager_dish_costs');
    state.eng = engine(state.data);
    render();
  } catch (error) {
    const b = $('dcSummary'); b.className = 'empty-state'; b.textContent = error.message || 'Unable to load dish costs.';
    $('dcList').className = 'empty-state'; $('dcList').textContent = '';
  }
}
const pctClass = p => p == null ? '' : p < 25 ? 'ok' : p < 32 ? 'mid' : 'hi';
const isPrep = r => PREP.includes(r.category);
const missing = r => { const v = view(r); const d = state.eng.dish(v); return !d.complete || !v.sell_price || !d.counted; };

function summary() {
  const dishes = state.data.recipes.filter(r => !isPrep(r)).map(r => ({ r, d: state.eng.dish(view(r)) }));
  const priced = dishes.filter(x => x.d.pct != null);
  const avg = priced.length ? priced.reduce((a, x) => a + x.d.pct, 0) / priced.length : null;
  const high = priced.filter(x => x.d.pct >= 32).length;
  const todo = state.data.recipes.filter(r => !isPrep(r) && missing(r)).length;
  $('dcSummary').className = '';
  $('dcSummary').innerHTML = `<div class="inv-use-kpis">
      <div><strong>${avg == null ? '—' : avg.toFixed(1) + '%'}</strong><span>Average food cost</span></div>
      <div><strong>${high}</strong><span>At 32% or more</span></div>
      <div><strong>${todo}</strong><span>Missing something</span></div>
    </div><div class="inv-use-note">Food cost = ingredients per plate ÷ menu price without GST. A usual target is 25–32%.</div>`;
}
function render() {
  if (!state.data) return;
  summary();
  const q = state.q.trim().toLowerCase();
  const rows = state.data.recipes.filter(r => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (r.id === state.open) return true;
    if (state.filter === 'prep') return isPrep(r);
    if (isPrep(r)) return false;
    if (state.filter === 'todo') return missing(r);
    return true;
  });
  const box = $('dcList');
  box.className = rows.length ? 'dc-list' : 'empty-state';
  box.innerHTML = rows.length ? rows.map(row).join('') : (state.filter === 'todo' ? 'Every dish has its amounts and prices.' : 'Nothing here.');
}
function row(r) {
  const open = state.open === r.id;
  const sizes = r.sizes && r.sizes.length ? r.sizes : [{ size: '' }];
  let right, sub;
  if (isPrep(r)) {
    const p = state.eng.priceOf('recipe', r.id);
    const v = view(r);
    right = p ? `<span class="val">${money(p.price)}/${t(p.unit)}</span>` : `<span class="val todo">No price</span>`;
    sub = `${t(r.category)}${v.yield_qty ? ` · one batch makes ${t(fmt(v.yield_qty))} ${t(v.yield_unit)}` : ''}${r.manual ? ` · ${money(r.manual.price)}/${t(r.manual.unit)} by hand` : ''}`;
  } else {
    const parts = sizes.map(s => { const v = view(r, s.size); return { v, d: state.eng.dish(v) }; });
    const d = parts[0].d, v = parts[0].v;
    right = d.pct != null ? `<span class="dc-pct ${pctClass(d.pct)}">${d.pct.toFixed(1)}%</span>` : `<span class="val todo">${!v.sell_price ? 'No menu price' : 'No amounts'}</span>`;
    sub = parts.length > 1
      ? `${t(r.category)} · ` + parts.map(({ v, d }) => `${t(sizeName(v.size, true))} ${v.sell_price ? money(v.sell_price) : '—'}${d.pct != null ? ` (${d.pct.toFixed(1)}%)` : ''}`).join(' · ')
      : `${t(r.category)} · ${v.sell_price ? `menu ${money(v.sell_price)}` : 'no menu price'}${d.counted ? ` · cost ${money(d.cost)}${d.complete ? '' : ' + missing'}` : ''}`;
  }
  return `<div class="inv-cost dc-dish${open ? ' open' : ''}" data-dc-id="${t(r.id)}">
    <button type="button" class="inv-cost-head" data-dc-open="${t(r.id)}" aria-expanded="${open}"><strong>${t(r.name)}</strong>${right}<small>${sub}</small></button>
    ${open ? editor(r) : ''}</div>`;
}
function draftOf(r) {
  const size = state.size ?? (r.sizes && r.sizes[0] ? r.sizes[0].size : '');
  if (!state.draft || state.draft.id !== r.id || state.draft.size !== size) {
    const v = view(r, size);
    state.draft = { id: r.id, size, isNew: !(r.sizes || []).some(s => s.size === size),
      sell_price: v.sell_price ?? '', yield_qty: v.yield_qty ?? '', yield_unit: v.yield_unit || 'kg',
      lines: v.lines.map(l => ({ kind: l.kind, ref_id: l.ref_id, qty: l.qty ?? '', unit: l.unit || (l.kind === 'recipe' ? 'ml' : 'g'), product: l.product || null })) };
  }
  return state.draft;
}
// The size as it would be with the draft, so the sums follow the typing.
function withDraft(r, dr) {
  return { ...r, size: dr.size, sell_price: num(dr.sell_price) || null, yield_qty: num(dr.yield_qty) || null, yield_unit: dr.yield_unit,
    lines: r.lines.map((l, i) => ({ ...l, qty: num(dr.lines[i].qty) || null, unit: dr.lines[i].unit, product: dr.lines[i].product })) };
}
const unitSel = (val, attrs, list = UNITS) => `<select ${attrs}>${list.map(u => `<option value="${u}"${u === val ? ' selected' : ''}>${u}</option>`).join('')}</select>`;
function editor(r) {
  const dr = draftOf(r);
  const v = withDraft(r, dr);
  const live = engine(state.data);
  const lr = live.dish(v);
  const prep = isPrep(r);
  const sizes = (r.sizes || []).map(s => s.size);
  if (!sizes.length) sizes.push('');
  if (dr.isNew && !sizes.includes(dr.size)) sizes.push(dr.size);
  const many = sizes.length > 1;
  const tabs = prep ? '' : `<div class="dc-sizes" role="tablist" aria-label="Sizes">
      ${sizes.map(s => `<button type="button" role="tab" data-dc-size="${t(s)}" aria-selected="${s === dr.size}">${t(sizeName(s, many))}</button>`).join('')}
      ${state.addSize ? `<span class="dc-addsize"><input type="text" id="dcNewSize-${t(r.id)}" maxlength="30" placeholder="e.g. Main, 1 doz" aria-label="Name of the new size"><button type="button" class="save" data-dc-addsize-ok>Add</button></span>`
        : `<button type="button" class="dc-size-add" data-dc-addsize>+ Size</button>`}
    </div>${many ? `<small class="dc-tip">Each size has its own menu price and amounts.${dr.size ? ` <button type="button" class="linkish" data-dc-size-remove>${state.removeArm ? 'Tap again to remove this size' : 'Remove this size'}</button>` : ''}</small>` : ''}`;
  const lines = lr.lines.map((l, i) => {
    const c = l.c;
    const pr = dr.lines[i].product;
    const p = c.p || productPrice(pr) || state.eng.priceOf(l.kind, l.ref_id);
    const priceTxt = c.self ? 'the recipe still needs its real ingredients'
      : pr ? `${money(productPrice(pr)?.price)}/${t(productPrice(pr)?.unit || '')} · ${t(pr.supplier)}: ${t(pr.label || pr.product_key)} (${t(fmt(pr.pack_count))} × ${t(fmt(pr.pack_size))} ${t(pr.pack_unit)})`
      : p ? `${money(p.price)}/${t(p.unit)} · ${t(p.label)}` : 'No price yet';
    const costTxt = !c.counted ? '' : c.missing ? '<span class="dc-miss">no price</span>' : c.mismatch ? `<span class="dc-miss">use ${p.unit === 'each' ? 'each' : 'g / ml'}</span>` : money(c.cost);
    const links = c.self ? '' : [
      l.kind === 'ingredient' ? `<button type="button" class="linkish" data-dc-pick="${i}">${pr ? 'Change product' : 'Choose a product'}</button>` : '',
      pr ? `<button type="button" class="linkish" data-dc-unpick="${i}">Use the usual price</button>` : '',
      !pr && !(p && (p.src === 'invoice' || p.src === 'recipe')) ? `<button type="button" class="linkish" data-dc-price="${t(l.kind)}|${t(l.ref_id)}">${p ? 'Change price' : 'Set price'}</button>` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="dc-line${c.counted ? '' : ' off'}">
      <div class="dc-line-name"><strong>${t(l.name)}${l.kind === 'recipe' ? ' <em>(made here)</em>' : ''}</strong>
        <small>${l.quantity ? `Recipe says: ${t(l.quantity)} · ` : ''}${priceTxt}${links ? ` · ${links}` : ''}</small>
        ${state.priceFor === `${l.kind}|${l.ref_id}` ? priceForm(l, p) : ''}
        ${state.pick && state.pick.i === i ? pickForm(l, i) : ''}</div>
      <div class="dc-line-qty"><input type="text" inputmode="decimal" id="dcq-${t(r.id)}-${i}" data-dc-q="${i}" value="${t(dr.lines[i].qty)}" placeholder="—" aria-label="Amount of ${t(l.name)}">
        ${unitSel(dr.lines[i].unit, `data-dc-u="${i}" aria-label="Unit of ${t(l.name)}"`)}</div>
      <div class="dc-line-cost">${costTxt}</div></div>`;
  }).join('');
  const totals = prep
    ? (() => { const p = live.priceOf('recipe', r.id); return `<div class="dc-total"><span>Batch cost</span><b>${lr.counted ? money(lr.cost) : '—'}${lr.complete ? '' : ' + missing'}</b></div>
       <div class="dc-total"><span>Cost per ${t(p?.unit || 'unit')}</span><b>${p ? money(p.price) : '—'}</b></div>`; })()
    : `<div class="dc-total"><span>Food cost per plate</span><b>${lr.counted ? money(lr.cost) : '—'}${lr.counted && !lr.complete ? ' + missing' : ''}</b></div>
       <div class="dc-total"><span>Menu price without GST</span><b>${lr.ex ? money(lr.ex) : '—'}</b></div>
       <div class="dc-total"><span>Food cost %</span><b class="${pctClass(lr.pct)}">${lr.pct == null ? '—' : lr.pct.toFixed(1) + '%'}</b></div>
       <div class="dc-total"><span>Left over per plate</span><b>${lr.left == null ? '—' : money(lr.left)}</b></div>`;
  return `<div class="dc-edit">
    ${tabs}
    ${prep ? `<div class="dc-field"><label for="dcy-${t(r.id)}">One batch makes</label><div class="dc-row">
        <input type="text" inputmode="decimal" id="dcy-${t(r.id)}" data-dc-yield value="${t(dr.yield_qty)}" placeholder="e.g. 10">
        ${unitSel(dr.yield_unit, `data-dc-yield-unit aria-label="Batch unit"`)}</div>
        <small>${r.makes ? `Recipe says: ${t(r.makes)}. ` : ''}With this filled in, its cost per kg / litre / each comes from the ingredients below.</small></div>
        <div class="dc-field"><span class="dc-label">Or a price by hand</span><small>${r.manual ? `${money(r.manual.price)}/${t(r.manual.unit)}${r.manual.note ? ` · ${t(r.manual.note)}` : ''} · ` : ''}<button type="button" class="linkish" data-dc-price="recipe|${t(r.id)}">${r.manual ? 'Change' : 'Set a price'}</button></small>
        ${state.priceFor === `recipe|${r.id}` ? priceForm({ kind: 'recipe', ref_id: r.id, name: r.name }, r.manual ? { ...r.manual, src: 'manual', label: r.manual.note || 'typed by hand' } : null) : ''}</div>`
      : `<div class="dc-field"><label for="dcs-${t(r.id)}">Menu price${many ? ` · ${t(sizeName(dr.size, true))}` : ''} (with GST)</label><div class="dc-row"><span class="dc-dollar">$</span>
        <input type="text" inputmode="decimal" id="dcs-${t(r.id)}" data-dc-sell value="${t(dr.sell_price)}" placeholder="e.g. 35.90"></div></div>`}
    <div class="dc-lines-head"><span>${prep ? 'In one batch' : 'On one plate'}</span><span>Amount</span><span>Cost</span></div>
    ${lines || '<div class="empty-state">This recipe has no ingredients yet. Add them in Recipes.</div>'}
    <p class="dc-tip">Leave an amount empty to leave it out (e.g. a choice of pasta: fill in only one).</p>
    <div class="dc-totals">${totals}</div>
    <div class="inv-cost-actions"><button type="button" data-dc-close>Close</button><button type="button" class="save" data-dc-save="${t(r.id)}">Save${many ? ` ${t(sizeName(dr.size, true))}` : ''}</button></div>
  </div>`;
}
function priceForm(l, p) {
  const cur = p && p.src === 'manual' ? p : null;
  return `<div class="dc-price-form">
    <div class="dc-row"><span class="dc-dollar">$</span><input type="text" inputmode="decimal" id="dcp-${t(l.ref_id)}" data-dc-pp value="${cur ? t(fmt(cur.price)) : ''}" placeholder="price">
      <select data-dc-pu aria-label="Per">${['kg', 'l', 'each'].map(u => `<option value="${u}"${cur && cur.unit === u ? ' selected' : ''}>per ${u === 'l' ? 'litre' : u}</option>`).join('')}</select></div>
    <input type="text" id="dcn-${t(l.ref_id)}" data-dc-pn maxlength="200" value="${cur && cur.label !== 'typed by hand' ? t(cur.label) : ''}" placeholder="Note (e.g. $18.50 a dozen)">
    <small>Used in every dish with ${t(l.name)}. A price from an invoice link takes over when there is one.</small>
    <div class="inv-cost-actions">${cur ? `<button type="button" data-dc-price-remove="${t(l.kind)}|${t(l.ref_id)}">Remove</button>` : ''}<button type="button" data-dc-price-cancel>Cancel</button><button type="button" class="save" data-dc-price-save="${t(l.kind)}|${t(l.ref_id)}">Save price</button></div></div>`;
}

/* ---------- choose a product from the invoices, for one line ---------- */
const R = () => window.MarinaraInvoiceReader;
function matches(q) {
  const prods = state.data.products || [];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const score = p => {
    const d = `${p.description} ${p.supplier}`.toLowerCase();
    if (words.length && words.every(w => d.includes(w))) return 10 + (R()?.matchScore ? R().matchScore(q, p.description) : 0);
    return R()?.matchScore ? R().matchScore(q, p.description) : 0;
  };
  return prods.map(p => ({ p, s: score(p) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || String(b.p.date).localeCompare(String(a.p.date))).slice(0, 8).map(x => x.p);
}
// Prawn and similar sizes ("13/15", "16/20" pieces per pound): about how many in a pack.
function piecesGuess(desc, pack) {
  const m = String(desc).match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  if (!m || !pack || !['kg', 'g'].includes(pack.unit)) return null;
  const kg = pack.count * pack.size / (pack.unit === 'g' ? 1000 : 1);
  const per = (Number(m[1]) + Number(m[2])) / 2;
  return { n: Math.round(kg / 0.4536 * per), label: `${m[1]}/${m[2]}`, range: `${m[1]} to ${m[2]}` };
}
function pickForm(l, i) {
  const pk = state.pick;
  if (!pk.product) {
    const list = matches(pk.q);
    return `<div class="dc-price-form dc-pick">
      <input type="search" id="dcPickQ-${i}" data-dc-pick-q value="${t(pk.q)}" placeholder="Type a product (e.g. prawn 13/15)" autocomplete="off" aria-label="Search your invoice products">
      <div class="dc-pick-list">${list.length ? list.map((p, k) => `<button type="button" data-dc-pick-choose="${k}"><strong>${t(p.description)}</strong><small>${t(p.supplier)} · ${money(p.price)}${p.unit ? ` per ${t(p.unit)}` : ''}${p.date ? ` · ${t(p.date)}` : ''}</small></button>`).join('') : '<small>No product from your invoices matches. Try fewer words.</small>'}</div>
      <div class="inv-cost-actions"><button type="button" data-dc-pick-cancel>Cancel</button></div></div>`;
  }
  const p = pk.product;
  const pr = { ...pk.pack, price: p.price };
  const each = productPrice({ supplier: p.supplier, label: p.description, price: p.price, pack_count: num(pk.pack.count), pack_size: num(pk.pack.size), pack_unit: pk.pack.unit });
  const pcs = piecesGuess(p.description, { count: num(pk.pack.count), size: num(pk.pack.size), unit: pk.pack.unit });
  return `<div class="dc-price-form dc-pick">
    <strong>${t(p.description)}</strong><small>${t(p.supplier)} · ${money(p.price)}${p.unit ? ` per ${t(p.unit)}` : ''}</small>
    <span class="dc-label">What ${money(pr.price)} buys</span>
    <div class="dc-row"><input type="text" inputmode="decimal" id="dcPickC-${i}" data-dc-pack="count" value="${t(pk.pack.count)}" aria-label="How many packs"><span>×</span>
      <input type="text" inputmode="decimal" id="dcPickS-${i}" data-dc-pack="size" value="${t(pk.pack.size)}" aria-label="Pack size">
      ${unitSel(pk.pack.unit, 'data-dc-pack="unit" aria-label="Pack unit"')}</div>
    ${pcs ? `<small>${t(pcs.label)} means ${t(pcs.range)} pieces per pound (454 g): about <b>${pcs.n}</b> in this pack. <button type="button" class="linkish" data-dc-pack-pieces="${pcs.n}">Count it in pieces</button></small>` : ''}
    <small>${each ? `= ${money(each.price)} per ${t(each.unit)}. ` : ''}Only for this line of this dish; other dishes keep their own price.</small>
    <div class="inv-cost-actions"><button type="button" data-dc-pick-back>Back</button><button type="button" class="save" data-dc-pick-use>Use this product</button></div></div>`;
}

function rerenderOpen() {
  // Keep the cursor where it was while the sums follow the typing.
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  render();
  if (id && $(id)) { const el = $(id); el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (_) { /* select boxes */ } }
}
function onInput(e) {
  const el = e.target;
  if (el.matches('[data-dc-pick-q]')) { state.pick.q = el.value; if (e.type === 'input') rerenderOpen(); return; }
  if (el.matches('[data-dc-pack]')) { state.pick.pack[el.dataset.dcPack] = el.value; if (e.type === 'input' || el.tagName === 'SELECT') rerenderOpen(); return; }
  const dr = state.draft; if (!dr) return;
  if (el.matches('[data-dc-q]')) dr.lines[+el.dataset.dcQ].qty = el.value;
  else if (el.matches('[data-dc-u]')) dr.lines[+el.dataset.dcU].unit = el.value;
  else if (el.matches('[data-dc-sell]')) dr.sell_price = el.value;
  else if (el.matches('[data-dc-yield]')) dr.yield_qty = el.value;
  else if (el.matches('[data-dc-yield-unit]')) dr.yield_unit = el.value;
  else return;
  if (e.type === 'input' || el.tagName === 'SELECT') rerenderOpen();
}
function msg(text, ok) { if (typeof invMsg === 'function') invMsg(text, ok); }
const badNum = v => String(v ?? '').trim() !== '' && (num(v) === null || num(v) < 0);
async function reloadKeepingDraft() {
  const keep = state.draft;
  await load();
  if (keep) { state.draft = keep; render(); }
}
async function onClick(e) {
  const open = e.target.closest('[data-dc-open]');
  if (open) { const id = open.dataset.dcOpen; state.open = state.open === id ? null : id; state.size = null; state.draft = null; state.priceFor = null; state.pick = null; state.addSize = false; state.removeArm = false; render(); return; }
  if (e.target.closest('[data-dc-close]')) { state.open = null; state.size = null; state.draft = null; state.priceFor = null; state.pick = null; state.addSize = false; render(); return; }
  const r = state.data && state.data.recipes.find(x => x.id === state.open);
  const sz = e.target.closest('[data-dc-size]');
  if (sz && r) { state.size = sz.dataset.dcSize; state.draft = null; state.pick = null; state.priceFor = null; state.removeArm = false; render(); return; }
  if (e.target.closest('[data-dc-addsize]')) { state.addSize = true; rerenderOpen(); const i = document.querySelector('[id^="dcNewSize-"]'); if (i) i.focus(); return; }
  if (e.target.closest('[data-dc-addsize-ok]') && r) {
    const name = (document.querySelector('[id^="dcNewSize-"]')?.value || '').trim().slice(0, 30);
    const have = (r.sizes || []).map(s => s.size);
    if (!name || have.includes(name) || name.toLowerCase() === 'regular' || name.toLowerCase() === 'standard') { msg('Write a new name for the size (e.g. Main or 1 doz).', false); return; }
    // The new size starts with the same amounts and products as the one open now.
    const from = draftOf(r);
    state.addSize = false; state.size = name;
    state.draft = { ...from, size: name, isNew: true, sell_price: '', lines: from.lines.map(l => ({ ...l })) };
    render();
    msg(`New size "${name}": change its price and amounts, then Save.`, true);
    return;
  }
  const rm = e.target.closest('[data-dc-size-remove]');
  if (rm && r && state.draft) {
    if (!state.removeArm) { state.removeArm = true; rerenderOpen(); return; }
    state.removeArm = false;
    if (state.draft.isNew) { state.size = null; state.draft = null; render(); return; }
    try { state.busy = true; await managerApi('manager_dish_cost_save', { recipe_id: r.id, dish: { size: state.draft.size, remove: true } }); state.size = null; state.draft = null; await load(); msg('Size removed.', true); }
    catch (error) { msg(error.message || 'Unable to remove the size.', false); }
    finally { state.busy = false; }
    return;
  }
  const pr = e.target.closest('[data-dc-price]');
  if (pr) { state.pick = null; state.priceFor = state.priceFor === pr.dataset.dcPrice ? null : pr.dataset.dcPrice; rerenderOpen(); return; }
  if (e.target.closest('[data-dc-price-cancel]')) { state.priceFor = null; rerenderOpen(); return; }
  const pick = e.target.closest('[data-dc-pick]');
  if (pick && r) { const i = +pick.dataset.dcPick; state.priceFor = null; state.pick = state.pick && state.pick.i === i ? null : { i, q: r.lines[i].name, product: null, pack: null }; rerenderOpen(); const q = document.getElementById(`dcPickQ-${i}`); if (q) q.focus(); return; }
  if (e.target.closest('[data-dc-pick-cancel]')) { state.pick = null; rerenderOpen(); return; }
  const ch = e.target.closest('[data-dc-pick-choose]');
  if (ch && state.pick) {
    const p = matches(state.pick.q)[+ch.dataset.dcPickChoose]; if (!p) return;
    const g = R()?.packGuess ? R().packGuess(p.description, p.unit) : { count: 1, size: 1, unit: 'each' };
    state.pick.product = p; state.pick.pack = { count: String(g.count), size: String(g.size), unit: g.unit };
    rerenderOpen(); return;
  }
  if (e.target.closest('[data-dc-pick-back]')) { state.pick.product = null; rerenderOpen(); return; }
  const pcs = e.target.closest('[data-dc-pack-pieces]');
  if (pcs && state.pick) { state.pick.pack = { count: '1', size: pcs.dataset.dcPackPieces, unit: 'each' }; rerenderOpen(); return; }
  if (e.target.closest('[data-dc-pick-use]') && state.pick && state.draft) {
    const pk = state.pick, p = pk.product;
    const c = num(pk.pack.count), s = num(pk.pack.size);
    if (!(c > 0) || !(s > 0)) { msg('Write what one invoice line buys (e.g. 1 × 21 each).', false); return; }
    const line = state.draft.lines[pk.i];
    line.product = { supplier: p.supplier, product_key: p.product_key, label: p.description, pack_count: c, pack_size: s, pack_unit: pk.pack.unit, price: p.price, date: p.date };
    // Counted in pieces: the amount on the plate is in pieces too.
    if (pk.pack.unit === 'each') line.unit = 'each';
    else if (line.unit === 'each') line.unit = ['ml', 'l'].includes(pk.pack.unit) ? 'ml' : 'g';
    state.pick = null; rerenderOpen();
    msg('Product chosen for this line. Save to keep it.', true);
    return;
  }
  const up = e.target.closest('[data-dc-unpick]');
  if (up && state.draft) { state.draft.lines[+up.dataset.dcUnpick].product = null; rerenderOpen(); return; }
  const ps = e.target.closest('[data-dc-price-save],[data-dc-price-remove]');
  if (ps && !state.busy) {
    const [kind, ref_id] = (ps.dataset.dcPriceSave || ps.dataset.dcPriceRemove).split('|');
    const form = ps.closest('.dc-price-form');
    let price = null;
    if (ps.dataset.dcPriceSave) {
      const v = num(form.querySelector('[data-dc-pp]').value);
      if (!v || v <= 0) { msg('Write a price more than $0.', false); return; }
      price = { price: v, unit: form.querySelector('[data-dc-pu]').value, note: form.querySelector('[data-dc-pn]').value.trim() };
    }
    state.busy = true; ps.disabled = true;
    try {
      await managerApi('manager_cost_price_save', { kind, ref_id, price });
      state.priceFor = null;
      await reloadKeepingDraft();
      msg(price ? 'Price saved.' : 'Price removed.', true);
    } catch (error) { msg(error.message || 'Unable to save the price.', false); ps.disabled = false; }
    finally { state.busy = false; }
    return;
  }
  const sv = e.target.closest('[data-dc-save]');
  if (sv && !state.busy && r && state.draft) {
    const dr = state.draft;
    if ([dr.sell_price, dr.yield_qty, ...dr.lines.map(l => l.qty)].some(badNum)) { msg('Check the numbers: use only digits and a dot (e.g. 120 or 0.5).', false); return; }
    const dish = { size: dr.size, portions: dr.lines.map(l => ({ kind: l.kind, ref_id: l.ref_id, qty: num(l.qty) || null, unit: l.unit,
      product: l.product ? { supplier: l.product.supplier, product_key: l.product.product_key, label: l.product.label, pack_count: l.product.pack_count, pack_size: l.product.pack_size, pack_unit: l.product.pack_unit } : null })) };
    if (isPrep(r)) { dish.yield_qty = num(dr.yield_qty) || null; dish.yield_unit = dr.yield_unit; }
    else dish.sell_price = num(dr.sell_price) || null;
    state.busy = true; sv.disabled = true;
    try {
      await managerApi('manager_dish_cost_save', { recipe_id: r.id, dish });
      state.draft = null; state.size = dr.size;
      await load();
      msg(`Saved: ${r.name}${dr.size ? ` (${dr.size})` : ''}.`, true);
    } catch (error) { msg(error.message || 'Unable to save the dish.', false); sv.disabled = false; }
    finally { state.busy = false; }
  }
}

// Costs tab: Dishes first; "Ingredient prices" is the list that was there before.
if (typeof invShowTab === 'function') {
  const orig = invShowTab;
  invShowTab = function (tab) {
    orig(tab);
    if (tab === 'costs') { build(); setMode(state.mode); }
  };
}
window.addEventListener('marinara:session-reset', () => { Object.assign(state, { data: null, eng: null, open: null, size: null, draft: null, priceFor: null, pick: null, addSize: false }); });
})();
