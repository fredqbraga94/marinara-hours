/* Dish costs (Invoices → Costs → Dishes): the cost of each dish on the menu.
   For every dish: the menu price, how much of each ingredient goes on one
   plate (g, kg, ml, l, each), and what that costs. An ingredient's price comes
   from its invoice link (Costs → Ingredient prices) or from a price typed by
   hand. A sauce or prep made in the kitchen costs what its own recipe costs
   per kg / litre / each (when "one batch makes" is filled in), or a price typed
   by hand. The sums are done here; the server only stores the numbers.
   Administrator and Kitchen Manager only (the server refuses everyone else). */
(() => {
const $ = id => document.getElementById(id);
const t = v => escapeHtml(String(v ?? ''));
const money = n => n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const UNITS = ['g', 'kg', 'ml', 'l', 'each'];
const PREP = ['Sauce', 'Dressing', 'Prep'];
const GST = 1.1;

/* ---------- the sums (pure; window.MarinaraDishCost for tests) ---------- */
const toBase = (qty, unit) => unit === 'g' ? { q: qty / 1000, u: 'kg' } : unit === 'ml' ? { q: qty / 1000, u: 'l' } : { q: qty, u: unit };
const sameKind = (a, b) => a === b || (a === 'kg' && b === 'l') || (a === 'l' && b === 'kg'); // sauces: 1 kg ≈ 1 litre
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
    const c = recipeCost(r, seen);
    if (c.complete && c.counted && r.yield_qty && r.yield_unit) {
      const y = toBase(Number(r.yield_qty), r.yield_unit);
      return { price: c.cost / y.q, unit: y.u, src: 'recipe', label: 'from its recipe' };
    }
    if (r.manual) return { price: Number(r.manual.price), unit: r.manual.unit, src: 'manual', label: r.manual.note || 'typed by hand' };
    return null;
  }
  function lineCost(l, seen) {
    if (!l.qty || !l.unit) return { counted: false };
    const p = priceOf(l.kind, l.ref_id, seen);
    if (!p) return { counted: true, missing: true };
    const b = toBase(Number(l.qty), l.unit);
    if (!sameKind(b.u, p.unit)) return { counted: true, mismatch: true, p };
    return { counted: true, cost: b.q * p.price, p };
  }
  function recipeCost(r, seen = new Set()) {
    if (memo.has(r.id)) return memo.get(r.id);
    if (seen.has(r.id)) return { cost: 0, counted: 0, complete: false, loop: true };
    const next = new Set(seen); next.add(r.id);
    let cost = 0, counted = 0, complete = true;
    const lines = (r.lines || []).map(l => {
      // A prep whose only line is itself (e.g. "Pizza dough") has no recipe yet.
      const self = l.kind === 'ingredient' && String(l.name).toLowerCase() === String(r.name).toLowerCase();
      const c = self ? { counted: false } : lineCost(l, next);
      if (c.counted) { counted++; if (c.cost == null) complete = false; else cost += c.cost; }
      return { ...l, c };
    });
    const out = { cost, counted, complete, lines };
    if (!seen.size) memo.set(r.id, out);
    return out;
  }
  function dish(r) {
    const c = recipeCost(r);
    const ex = r.sell_price ? Number(r.sell_price) / GST : null;
    return { ...c, ex, pct: ex && c.counted ? c.cost / ex * 100 : null, left: ex && c.counted ? ex - c.cost : null };
  }
  return { priceOf, recipeCost, dish };
}
window.MarinaraDishCost = { engine, toBase };

