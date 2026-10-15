'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let lastRequest = null; // { userId, units, requestId } for the "send again" button

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || res.statusText);
  return json;
}

const fmt = (n) => (n === null || n === undefined ? '∞' : n.toLocaleString('en-US'));

function meter(cls, who, consumed, plan, remaining) {
  const allowance = plan.monthlyAllowance;
  const over = allowance !== null && consumed > allowance;
  const pct = allowance === null ? 0 : allowance === 0 ? 100 : Math.min(100, (consumed / allowance) * 100);
  const nums = allowance === null ? `${fmt(consumed)} used · unlimited` : `${fmt(consumed)} of ${fmt(allowance)} used · ${fmt(remaining)} left`;
  return `<div class="meter ${cls}">
    <div class="meter-head"><span class="who">${esc(who)}</span><span class="nums">${nums}</span></div>
    <div class="track" role="img" aria-label="${esc(who)}: ${nums}"><div class="fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
    <div class="meta">${plan.maxUnitsPerRequest === null ? 'no per-request limit' : `up to ${fmt(plan.maxUnitsPerRequest)} units per request`}${over ? ' · allowance was lowered below usage' : ''}</div>
  </div>`;
}

function planOptions(scope, selected) {
  return state.plans.filter((p) => p.scope === scope)
    .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.predefined ? ' (predefined)' : ''}</option>`).join('');
}

function render() {
  const { account, usage, plans, requests } = state;
  $('account-name').textContent = account.name;
  $('month').textContent = usage.month + ' (UTC)';

  // Allowances: the shared account meter first, then each user with their own plan picker.
  let html = `<label>Account plan
      <select data-account-plan>${planOptions('account', account.plan.id)}</select></label>
    ${meter('account', 'Shared by everyone', usage.account.consumed, usage.account.plan, usage.account.remaining)}`;
  for (const u of usage.users.data) {
    html += `<div class="user-block"><label>${esc(u.userId)}'s plan
      <select data-user-plan="${esc(u.userId)}">${planOptions('user', u.plan.id)}</select></label>
      ${meter('user', u.userId, u.consumed, u.plan, u.remaining)}</div>`;
  }
  $('allowances').innerHTML = html;

  const current = $('user').value;
  $('user').innerHTML = usage.users.data.map((u) => `<option>${esc(u.userId)}</option>`).join('');
  if (current) $('user').value = current;

  // Plans: only custom plans are editable; predefined ones are read-only by design.
  const custom = plans.filter((p) => !p.predefined);
  $('plans').innerHTML = custom.map((p) => `<form class="plan" data-plan="${esc(p.id)}">
      <div><div class="name">${esc(p.name)}</div><div class="kind">${p.scope} plan</div></div>
      <label>Units per month<input name="monthlyAllowance" type="number" min="0" placeholder="unlimited" value="${p.monthlyAllowance ?? ''}"></label>
      <label>Units per request<input name="maxUnitsPerRequest" type="number" min="0" placeholder="unlimited" value="${p.maxUnitsPerRequest ?? ''}"></label>
      <button type="submit">Save limits</button></form>`).join('')
    + `<div class="plan readonly"><div><div class="name">Predefined plans</div><div class="kind">${plans.filter((p) => p.predefined).map((p) => `${esc(p.name)} ${fmt(p.monthlyAllowance)}/${fmt(p.maxUnitsPerRequest)}`).join(' · ')} — read-only</div></div></div>`;

  $('history').querySelector('tbody').innerHTML = requests.length ? requests.map((r) => `<tr>
      <td class="id" title="${esc(r.requestId)}">${esc(r.requestId)}</td><td>${esc(r.userId)}</td><td>${fmt(r.units)}</td>
      <td class="${r.accepted ? 'ok' : 'no'}">${r.accepted ? 'Accepted' : 'Rejected'}</td>
      <td>${r.reason ? esc(r.reason.level) + ' · ' + esc(r.reason.rule.replaceAll('_', ' ')) : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No documents processed yet.</td></tr>';
}

