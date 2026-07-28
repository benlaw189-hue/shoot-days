// BGL Media — the logic.
// Talks to Supabase, draws the four screens, handles the form and the row menus.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ============================================================
// Supabase dashboard -> Settings -> API Keys
// Use the PUBLISHABLE key (sb_publishable_...). Never the secret one.
// ============================================================
const SUPABASE_URL = 'https://ipjrkpwolsbukjztyguh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tFapTFCQ8GnPvcQWrTr47Q_tJv44iL0';
// ============================================================

// The options in the two dropdowns. These must match what the database
// will accept. Add or rename freely — the list is the only place they live.
const JOB_TYPES = ['wedding', 'corporate', 'event', 'music video', 'commercial', 'property'];
const STATUSES  = ['pencilled', 'confirmed', 'delivered', 'invoiced', 'paid'];

// Which statuses mean the work is done but the money isn't in, and which
// mean the job isn't firm yet. Both feed the summary strip and the nudges.
const OWED_STATUSES = ['delivered', 'invoiced'];
const PROVISIONAL   = ['pencilled'];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

// Colour down the left edge of each row, by job type.
const TYPE_COLOUR = {
  'wedding':     '#B8577A',
  'corporate':   '#3E6FA8',
  'event':       '#C09024',
  'music video': '#5E8C56',
  'commercial':  '#8A6BA8',
  'property':    '#B0603A'
};

function typeColour(type) {
  return TYPE_COLOUR[type] || '#8A8D82';
}

function statusColour(status) {
  if (status === 'paid') return '#4A7A42';
  if (status === 'invoiced' || status === 'delivered') return '#A83A2B';
  return '#55584F';
}

// A Date -> '2026-08-15', in the local calendar rather than UTC.
function isoOf(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

function todayISO() {
  return isoOf(new Date());
}

// '2026-08-15' -> 'SAT 15 AUG'
function longDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .toUpperCase();
}

// How many sleeps away a date is. Negative means it's been and gone.
function daysUntil(value) {
  const [y, m, d] = value.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((then - now) / 86400000);
}

// '13:00:00' -> '13:00'
function shortTime(value) {
  return value ? value.slice(0, 5) : '';
}