/* ---------- screen ---------- */
const state = { mode: 'dishes', data: null, eng: null, filter: 'dishes', q: '', open: null, draft: null, priceFor: null, busy: false };
let built = false;
function build() {
  if (built) return; built = true;
  const view = $('invCostsView');
  const old = document.createElement('div'); old.id = 'dcIngredients';
  while (view.firstChild) old.append(view.firstChild);
  view.innerHTML = `<div class="rm-chips dc-switch" id="dcSwitch">
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
  view.append(old);
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

function summary() {
  const dishes = state.data.recipes.filter(r => !isPrep(r)).map(r => ({ r, d: state.eng.dish(r) }));
  const priced = dishes.filter(x => x.d.pct != null);
  const avg = priced.length ? priced.reduce((a, x) => a + x.d.pct, 0) / priced.length : null;
  const high = priced.filter(x => x.d.pct >= 32).length;
  const todo = dishes.filter(x => !x.d.complete || !x.r.sell_price || !x.d.counted).length;
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
    if (state.filter === 'todo') { const d = state.eng.dish(r); return !d.complete || !r.sell_price || !d.counted; }
    return true;
  });
  const box = $('dcList');
  box.className = rows.length ? 'dc-list' : 'empty-state';
  box.innerHTML = rows.length ? rows.map(row).join('') : (state.filter === 'todo' ? 'Every dish has its amounts and prices.' : 'Nothing here.');
}
function row(r) {
  const d = state.eng.dish(r);
  const open = state.open === r.id;
  let right;
  if (isPrep(r)) {
    const p = state.eng.priceOf('recipe', r.id);
    right = p ? `<span class="val">${money(p.price)}/${t(p.unit)}</span>` : `<span class="val todo">No price</span>`;
  } else if (d.pct != null) right = `<span class="dc-pct ${pctClass(d.pct)}">${d.pct.toFixed(1)}%</span>`;
  else right = `<span class="val todo">${!r.sell_price ? 'No menu price' : 'No amounts'}</span>`;
  const sub = isPrep(r)
    ? `${t(r.category)}${r.yield_qty ? ` · one batch makes ${t(fmt(r.yield_qty))} ${t(r.yield_unit)}` : ''}${r.manual ? ` · ${money(r.manual.price)}/${t(r.manual.unit)} by hand` : ''}`
    : `${t(r.category)} · ${r.sell_price ? `menu ${money(r.sell_price)}` : 'no menu price'}${d.counted ? ` · cost ${money(d.cost)}${d.complete ? '' : ' + missing'}` : ''}`;
  return `<div class="inv-cost dc-dish${open ? ' open' : ''}" data-dc-id="${t(r.id)}">
    <button type="button" class="inv-cost-head" data-dc-open="${t(r.id)}" aria-expanded="${open}"><strong>${t(r.name)}</strong>${right}<small>${sub}</small></button>
    ${open ? editor(r) : ''}</div>`;
}
const fmt = n => Number(n).toLocaleString('en-AU', { maximumFractionDigits: 3 });
function draftOf(r) {
  if (!state.draft || state.draft.id !== r.id) {
    state.draft = { id: r.id, sell_price: r.sell_price ?? '', yield_qty: r.yield_qty ?? '', yield_unit: r.yield_unit || 'kg',
      lines: r.lines.map(l => ({ kind: l.kind, ref_id: l.ref_id, qty: l.qty ?? '', unit: l.unit || (l.kind === 'recipe' ? 'ml' : 'g') })) };
  }
  return state.draft;
}
// The recipe as it would be with the draft amounts, so the sums follow the typing.
function withDraft(r, dr) {
  return { ...r, sell_price: num(dr.sell_price) || null, yield_qty: num(dr.yield_qty) || null, yield_unit: dr.yield_unit,
    lines: r.lines.map((l, i) => ({ ...l, qty: num(dr.lines[i].qty) || null, unit: dr.lines[i].unit })) };
}
function editor(r) {
  const dr = draftOf(r);
  const live = engine({ ...state.data, recipes: state.data.recipes.map(x => x.id === r.id ? withDraft(r, dr) : x) });
  const lr = live.dish(withDraft(r, dr));
  const unitSel = (val, attrs) => `<select ${attrs}>${UNITS.map(u => `<option value="${u}"${u === val ? ' selected' : ''}>${u}</option>`).join('')}</select>`;
  const lines = lr.lines.map((l, i) => {
    const c = l.c;
    const p = c.p || state.eng.priceOf(l.kind, l.ref_id);
    const self = l.kind === 'ingredient' && String(l.name).toLowerCase() === String(r.name).toLowerCase();
    const priceTxt = self ? 'the recipe still needs its real ingredients' : p ? `${money(p.price)}/${t(p.unit)} · ${t(p.label)}` : 'No price yet';
    const costTxt = !c.counted ? '' : c.missing ? '<span class="dc-miss">no price</span>' : c.mismatch ? `<span class="dc-miss">use ${p.unit === 'each' ? 'each' : 'g / ml'}</span>` : money(c.cost);
    const canPrice = !self && !(p && (p.src === 'invoice' || p.src === 'recipe'));
    return `<div class="dc-line${c.counted ? '' : ' off'}">
      <div class="dc-line-name"><strong>${t(l.name)}${l.kind === 'recipe' ? ' <em>(made here)</em>' : ''}</strong>
        <small>${l.quantity ? `Recipe says: ${t(l.quantity)} · ` : ''}${priceTxt}${canPrice ? ` · <button type="button" class="linkish" data-dc-price="${t(l.kind)}|${t(l.ref_id)}">${p ? 'Change price' : 'Set price'}</button>` : ''}</small>
        ${state.priceFor === `${l.kind}|${l.ref_id}` ? priceForm(l, p) : ''}</div>
      <div class="dc-line-qty"><input type="text" inputmode="decimal" id="dcq-${t(r.id)}-${i}" data-dc-q="${i}" value="${t(dr.lines[i].qty)}" placeholder="—" aria-label="Amount of ${t(l.name)}">
        ${unitSel(dr.lines[i].unit, `data-dc-u="${i}" aria-label="Unit of ${t(l.name)}"`)}</div>
      <div class="dc-line-cost">${costTxt}</div></div>`;
  }).join('');
  const prep = isPrep(r);
  const totals = prep
    ? (() => { const p = live.priceOf('recipe', r.id); return `<div class="dc-total"><span>Batch cost</span><b>${lr.counted ? money(lr.cost) : '—'}${lr.complete ? '' : ' + missing'}</b></div>
       <div class="dc-total"><span>Cost per ${t(p?.unit || 'unit')}</span><b>${p ? money(p.price) : '—'}</b></div>`; })()
    : `<div class="dc-total"><span>Food cost per plate</span><b>${lr.counted ? money(lr.cost) : '—'}${lr.counted && !lr.complete ? ' + missing' : ''}</b></div>
       <div class="dc-total"><span>Menu price without GST</span><b>${lr.ex ? money(lr.ex) : '—'}</b></div>
       <div class="dc-total"><span>Food cost %</span><b class="${pctClass(lr.pct)}">${lr.pct == null ? '—' : lr.pct.toFixed(1) + '%'}</b></div>
       <div class="dc-total"><span>Left over per plate</span><b>${lr.left == null ? '—' : money(lr.left)}</b></div>`;
  return `<div class="dc-edit">
    ${prep ? `<div class="dc-field"><label for="dcy-${t(r.id)}">One batch makes</label><div class="dc-row">
        <input type="text" inputmode="decimal" id="dcy-${t(r.id)}" data-dc-yield value="${t(dr.yield_qty)}" placeholder="e.g. 10">
        ${unitSel(dr.yield_unit, `data-dc-yield-unit aria-label="Batch unit"`)}</div>
        <small>${r.makes ? `Recipe says: ${t(r.makes)}. ` : ''}With this filled in, its cost per kg / litre / each comes from the ingredients below.</small></div>
        <div class="dc-field"><span class="dc-label">Or a price by hand</span><small>${r.manual ? `${money(r.manual.price)}/${t(r.manual.unit)}${r.manual.note ? ` · ${t(r.manual.note)}` : ''} · ` : ''}<button type="button" class="linkish" data-dc-price="recipe|${t(r.id)}">${r.manual ? 'Change' : 'Set a price'}</button></small>
        ${state.priceFor === `recipe|${r.id}` ? priceForm({ kind: 'recipe', ref_id: r.id, name: r.name }, r.manual) : ''}</div>`
      : `<div class="dc-field"><label for="dcs-${t(r.id)}">Menu price (with GST)</label><div class="dc-row"><span class="dc-dollar">$</span>
        <input type="text" inputmode="decimal" id="dcs-${t(r.id)}" data-dc-sell value="${t(dr.sell_price)}" placeholder="e.g. 35.90"></div></div>`}
    <div class="dc-lines-head"><span>${prep ? 'In one batch' : 'On one plate'}</span><span>Amount</span><span>Cost</span></div>
    ${lines || '<div class="empty-state">This recipe has no ingredients yet. Add them in Recipes.</div>'}
    <p class="dc-tip">Leave an amount empty to leave it out (e.g. a choice of pasta: fill in only one).</p>
    <div class="dc-totals">${totals}</div>
    <div class="inv-cost-actions"><button type="button" data-dc-close>Close</button><button type="button" class="save" data-dc-save="${t(r.id)}">Save</button></div>
  </div>`;
}
function priceForm(l, p) {
  const cur = p && p.src !== 'invoice' && p.src !== 'recipe' ? p : null;
  return `<div class="dc-price-form">
    <div class="dc-row"><span class="dc-dollar">$</span><input type="text" inputmode="decimal" id="dcp-${t(l.ref_id)}" data-dc-pp value="${cur ? t(fmt(cur.price)) : ''}" placeholder="price">
      <select data-dc-pu aria-label="Per">${['kg', 'l', 'each'].map(u => `<option value="${u}"${cur && cur.unit === u ? ' selected' : ''}>per ${u === 'l' ? 'litre' : u}</option>`).join('')}</select></div>
    <input type="text" id="dcn-${t(l.ref_id)}" data-dc-pn maxlength="200" value="${cur && cur.label !== 'typed by hand' ? t(cur.label) : ''}" placeholder="Note (e.g. $18.50 a dozen)">
    <small>Used in every dish with ${t(l.name)}. A price from an invoice link takes over when there is one.</small>
    <div class="inv-cost-actions">${cur ? `<button type="button" data-dc-price-remove="${t(l.kind)}|${t(l.ref_id)}">Remove</button>` : ''}<button type="button" data-dc-price-cancel>Cancel</button><button type="button" class="save" data-dc-price-save="${t(l.kind)}|${t(l.ref_id)}">Save price</button></div></div>`;
}
function rerenderOpen() {
  // Keep the cursor where it was while the sums follow the typing.
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  render();
  if (id && $(id)) { const el = $(id); el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (_) { /* select boxes */ } }
}
function onInput(e) {
  const dr = state.draft; if (!dr) return;
  const el = e.target;
  if (el.matches('[data-dc-q]')) dr.lines[+el.dataset.dcQ].qty = el.value;
  else if (el.matches('[data-dc-u]')) dr.lines[+el.dataset.dcU].unit = el.value;
  else if (el.matches('[data-dc-sell]')) dr.sell_price = el.value;
  else if (el.matches('[data-dc-yield]')) dr.yield_qty = el.value;
  else if (el.matches('[data-dc-yield-unit]')) dr.yield_unit = el.value;
  else return;
  if (e.type === 'input' || el.tagName === 'SELECT') rerenderOpen();
}
function msg(text, ok) { if (typeof invMsg === 'function') invMsg(text, ok); }
async function onClick(e) {
  const open = e.target.closest('[data-dc-open]');
  if (open) { const id = open.dataset.dcOpen; state.open = state.open === id ? null : id; state.draft = null; state.priceFor = null; render(); return; }
  if (e.target.closest('[data-dc-close]')) { state.open = null; state.draft = null; state.priceFor = null; render(); return; }
  const pr = e.target.closest('[data-dc-price]');
  if (pr) { state.priceFor = state.priceFor === pr.dataset.dcPrice ? null : pr.dataset.dcPrice; rerenderOpen(); return; }
  if (e.target.closest('[data-dc-price-cancel]')) { state.priceFor = null; rerenderOpen(); return; }
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
      const keep = state.draft;
      await load();
      state.draft = keep; render();
      msg(price ? 'Price saved.' : 'Price removed.', true);
    } catch (error) { msg(error.message || 'Unable to save the price.', false); ps.disabled = false; }
    finally { state.busy = false; }
    return;
  }
  const sv = e.target.closest('[data-dc-save]');
  if (sv && !state.busy) {
    const r = state.data.recipes.find(x => x.id === sv.dataset.dcSave); const dr = state.draft;
    if (!r || !dr) return;
    const bad = [dr.sell_price, dr.yield_qty, ...dr.lines.map(l => l.qty)].some(v => String(v ?? '').trim() !== '' && (num(v) === null || num(v) < 0));
    if (bad) { msg('Check the numbers: use only digits and a dot (e.g. 120 or 0.5).', false); return; }
    const dish = { portions: dr.lines.map(l => ({ kind: l.kind, ref_id: l.ref_id, qty: num(l.qty) || null, unit: l.unit })) };
    if (isPrep(r)) { dish.yield_qty = num(dr.yield_qty) || null; dish.yield_unit = dr.yield_unit; }
    else dish.sell_price = num(dr.sell_price) || null;
    state.busy = true; sv.disabled = true;
    try {
      await managerApi('manager_dish_cost_save', { recipe_id: r.id, dish });
      state.draft = null;
      await load();
      msg(`Saved: ${r.name}.`, true);
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
window.addEventListener('marinara:session-reset', () => { state.data = null; state.eng = null; state.open = null; state.draft = null; state.priceFor = null; });
})();
