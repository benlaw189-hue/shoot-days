// Shoot Days — the logic.
// Talks to Supabase, draws the list, handles the form and the row menus.

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

function statusColour(status) {
  if (status === 'paid') return '#4A7A42';
  if (status === 'invoiced' || status === 'delivered') return '#A83A2B';
  return '#55584F';
}

// '2026-08-15' -> 'SAT 15 AUG'
function longDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .toUpperCase();
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

// Today, in the local calendar rather than UTC.
function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

let flashTimer = null;
function flash(message) {
  el('flash').textContent = message;
  show('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => hide('flash'), 6000);
}

// The team this signed-in person belongs to. Needed on insert so the
// row passes the security policies. Stays null if we can't find it.
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

async function render(session) {
  hide('loading');
  if (!session) {
    hide('app');
    show('login');
    return;
  }
  hide('login');
  show('app');
  el('who').textContent = session.user.email;
  await loadTeamId(session.user.id);
  loadShoots();
}

let shoots = [];

// What the list is showing: 'upcoming' is today onward, soonest first.
// 'all' is every shoot, most recent first, so chasing money is one tap away.
let scope = 'upcoming';
let statusFilter = 'any';
let search = '';

async function loadShoots() {
  let request = supabase
    .from('shoots')
    .select('id, shoot_date, call_time, venue, client, fee, job_type, status');

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
  updateTally();
  renderList();
}

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

// Which statuses mean the work is done but the money isn't in, and which
// mean the job isn't firm yet. Both feed the summary strip.
const OWED_STATUSES = ['delivered', 'invoiced'];
const PROVISIONAL   = ['pencilled'];

async function updateTally() {
  const monthPrefix = todayISO().slice(0, 7);
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long' });

  const thisMonth = shoots.filter((s) => String(s.shoot_date).startsWith(monthPrefix)).length;

  let confirmed = 0;
  let provisional = 0;
  shoots.forEach((s) => {
    const fee = Number(s.fee || 0);
    if (PROVISIONAL.includes(s.status)) provisional += fee;
    else confirmed += fee;
  });

  el('t_ahead').textContent = shoots.length;
  el('t_ahead_sub').textContent = thisMonth + ' in ' + monthName;
  el('t_booked').textContent = money(confirmed);
  el('t_booked_sub').textContent = provisional ? money(provisional) + ' pencilled' : 'all confirmed';

  // Owed looks at every shoot, not just the ones ahead — most of what's
  // outstanding is work that's already happened.
  const { data, error } = await supabase.from('shoots').select('fee').in('status', OWED_STATUSES);

  if (error || !data) {
    el('t_owed').textContent = '—';
    el('t_owed_sub').textContent = 'unavailable';
    return;
  }

  const owed = data.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  el('t_owed').textContent = money(owed);
  el('t_owed_sub').textContent = data.length + (data.length === 1 ? ' job' : ' jobs');
}

function rowHTML(shoot) {
  const colour = TYPE_COLOUR[shoot.job_type] || '#8A8D82';

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
    loadShoots();
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
    loadShoots();
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
  loadShoots();
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

supabase.auth.onAuthStateChange((_event, session) => render(session));

const { data } = await supabase.auth.getSession();
render(data.session);