function money(value) {
  return '£' + Number(value || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = value == null ? '' : value;
  return node.innerHTML;
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function titleCase(value) {
  const text = String(value == null ? '' : value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function showError(message) {
  el('error').textContent = message;
  show('error');
}

let flashTimer = null;
function flash(message) {
  el('flash').textContent = message;
  show('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => hide('flash'), 6000);
}

// ---- which screen is showing ----

const SCREENS = ['home', 'shoots', 'calendar', 'more'];

function goto(name) {
  SCREENS.forEach((n) => {
    el('screen-' + n).classList.toggle('hidden', n !== name);
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });
  window.scrollTo(0, 0);
}

el('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;

  // Add isn't a screen of its own — it's the schedule with the form already open.
  if (button.dataset.tab === 'add') {
    goto('shoots');
    openForm();
    return;
  }
  goto(button.dataset.tab);
});

// ---- the team this signed-in person belongs to ----
// Needed on insert so the row passes the security policies. Stays null
// if we can't find it.
let teamId = null;

async function loadTeamId(userId) {
  teamId = null;
  let result = await supabase.from('profiles').select('team_id').eq('id', userId).maybeSingle();
  if (result.error || !result.data) {
    result = await supabase.from('profiles').select('team_id').eq('user_id', userId).maybeSingle();
  }
  if (result.data && result.data.team_id) teamId = result.data.team_id;
}

function fillSelect(id, values) {
  el(id).innerHTML = values
    .map((v) => `<option value="${escapeAttr(v)}">${escapeText(titleCase(v))}</option>`)
    .join('');
}

// Set a dropdown, keeping any value the database holds that isn't on our list.
function setSelect(id, value) {
  const node = el(id);
  const known = Array.from(node.options).some((o) => o.value === value);
  if (!known && value) {
    const extra = document.createElement('option');
    extra.value = value;
    extra.textContent = titleCase(value);
    node.appendChild(extra);
  }
  node.value = value || '';
}

fillSelect('f_type', JOB_TYPES);
fillSelect('f_status', STATUSES);

el('todaylabel').textContent = new Date()
  .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// ============================================================
// The data
// ============================================================

// Everything we're allowed to see, newest first. The home screen and the
// calendar both read from this rather than asking the database again.
let allShoots = [];

// What the schedule list is showing. Queried separately because the scope
// chips change the query itself, not just the filtering.
let shoots = [];

let scope = 'upcoming';
let statusFilter = 'any';
let search = '';

const COLUMNS = 'id, shoot_date, call_time, venue, client, fee, job_type, status';

function refresh() {
  loadAll();
  loadShoots();
}

async function loadAll() {
  const { data, error } = await supabase
    .from('shoots')
    .select(COLUMNS)
    .order('shoot_date', { ascending: false })
    .limit(500);

  if (error) {
    allShoots = [];
    el('nextup').innerHTML = '<div class="error">Error: ' + escapeText(error.message) + '</div>';
    return;
  }

  allShoots = data || [];
  renderHome();
  renderCalendar();
}

async function loadShoots() {
  let request = supabase.from('shoots').select(COLUMNS);

  request = scope === 'upcoming'
    ? request.gte('shoot_date', todayISO()).order('shoot_date', { ascending: true })
    : request.order('shoot_date', { ascending: false }).limit(500);

  const { data, error } = await request;

  if (error) {
    el('list').innerHTML = '<div class="error">Error: ' + escapeText(error.message) + '</div>';
    el('count').textContent = '';
    return;
  }

  shoots = data;
  renderList();
}

// ============================================================
// Home
// ============================================================

function byDateAscending(a, b) {
  if (a.shoot_date === b.shoot_date) return (a.call_time || '') < (b.call_time || '') ? -1 : 1;
  return a.shoot_date < b.shoot_date ? -1 : 1;
}

function renderHome() {
  const today = todayISO();
  const upcoming = allShoots.filter((s) => s.shoot_date >= today).sort(byDateAscending);
  const next = upcoming[0];

  if (!next) {
    el('nextup').innerHTML = '<div class="empty">Nothing booked in.</div>';
  } else {
    const gap = daysUntil(next.shoot_date);
    const when = gap === 0 ? 'Today' : gap === 1 ? 'Tomorrow' : 'In ' + gap + ' days';
    const meta = [next.client, next.fee == null ? null : money(next.fee)].filter(Boolean);

    el('nextup').innerHTML = `
      <div class="nextup" style="border-left-color:${typeColour(next.job_type)}">
        <div class="bigdate">${longDate(next.shoot_date)}${next.call_time ? ' &middot; ' + escapeText(shortTime(next.call_time)) : ''}</div>
        <div class="bigvenue">${escapeText(next.venue)}</div>
        <div class="bigmeta">${escapeText(meta.join(' · ')) || '&mdash;'}</div>
        <div class="in">${when} &middot; ${escapeText(next.status)}</div>
      </div>`;
  }

  updateTally(upcoming);
  renderNudges();
}

function updateTally(upcoming) {
  const monthPrefix = todayISO().slice(0, 7);
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long' });
  const thisMonth = upcoming.filter((s) => String(s.shoot_date).startsWith(monthPrefix)).length;

  let confirmed = 0;
  let provisional = 0;
  upcoming.forEach((s) => {
    const fee = Number(s.fee || 0);
    if (PROVISIONAL.includes(s.status)) provisional += fee;
    else confirmed += fee;
  });

  el('t_ahead').textContent = upcoming.length;
  el('t_ahead_sub').textContent = thisMonth + ' in ' + monthName;
  el('t_booked').textContent = money(confirmed);
  el('t_booked_sub').textContent = provisional ? money(provisional) + ' pencilled' : 'all confirmed';

  // Owed looks at every shoot, not just the ones ahead — most of what's
  // outstanding is work that's already happened.
  const owedRows = allShoots.filter((s) => OWED_STATUSES.includes(s.status));
  const owed = owedRows.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  el('t_owed').textContent = money(owed);
  el('t_owed_sub').textContent = owedRows.length + (owedRows.length === 1 ? ' job' : ' jobs');
}

// Work that's done but not paid for, oldest first — the ones that have been
// waiting longest are the ones worth chasing.
function renderNudges() {
  const rows = allShoots
    .filter((s) => OWED_STATUSES.includes(s.status))
    .sort(byDateAscending)
    .slice(0, 6);

  if (!rows.length) {
    el('nudge').innerHTML = '<div class="empty">Nothing outstanding.</div>';
    return;
  }

  el('nudge').innerHTML = rows.map((s) => `
    <div class="mini" style="border-left-color:${typeColour(s.job_type)}">
      <div>
        <div class="mv">${escapeText(s.venue)}</div>
        <div class="mm">${escapeText(s.client || '—')} &middot; ${longDate(s.shoot_date)}</div>
      </div>
      <div class="tag">${s.status === 'delivered' ? 'Invoice' : 'Unpaid'}</div>
    </div>`).join('');
}

// ============================================================
// Calendar
// ============================================================

const calMonth = new Date();
calMonth.setDate(1);
let selectedDay = null;

function renderCalendar() {
  el('monthname').textContent = calMonth
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  el('caldays').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map((d) => `<div class="dow">${d}</div>`).join('');

  // Every shoot filed under its date, so each cell is a lookup not a search.
  const byDate = {};
  allShoots.forEach((s) => {
    (byDate[s.shoot_date] = byDate[s.shoot_date] || []).push(s);
  });

  // Six rows of seven, starting on the Monday on or before the 1st.
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(1 - lead);

  const today = todayISO();
  let cells = '';

  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = isoOf(d);
    const list = byDate[iso] || [];

    const classes = ['day'];
    if (d.getMonth() !== calMonth.getMonth()) classes.push('out');
    if (iso === today) classes.push('today');
    if (iso === selectedDay) classes.push('on');

    const pips = list.slice(0, 3)
      .map((s) => `<i style="background:${typeColour(s.job_type)}"></i>`).join('');

    cells += `<button type="button" class="${classes.join(' ')}" data-date="${iso}">
        <span>${d.getDate()}</span><span class="pips">${pips}</span>
      </button>`;
  }

  el('calcells').innerHTML = cells;
  renderDay();
}

function renderDay() {
  if (!selectedDay) {
    el('dayview').innerHTML = '';
    return;
  }

  const rows = allShoots.filter((s) => s.shoot_date === selectedDay).sort(byDateAscending);
  const heading = `<div class="label gap">${longDate(selectedDay)}</div>`;

  if (!rows.length) {
    el('dayview').innerHTML = heading + '<div class="empty">Nothing that day.</div>';
    return;
  }

  el('dayview').innerHTML = heading + rows.map((s) => `
    <div class="mini" style="border-left-color:${typeColour(s.job_type)}">
      <div>
        <div class="mv">${escapeText(s.venue)}</div>
        <div class="mm">${escapeText(s.client || '—')}${s.call_time ? ' &middot; ' + escapeText(shortTime(s.call_time)) : ''}</div>
      </div>
      <div class="mf">${money(s.fee)}</div>
    </div>`).join('');
}

el('calcells').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-date]');
  if (!button) return;
  selectedDay = selectedDay === button.dataset.date ? null : button.dataset.date;
  renderCalendar();
});