async function load() {
  state = await api('GET', '/api/overview');
  render();
}

function showSlip(d) {
  const ok = d.accepted;
  $('slip').className = `slip ${ok ? 'accepted' : 'declined'}`;
  const level = (name, l) => `${fmt(l.consumed)} of ${fmt(l.monthlyAllowance)} used, ${fmt(l.remaining)} left (${esc(l.planName)})`;
  $('slip').innerHTML = `<p class="verdict">${ok ? 'Accepted' : 'Declined'}${d.replayed ? '<span class="stamp">REPLAY · NOT COUNTED AGAIN</span>' : ''}</p>
    <dl>
      <dt>Document</dt><dd>${fmt(d.units)} units for ${esc(d.userId)}</dd>
      <dt>${esc(d.userId)}</dt><dd>${level('user', d.user)}</dd>
      <dt>Account</dt><dd>${level('account', d.account)}</dd>
      <dt>Request id</dt><dd>${esc(d.requestId)}</dd>
    </dl>
    ${d.reason ? `<p class="why"><strong>${esc(d.reason.level)} limit:</strong> ${esc(d.reason.message)}</p>` : ''}`;
}

$('process-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = $('user').value;
  const units = Number($('units').value);
  try {
    const d = await api('POST', '/api/process', { userId, units });
    lastRequest = { userId, units, requestId: d.requestId };
    $('retry').disabled = false;
    showSlip(d);
    await load();
  } catch (err) {
    $('slip').className = 'error'; $('slip').textContent = err.message;
  }
});

$('retry').addEventListener('click', async () => {
  if (!lastRequest) return;
  try { showSlip(await api('POST', '/api/process', lastRequest)); await load(); }
  catch (err) { $('slip').className = 'error'; $('slip').textContent = err.message; }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.matches('[data-user-plan]')) await api('PUT', `/api/users/${encodeURIComponent(t.dataset.userPlan)}/plan`, { planId: t.value });
    else if (t.matches('[data-account-plan]')) await api('PUT', '/api/account/plan', { planId: t.value });
    else return;
    await load();
  } catch (err) { alert(err.message); await load(); }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-plan]');
  if (!f) return;
  e.preventDefault();
  const val = (n) => (f.elements[n].value === '' ? null : Number(f.elements[n].value));
  try {
    await api('PATCH', `/api/plans/${encodeURIComponent(f.dataset.plan)}`, { monthlyAllowance: val('monthlyAllowance'), maxUnitsPerRequest: val('maxUnitsPerRequest') });
    await load();
  } catch (err) { alert(err.message); }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Create a fresh demo account? Current demo usage will no longer be shown.')) return;
  await api('POST', '/api/reset'); lastRequest = null; $('retry').disabled = true;
  $('slip').className = 'slip-empty'; $('slip').textContent = 'The decision appears here as a slip.';
  await load();
});

$('run-demo').addEventListener('click', async () => {
  const btn = $('run-demo'); btn.disabled = true; btn.textContent = 'Running…';
  try {
    const r = await api('POST', '/api/demo/run');
    $('demo-steps').innerHTML = r.steps.map((s) => `<li class="${s.ok ? '' : 'bad'}">
      <div class="t">${esc(s.title)} ${s.accepted === undefined ? '' : `<span class="${s.accepted ? 'verdict-ok' : 'verdict-no'}">${s.accepted ? 'ACCEPTED' : 'REJECTED'}${s.replayed ? ' (replayed)' : ''}</span>`}</div>
      <div class="d">${esc(s.detail)}</div>
      ${s.reason ? `<div class="d">Why: ${esc(s.reason)}</div>` : ''}${s.balances ? `<div class="d">${esc(s.balances)}</div>` : ''}</li>`).join('');
  } catch (err) { $('demo-steps').innerHTML = `<li class="bad">${esc(err.message)}</li>`; }
  btn.disabled = false; btn.textContent = 'Run guided demo again';
});

load().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="error">${esc(e.message)}</p>`); });