el('prevmonth').addEventListener('click', () => {
  calMonth.setMonth(calMonth.getMonth() - 1);
  renderCalendar();
});

el('nextmonth').addEventListener('click', () => {
  calMonth.setMonth(calMonth.getMonth() + 1);
  renderCalendar();
});

// ============================================================
// The schedule list
// ============================================================

function visibleShoots() {
  const needle = search.trim().toLowerCase();

  return shoots.filter((s) => {
    if (statusFilter === 'owed') {
      if (!OWED_STATUSES.includes(s.status)) return false;
    } else if (statusFilter !== 'any' && s.status !== statusFilter) {
      return false;
    }
    if (needle) {
      const hay = ((s.venue || '') + ' ' + (s.client || '')).toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function renderList() {
  const rows = visibleShoots();
  const filtering = statusFilter !== 'any' || search.trim() !== '';

  el('listlabel').textContent = scope === 'upcoming' ? 'Coming up' : 'Everything';

  if (!shoots.length) {
    el('list').innerHTML = '<div class="empty">Nothing booked in yet.</div>';
    el('count').textContent = '0 days';
    return;
  }

  if (!rows.length) {
    el('list').innerHTML = '<div class="empty">Nothing matches that.</div>';
    el('count').textContent = '0 of ' + shoots.length;
    return;
  }

  el('count').textContent = filtering
    ? rows.length + ' of ' + shoots.length
    : rows.length + (rows.length === 1 ? ' day' : ' days');

  el('list').innerHTML = rows.map(rowHTML).join('');
}

function rowHTML(shoot) {
  const colour = typeColour(shoot.job_type);

  const statusChips = STATUSES.map((s) => `
        <button type="button" class="chip${s === shoot.status ? ' on' : ''}"
                data-act="status" data-id="${escapeAttr(shoot.id)}" data-value="${escapeAttr(s)}">${escapeText(titleCase(s))}</button>`).join('');

  return `
    <div class="shootwrap" style="border-left-color:${colour}">
      <div class="shoot">
        <div class="when">
          <div class="date">${longDate(shoot.shoot_date)}</div>
          <div class="time">${escapeText(shortTime(shoot.call_time))}</div>
        </div>
        <div class="mid">
          <div class="venue">${escapeText(shoot.venue)}</div>
          <div class="client">${escapeText(shoot.client || '—')}</div>
          <div class="type">${escapeText(shoot.job_type)}</div>
        </div>
        <div class="end">
          <div class="fee">${money(shoot.fee)}</div>
          <div class="status" style="color:${statusColour(shoot.status)}">${escapeText(shoot.status)}</div>
        </div>
        <button type="button" class="dots" data-act="menu" data-id="${escapeAttr(shoot.id)}"
                aria-expanded="false" aria-label="Options for ${escapeAttr(shoot.venue)}">&#8942;</button>
      </div>
      <div class="menu hidden">
        <div class="error hidden"></div>
        <div class="label">Status</div>
        <div class="chips">${statusChips}</div>
        <div class="chips">
          <button type="button" class="chip" data-act="edit" data-id="${escapeAttr(shoot.id)}">Edit details</button>
          <button type="button" class="chip danger" data-act="delete" data-id="${escapeAttr(shoot.id)}">Delete</button>
        </div>
      </div>
    </div>`;
}

function findShoot(id) {
  return shoots.find((s) => String(s.id) === String(id));
}

function closeAllMenus() {
  document.querySelectorAll('#list .menu').forEach((m) => m.classList.add('hidden'));
  document.querySelectorAll('#list .dots').forEach((d) => {
    d.classList.remove('open');
    d.setAttribute('aria-expanded', 'false');
  });
}

function menuError(menu, message) {
  const box = menu.querySelector('.error');
  box.textContent = message;
  box.classList.remove('hidden');
}

// An update or delete that the security policies block comes back with no
// error and no rows. Asking for the rows back is how we can tell.
async function changeRow(id, patch) {
  const query = patch
    ? supabase.from('shoots').update(patch).eq('id', id).select('id')
    : supabase.from('shoots').delete().eq('id', id).select('id');

  const { data, error } = await query;
  if (error) return error.message;
  if (!data || !data.length) {
    return 'Nothing changed — the database refused it. That usually means the security policies don\'t let this account edit that shoot.';
  }
  return null;
}

el('list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;

  const id = button.dataset.id;
  const wrap = button.closest('.shootwrap');
  const menu = wrap.querySelector('.menu');
  const act = button.dataset.act;

  if (act === 'menu') {
    const wasOpen = !menu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) {
      menu.classList.remove('hidden');
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    }
    return;
  }

  if (act === 'edit') {
    startEdit(id);
    return;
  }

  if (act === 'status') {
    const shoot = findShoot(id);
    const value = button.dataset.value;
    if (!shoot || shoot.status === value) { closeAllMenus(); return; }

    button.textContent = '…';
    const problem = await changeRow(id, { status: value });
    if (problem) {
      button.textContent = titleCase(value);
      menuError(menu, problem);
      return;
    }
    flash(shoot.venue + ' is now ' + value + '.');
    refresh();
    return;
  }

  if (act === 'delete') {
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.classList.add('armed');
      button.textContent = 'Tap again to delete';
      setTimeout(() => {
        button.dataset.armed = '';
        button.classList.remove('armed');
        button.textContent = 'Delete';
      }, 5000);
      return;
    }

    const shoot = findShoot(id);
    button.textContent = 'Deleting…';
    const problem = await changeRow(id, null);
    if (problem) {
      button.dataset.armed = '';
      button.classList.remove('armed');
      button.textContent = 'Delete';
      menuError(menu, problem);
      return;
    }
    if (String(editingId) === String(id)) closeForm();
    flash((shoot ? shoot.venue : 'That shoot') + ' has gone.');
    refresh();
  }
});

// ---- filters ----

// 'owed' isn't a status in the database — it's the two that mean the work
// is done and the money isn't in. It's the view you'll use most.
const STATUS_FILTERS = ['any', 'owed'].concat(STATUSES);

function buildFilterChips() {
  el('statuschips').innerHTML = STATUS_FILTERS.map((value) => {
    const text = value === 'any' ? 'Any status' : titleCase(value);
    return `<button type="button" class="chip${value === statusFilter ? ' on' : ''}"
              data-status="${escapeAttr(value)}">${escapeText(text)}</button>`;
  }).join('');
}

function markScopeChips() {
  document.querySelectorAll('#scopechips .chip').forEach((chip) => {
    chip.classList.toggle('on', chip.dataset.scope === scope);
  });
}

el('scopechips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-scope]');
  if (!chip || chip.dataset.scope === scope) return;
  scope = chip.dataset.scope;
  markScopeChips();
  loadShoots();
});

el('statuschips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-status]');
  if (!chip || chip.dataset.status === statusFilter) return;
  statusFilter = chip.dataset.status;
  buildFilterChips();
  renderList();
});

el('q').addEventListener('input', () => {
  search = el('q').value;
  renderList();
});

buildFilterChips();
markScopeChips();

// ---- add and edit ----

let editingId = null;

function openForm() {
  editingId = null;
  closeAllMenus();
  hide('formerror');
  hide('flash');
  el('newshoot').reset();
  fillSelect('f_type', JOB_TYPES);
  fillSelect('f_status', STATUSES);
  el('f_date').value = todayISO();
  el('formtitle').textContent = 'Add a shoot';
  el('save').textContent = 'Save shoot';
  show('newshoot');
  hide('openform');
  el('f_venue').focus();
}

function startEdit(id) {
  const shoot = findShoot(id);
  if (!shoot) return;

  editingId = shoot.id;
  closeAllMenus();
  hide('formerror');
  hide('flash');
  fillSelect('f_type', JOB_TYPES);
  fillSelect('f_status', STATUSES);

  el('f_date').value = shoot.shoot_date;
  el('f_time').value = shortTime(shoot.call_time);
  el('f_venue').value = shoot.venue || '';
  el('f_client').value = shoot.client || '';
  el('f_fee').value = shoot.fee == null ? '' : shoot.fee;
  setSelect('f_type', shoot.job_type);
  setSelect('f_status', shoot.status);

  el('formtitle').textContent = 'Edit shoot';
  el('save').textContent = 'Save changes';
  show('newshoot');
  hide('openform');
  el('newshoot').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeForm() {
  editingId = null;
  hide('newshoot');
  show('openform');
}

el('openform').addEventListener('click', openForm);
el('cancel').addEventListener('click', closeForm);

el('newshoot').addEventListener('submit', async (event) => {
  event.preventDefault();
  hide('formerror');

  const date  = el('f_date').value;
  const venue = el('f_venue').value.trim();
  const fee   = el('f_fee').value.trim();

  if (!date || !venue) {
    el('formerror').textContent = 'A date and a venue are needed before this can be saved.';
    show('formerror');
    return;
  }

  const row = {
    shoot_date: date,
    call_time:  el('f_time').value || null,
    venue:      venue,
    client:     el('f_client').value.trim() || null,
    fee:        fee === '' ? null : Number(fee),
    job_type:   el('f_type').value,
    status:     el('f_status').value
  };

  const saving = editingId;
  el('save').disabled = true;
  el('save').textContent = 'Saving…';

  let problem;
  if (saving) {
    problem = await changeRow(saving, row);
  } else {
    if (teamId) row.team_id = teamId;
    const { error } = await supabase.from('shoots').insert(row);
    problem = error ? error.message + (error.hint ? ' — ' + error.hint : '') : null;
  }

  el('save').disabled = false;
  el('save').textContent = saving ? 'Save changes' : 'Save shoot';

  if (problem) {
    el('formerror').textContent = problem;
    show('formerror');
    return;
  }

  closeForm();
  if (date < todayISO() && scope === 'upcoming') {
    flash(venue + ' saved. The date has passed — switch to Everything to see it.');
  } else {
    flash(saving ? venue + ' updated.' : venue + ' added to the schedule.');
  }
  refresh();
});

// ---- auth ----

el('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  hide('error');
  el('signin').disabled = true;
  el('signin').textContent = 'Signing in…';

  const { error } = await supabase.auth.signInWithPassword({
    email: el('email').value.trim(),
    password: el('password').value
  });

  el('signin').disabled = false;
  el('signin').textContent = 'Sign in';
  if (error) showError(error.message);
});

el('signout').addEventListener('click', async () => {
  await supabase.auth.signOut();
});

// Supabase quietly refreshes the login token every hour or so, and each
// refresh fires this. Without the guard you'd get thrown back to the home
// screen mid-job, which would be baffling.
let started = false;

async function render(session) {
  hide('loading');

  if (!session) {
    started = false;
    hide('app');
    hide('tabs');
    show('login');
    return;
  }

  hide('login');
  show('app');
  show('tabs');
  el('who').textContent = session.user.email;

  if (started) return;
  started = true;

  await loadTeamId(session.user.id);
  goto('home');
  refresh();
}

supabase.auth.onAuthStateChange((_event, session) => render(session));

const { data } = await supabase.auth.getSession();
render(data.session);
