// BGL Media — the logic.
// Talks to Supabase, draws the five screens, handles the forms, the row menus
// and the invoice PDFs.

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

// ============================================================
// The money tracker's categories. Same idea as the job types above —
// this list is the only place they live, so add or rename freely.
// Renaming one won't retag anything already saved under the old word;
// it'll just carry on showing the old word until you edit that entry.
// ============================================================
const IN_CATEGORIES  = ['shoot', 'rebilled', 'other'];

const OUT_CATEGORIES = [
  'crew fee', 'crew expenses', 'travel', 'accommodation',
  'fuel', 'tolls & parking', 'kit', 'software', 'other'
];

// ============================================================
// The words the Status column on the money sheet can say.
//
// `settled` is the only part the figures care about: true means the
// money has actually moved, false means it hasn't. Everything else here
// is the wording on top of that, so you can add, rename or delete lines
// freely without any total going wrong.
//
// `side` decides which lines get offered it — 'in' for income, 'out'
// for expenditure, 'both' for either. If you want one offered on both
// sides, change that word and nothing else.
//
// `tone` names a slot in the palette at the top of styles.css.
//
// Anything saved under a word you later delete carries on showing that
// word until you set it to something else, same as the job types.
// ============================================================
const LABELS = [
  { value: 'paid',             word: 'Paid',                             settled: true,  side: 'both', tone: '--paid' },
  { value: 'pending',          word: 'Pending',                          settled: false, side: 'both', tone: '--accent-5' },
  { value: 'chased',           word: 'Chased',                           settled: false, side: 'in',   tone: '--owed' },
  { value: 'invoice_pending',  word: 'Invoice pending',                  settled: false, side: 'in',   tone: '--accent-4' },
  { value: 'invoice_received', word: 'Invoice received, to be paid',     settled: false, side: 'out',  tone: '--status-blue' },
  { value: 'waiting_to_pay',   word: 'Money received, waiting to pay J', settled: true,  side: 'in',   tone: '--status-plum' },
  { value: 'money_out',        word: 'Money out',                        settled: false, side: 'out',  tone: '--neutral' },

  // Invoices only. A draft hasn't left the building, which isn't a thing
  // a hand-typed entry can be.
  { value: 'draft',            word: 'Draft',                            settled: false, side: 'both', tone: '--ink2', invoiceOnly: true }
];

// What a mile is worth. HMRC's simplified rate for a car, first 10,000
// miles in a tax year, as it stands. The figure is saved onto each entry
// when you add it, so changing this later re-prices nothing you've
// already logged — which is the way round it should be.
const MILEAGE_RATE = 0.45;

// ============================================================
// Who's on a shoot. The tag is what gets stored in the database, so once
// you've used a letter, don't rename it — add a new line instead.
// 'accent' names a slot in the palette at the top of styles.css. The colour
// of the letter sitting on top is worked out automatically, so a pale slot
// gets dark text and a dark slot gets pale text without you doing anything.
// ============================================================
const CREW = [
  { tag: 'B',   name: 'Ben',    accent: '--accent-3' },
  { tag: 'J',   name: 'Jerome', accent: '--accent-4' },
  { tag: 'B&J', name: 'Both',   accent: '--accent-2' }
];

// ============================================================
// EDIT THESE. The email each of you signs in with, and the tag the form
// should pick by default. Purely a convenience — it saves a tap, it does
// not stop anyone tagging a job to anyone.
// ============================================================
const DEFAULT_TAG_BY_EMAIL = {
  'ben@example.com':    'B',
  'jerome@example.com': 'J'
};
// ============================================================

// ============================================================
// EDIT THIS. What goes in the top-right of every invoice, and the bank
// details at the bottom. Taken from your template.
//
// Worth knowing: this file is served publicly, so anyone who finds the
// address can read it. Your sort code and account number go out on every
// invoice you send anyway, so this isn't a new exposure — but if you'd
// rather they weren't sitting in a file on the open web, say so and
// they can move into the database behind the same rules as everything else.
// ============================================================
const ME = {
  name:    'Benjamin Law',
  company: 'BGL Media',
  address: '4, Bodmin Ave, Southport, PR9 9TU',
  phone:   '+44 7585 430643',
  email:   'benlaw@bglmedia.uk',

  // Invoice numbers are this, then three digits: BGLM001, BGLM002...
  prefix:  'BGLM',

  bank: [
    'Account name: B G Law',
    'Sort code: 04-00-06',
    'Account no: 94787148'
  ]
};
// ============================================================

let myTag = '';

// Am I an owner? Answered by the database, not by anything in this file.
// If it lies, it can only lie downwards — the policies decide what actually
// comes back over the wire, and this only decides what the form offers.
let isOwner = false;

// Am I allowed to invoice? Same story. Hiding the menu item is tidiness;
// the row-level rules in invoices.sql are the actual lock.
let canInvoice = false;

// shoot_id -> { actual_fee, shared }. For a non-owner this only ever holds
// the jobs that have been unlocked, because the rest never arrive.
let feeMap = {};

// Which statuses mean the work is done but the money isn't in, and which
// mean the job isn't firm yet. Both feed the summary strip and the nudges.
const OWED_STATUSES = ['delivered', 'invoiced'];
const PROVISIONAL   = ['pencilled'];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

// ============================================================
// Colour. Nothing below picks a colour — it only names one from the palette
// at the top of styles.css and lets the browser look it up.
// ============================================================

// The value a --token currently holds, e.g. '--accent-3' -> '#C09024'.
function tokenValue(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

// How bright a colour is, 0 to 1, the way the eye sees it rather than the way
// the numbers read.
function luminance(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  if (x === null || y === null) return 0;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Dark text or pale text on top of a given palette slot — whichever is easier
// to read against it. Worked out from the live values, so recolouring the
// palette can never leave a crew tag unreadable.
function readableOn(token) {
  const on = tokenValue(token);
  return contrast(on, tokenValue('--ink')) >= contrast(on, tokenValue('--paper'))
    ? 'var(--ink)' : 'var(--paper)';
}

function crewEntry(tag) {
  return CREW.find((c) => c.tag === tag) || null;
}

// Colour down the left edge of a row, by who's on it. Untagged shoots stay grey.
function crewColour(tag) {
  const entry = crewEntry(tag);
  return entry ? `var(${entry.accent})` : 'var(--ink3)';
}

// The letter, in its own colour. Untagged shoots get nothing rather than
// a badge saying nothing.
function crewTag(tag) {
  const entry = crewEntry(tag);
  if (!entry) return '';
  return `<span class="crewtag" style="background:var(${entry.accent});color:${readableOn(entry.accent)}">${escapeText(entry.tag)}</span>`;
}

function statusColour(status) {
  if (status === 'paid') return 'var(--paid)';
  if (status === 'invoiced' || status === 'delivered') return 'var(--owed)';
  return 'var(--neutral)';
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

// '2026-08-15' -> '15.08.26'. The format your template uses.
function dotDate(value) {
  if (!value) return '';
  const [y, m, d] = String(value).split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

// '2026-08-15' + 7 -> '2026-08-22'
function addDays(value, days) {
  const [y, m, d] = String(value).split('-').map(Number);
  const out = new Date(y, m - 1, d);
  out.setDate(out.getDate() + Number(days || 0));
  return isoOf(out);
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

// Invoices show the pence. A schedule doesn't need to; a bill does.
function money2(value) {
  return '£' + Number(value || 0).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

// What this signed-in person should see for a shoot. `actual` is null when
// there's no client fee recorded, and also when there is one but it isn't
// ours to see — from in here those two look identical, which is the point.
function feeInfo(shoot) {
  const extra = feeMap[shoot.id];
  const schedule = shoot.fee == null ? null : Number(shoot.fee);
  const actual = extra && extra.actual_fee != null ? Number(extra.actual_fee) : null;

  return {
    schedule: schedule,
    actual: actual,
    shared: extra ? !!extra.shared : false,
    headline: actual == null ? schedule : actual,
    split: actual != null && schedule != null && actual !== schedule
  };
}

// ============================================================
// Travel days
//
// A long job can need the day before it, the day after it, or both — the
// drive out and the drive back. Those days aren't shoots of their own.
// They're two numbers held on the shoot, which means they move when the
// date moves and vanish when the job is deleted. There is no second row
// anywhere that can be left behind pointing at nothing.
//
// How many, and which side, is set per shoot. Some jobs need none.
// ============================================================

function travelBefore(shoot) { return Math.max(0, Number(shoot.travel_before || 0)); }
function travelAfter(shoot)  { return Math.max(0, Number(shoot.travel_after  || 0)); }
function travelCount(shoot)  { return travelBefore(shoot) + travelAfter(shoot); }

// The dates actually blocked out, earliest first.
// side: 'out' is the run there, 'back' is the run home.
function travelDates(shoot) {
  const out = [];
  if (!shoot.shoot_date) return out;
  for (let i = travelBefore(shoot); i >= 1; i--) {
    out.push({ iso: addDays(shoot.shoot_date, -i), side: 'out' });
  }
  for (let i = 1; i <= travelAfter(shoot); i++) {
    out.push({ iso: addDays(shoot.shoot_date, i), side: 'back' });
  }
  return out;
}

// What the travel is worth in total. travel_each false means the number
// typed is the whole job rather than one day of it. No travel days means
// no travel money, whatever's in the box.
function travelMoney(shoot) {
  const days = travelCount(shoot);
  if (!days || shoot.travel_fee == null || shoot.travel_fee === '') return null;
  const fee = Number(shoot.travel_fee);
  if (!isFinite(fee) || fee === 0) return null;
  return shoot.travel_each === false ? fee : fee * days;
}

// '1 day before, 2 days after'
function travelWords(shoot) {
  const before = travelBefore(shoot);
  const after  = travelAfter(shoot);
  const bits = [];
  if (before) bits.push(before + (before === 1 ? ' day before' : ' days before'));
  if (after)  bits.push(after  + (after  === 1 ? ' day after'  : ' days after'));
  return bits.join(', ');
}

// The big number, plus the smaller ones underneath when a job is split
// or carries travel.
function feeHTML(shoot) {
  const info = feeInfo(shoot);
  const travel = travelMoney(shoot);

  if (info.headline == null && travel == null) return '<div class="fee">&mdash;</div>';

  let html = `<div class="fee">${info.headline == null ? '&mdash;' : money(info.headline)}</div>`;
  if (info.split) {
    html += `<div class="feesub">${money(info.schedule)} ${isOwner ? 'to crew' : 'yours'}</div>`;
  }
  if (travel != null) {
    html += `<div class="feesub">+ ${money(travel)} travel</div>`;
  }
  return html;
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

const SCREENS = ['home', 'shoots', 'calendar', 'invoices', 'money', 'more'];

// Invoices, Money and Account all live behind the More menu, so all three
// light up the More tab. Everything else lights up its own.
const TAB_FOR = {
  home: 'home', shoots: 'shoots', calendar: 'calendar',
  invoices: 'more', money: 'more', more: 'more'
};

function goto(name) {
  SCREENS.forEach((n) => {
    el('screen-' + n).classList.toggle('hidden', n !== name);
  });
  const lit = TAB_FOR[name] || name;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === lit);
  });
  closeMoreMenu();
  window.scrollTo(0, 0);
}

// ---- the More menu ----

function openMoreMenu() {
  show('moremenu');
  show('scrim');
  el('moretab').setAttribute('aria-expanded', 'true');
}

function closeMoreMenu() {
  hide('moremenu');
  hide('scrim');
  el('moretab').setAttribute('aria-expanded', 'false');
}

el('scrim').addEventListener('click', closeMoreMenu);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMoreMenu();
});

el('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;

  // More isn't a screen — it's a menu that drops up out of the bar.
  if (button.dataset.tab === 'more') {
    if (el('moremenu').classList.contains('hidden')) openMoreMenu();
    else closeMoreMenu();
    return;
  }

  // Add isn't a screen of its own either — it's the schedule with the
  // form already open.
  if (button.dataset.tab === 'add') {
    goto('shoots');
    openForm();
    return;
  }
  goto(button.dataset.tab);
});

el('moremenu').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-go]');
  if (!button) return;

  closeMoreMenu();

  if (button.dataset.go === 'signout') {
    await supabase.auth.signOut();
    return;
  }
  goto(button.dataset.go);
});

// ---- the team this signed-in person belongs to ----
// Needed on insert so the row passes the security policies. Stays null
// if we can't find it.
let teamId = null;

async function loadProfile(userId) {
  teamId = null;
  isOwner = false;
  canInvoice = false;

  const { data } = await supabase
    .from('profiles')
    .select('team_id, full_name, title, role, can_invoice')
    .eq('id', userId)
    .maybeSingle();

  if (data) {
    teamId = data.team_id || null;
    canInvoice = data.can_invoice === true;
    el('whoname').textContent = data.full_name || '';
    el('whotitle').textContent = data.title || data.role || '';
  }

  // Asked of the database rather than read off the profile row above,
  // because the same function is what the fee policies use. One answer,
  // one place, no chance of the screen and the rules disagreeing.
  const owner = await supabase.rpc('is_team_owner');
  isOwner = owner.data === true;

  el('clientfee').classList.toggle('hidden', !isOwner);
  el('feelabel').innerHTML = isOwner ? 'Fee on schedule &pound;' : 'Fee &pound;';

  el('mi_invoices').classList.toggle('hidden', !canInvoice);
  el('mi_money').classList.toggle('hidden', !canInvoice);
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

function fillCrewSelect() {
  el('f_crew').innerHTML = '<option value="">&mdash; not set &mdash;</option>' + CREW
    .map((c) => `<option value="${escapeAttr(c.tag)}">${escapeText(c.tag + ' — ' + c.name)}</option>`)
    .join('');
}

fillSelect('f_type', JOB_TYPES);
fillSelect('f_status', STATUSES);
fillCrewSelect();

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
let crewFilter = 'any';
let search = '';

const COLUMNS = 'id, shoot_date, call_time, venue, client, fee, job_type, status, crew, '
              + 'travel_before, travel_after, travel_fee, travel_each';

// The fees have to land before anything draws, or the first paint shows
// the schedule fee where the client fee belongs and then corrects itself.
async function refresh() {
  await loadFees();
  await Promise.all([loadAll(), loadShoots(), loadInvoices(), loadEntries()]);

  // The tracker reads invoices and entries together, so it draws once both
  // have landed rather than twice, half-finished.
  renderMoney();
}

async function loadFees() {
  feeMap = {};

  const { data, error } = await supabase
    .from('shoot_fees')
    .select('shoot_id, actual_fee, shared');

  // An error here isn't worth showing anyone. For a non-owner an empty
  // result is the correct, expected answer.
  if (error) return;

  (data || []).forEach((row) => { feeMap[row.shoot_id] = row; });
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
  buildClientList();
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
    const nextFee = feeInfo(next).headline;
    const meta = [next.client, nextFee == null ? null : money(nextFee)].filter(Boolean);
    const travel = travelCount(next)
      ? ` &middot; travel ${escapeText(travelWords(next))}`
      : '';

    el('nextup').innerHTML = `
      <div class="nextup" style="border-left-color:${crewColour(next.crew)}">
        <div class="bigdate">${longDate(next.shoot_date)}${next.call_time ? ' &middot; ' + escapeText(shortTime(next.call_time)) : ''} ${crewTag(next.crew)}</div>
        <div class="bigvenue">${escapeText(next.venue)}</div>
        <div class="bigmeta">${escapeText(meta.join(' · ')) || '&mdash;'}</div>
        <div class="in">${when} &middot; ${escapeText(next.job_type)} &middot; ${escapeText(next.status)}${travel}</div>
      </div>`;
  }

  updateTally(upcoming);
  renderNudges();
}

function updateTally(upcoming) {
  const monthPrefix = todayISO().slice(0, 7);
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long' });
  const thisMonth = upcoming.filter((s) => String(s.shoot_date).startsWith(monthPrefix)).length;

  // Travel money counts as booked money. It's on the invoice, so it's
  // owed, and leaving it out would make the figure quietly wrong.
  let confirmed = 0;
  let provisional = 0;
  upcoming.forEach((s) => {
    const fee = Number(feeInfo(s).headline || 0) + Number(travelMoney(s) || 0);
    if (PROVISIONAL.includes(s.status)) provisional += fee;
    else confirmed += fee;
  });

  const travelAhead = upcoming.reduce((sum, s) => sum + travelCount(s), 0);

  el('t_ahead').textContent = upcoming.length;
  el('t_ahead_sub').textContent = thisMonth + ' in ' + monthName
    + (travelAhead ? ' · +' + travelAhead + ' travel' : '');
  el('t_booked').textContent = money(confirmed);
  el('t_booked_sub').textContent = provisional ? money(provisional) + ' pencilled' : 'all confirmed';

  // Owed looks at every shoot, not just the ones ahead — most of what's
  // outstanding is work that's already happened.
  const owedRows = allShoots.filter((s) => OWED_STATUSES.includes(s.status));
  const owed = owedRows.reduce(
    (sum, row) => sum + Number(feeInfo(row).headline || 0) + Number(travelMoney(row) || 0), 0);
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
    <div class="mini" style="border-left-color:${crewColour(s.crew)}">
      <div>
        <div class="mv">${escapeText(s.venue)} ${crewTag(s.crew)}</div>
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

// date -> [{ shoot, side }]. Rebuilt on every calendar draw.
let travelByDate = {};

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

  // And the same again for the days either side that travel blocks out.
  // Built fresh every draw from the shoots themselves, so it can't fall
  // out of step with them.
  travelByDate = {};
  allShoots.forEach((s) => {
    travelDates(s).forEach((t) => {
      (travelByDate[t.iso] = travelByDate[t.iso] || []).push({ shoot: s, side: t.side });
    });
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
    const held = travelByDate[iso] || [];

    const classes = ['day'];
    if (d.getMonth() !== calMonth.getMonth()) classes.push('out');
    if (iso === today) classes.push('today');
    if (iso === selectedDay) classes.push('on');
    // A day that's only held for travel is shaded, so a full week reads
    // as full at a glance rather than looking half free.
    if (held.length && !list.length) classes.push('held');

    // Solid pip for a shoot, hollow for a day held open to travel.
    const pips = list.slice(0, 3)
      .map((s) => `<i style="background:${crewColour(s.crew)}"></i>`).join('')
      + held.slice(0, 3 - Math.min(3, list.length))
        .map((t) => `<i class="tr" style="box-shadow:inset 0 0 0 1.5px ${crewColour(t.shoot.crew)}"></i>`).join('');

    cells += `<button type="button" class="${classes.join(' ')}" data-date="${iso}">
        <span>${d.getDate()}</span><span class="pips">${pips}</span>
      </button>`;
  }

  el('calcells').innerHTML = cells;

  el('callegend').innerHTML = CREW
    .map((c) => `<div><span style="background:var(${c.accent})"></span>${escapeText(c.tag)} &mdash; ${escapeText(c.name)}</div>`)
    .join('') + '<div><span class="hollow"></span>Travel day</div>';

  renderDay();
}

function renderDay() {
  if (!selectedDay) {
    el('dayview').innerHTML = '';
    return;
  }

  const rows = allShoots.filter((s) => s.shoot_date === selectedDay).sort(byDateAscending);
  const held = travelByDate[selectedDay] || [];
  const heading = `<div class="label gap">${longDate(selectedDay)}</div>`;

  if (!rows.length && !held.length) {
    el('dayview').innerHTML = heading + '<div class="empty">Nothing that day.</div>';
    return;
  }

  const shootRows = rows.map((s) => `
    <div class="mini" style="border-left-color:${crewColour(s.crew)}">
      <div>
        <div class="mv">${escapeText(s.venue)} ${crewTag(s.crew)}</div>
        <div class="mm">${escapeText(s.client || '—')}${s.call_time ? ' &middot; ' + escapeText(shortTime(s.call_time)) : ''}</div>
      </div>
      <div class="mf">${money(feeInfo(s).headline)}</div>
    </div>`).join('');

  // Travel days say which job is holding them and which way you're going,
  // so a held day is never a mystery.
  const heldRows = held.map((t) => `
    <div class="mini travel" style="border-left-color:${crewColour(t.shoot.crew)}">
      <div>
        <div class="mv">Travel ${t.side === 'out' ? 'out' : 'back'} ${crewTag(t.shoot.crew)}</div>
        <div class="mm">Held for ${escapeText(t.shoot.venue)} &middot; ${longDate(t.shoot.shoot_date)}</div>
      </div>
      <div class="tag">Blocked</div>
    </div>`).join('');

  el('dayview').innerHTML = heading + shootRows + heldRows;
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
    if (crewFilter !== 'any' && (s.crew || '') !== crewFilter) return false;
    if (needle) {
      const hay = ((s.venue || '') + ' ' + (s.client || '')).toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function renderList() {
  const rows = visibleShoots();
  const filtering = statusFilter !== 'any' || crewFilter !== 'any' || search.trim() !== '';

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

// A small dashed marker on a row that's holding days either side of it.
function travelMark(shoot) {
  const days = travelCount(shoot);
  if (!days) return '';
  return `<span class="travelmark" title="Travel: ${escapeAttr(travelWords(shoot))}">+${days} travel</span>`;
}

function rowHTML(shoot) {
  const colour = crewColour(shoot.crew);

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
          <div class="type">${escapeText(shoot.job_type)} ${crewTag(shoot.crew)}${travelMark(shoot)}</div>
        </div>
        <div class="end">
          ${feeHTML(shoot)}
          <div class="status" style="color:${statusColour(shoot.status)}">${escapeText(shoot.status)}</div>
        </div>
        <button type="button" class="dots" data-act="menu" data-id="${escapeAttr(shoot.id)}"
                aria-expanded="false" aria-label="Options for ${escapeAttr(shoot.venue)}">&#8942;</button>
      </div>
      <div class="menu hidden">
        <div class="error hidden"></div>
        <div class="label">Status</div>
        <div class="chips">${statusChips}</div>
        ${shareChip(shoot)}
        <div class="chips">
          <button type="button" class="chip" data-act="edit" data-id="${escapeAttr(shoot.id)}">Edit details</button>
          <button type="button" class="chip danger" data-act="delete" data-id="${escapeAttr(shoot.id)}">Delete</button>
        </div>
      </div>
    </div>`;
}

// Only offered to an owner, and only on jobs that actually have a split
// worth hiding.
function shareChip(shoot) {
  if (!isOwner) return '';
  const info = feeInfo(shoot);
  if (info.actual == null) return '';

  return `
        <div class="label">Client fee</div>
        <div class="chips">
          <button type="button" class="chip${info.shared ? ' on' : ''}"
                  data-act="share" data-id="${escapeAttr(shoot.id)}">${info.shared ? 'Crew can see ' + money(info.actual) : 'Hidden from crew'}</button>
        </div>`;
}

function findShoot(id) {
  return shoots.find((s) => String(s.id) === String(id));
}

function closeAllMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
  document.querySelectorAll('.dots').forEach((d) => {
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

  if (act === 'share') {
    const shoot = findShoot(id);
    const info = feeInfo(shoot);

    button.textContent = '…';
    const { data, error } = await supabase
      .from('shoot_fees').update({ shared: !info.shared })
      .eq('shoot_id', id).select('shoot_id');

    if (error || !data || !data.length) {
      menuError(menu, error ? error.message : 'The database refused that. Only an owner can unlock a client fee.');
      return;
    }
    flash(info.shared
      ? 'Client fee hidden from the crew again.'
      : 'Crew can now see the client fee on ' + shoot.venue + '.');
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

function buildCrewChips() {
  const anyChip = `<button type="button" class="chip${crewFilter === 'any' ? ' on' : ''}"
              data-crew="any">Anyone</button>`;

  el('crewchips').innerHTML = anyChip + CREW.map((c) => `
    <button type="button" class="chip${c.tag === crewFilter ? ' on' : ''}" data-crew="${escapeAttr(c.tag)}">
      <span class="swatch" style="background:var(${c.accent})"></span>${escapeText(c.tag)}</button>`).join('');
}

el('crewchips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-crew]');
  if (!chip || chip.dataset.crew === crewFilter) return;
  crewFilter = chip.dataset.crew;
  buildCrewChips();
  renderList();
});

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
buildCrewChips();
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
  fillCrewSelect();
  el('f_crew').value = myTag;
  el('f_actual').value = '';
  el('f_shared').checked = false;
  el('f_date').value = todayISO();

  el('f_tbefore').value = 0;
  el('f_tafter').value = 0;
  el('f_tfee').value = '';
  el('f_teach').value = 'each';
  updateTravelSummary();

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
  fillCrewSelect();

  el('f_date').value = shoot.shoot_date;
  el('f_time').value = shortTime(shoot.call_time);
  el('f_venue').value = shoot.venue || '';
  el('f_client').value = shoot.client || '';
  el('f_fee').value = shoot.fee == null ? '' : shoot.fee;
  setSelect('f_type', shoot.job_type);
  setSelect('f_status', shoot.status);
  setSelect('f_crew', shoot.crew || '');

  const info = feeInfo(shoot);
  el('f_actual').value = info.actual == null ? '' : info.actual;
  el('f_shared').checked = info.shared;

  el('f_tbefore').value = travelBefore(shoot);
  el('f_tafter').value  = travelAfter(shoot);
  el('f_tfee').value    = shoot.travel_fee == null ? '' : shoot.travel_fee;
  el('f_teach').value   = shoot.travel_each === false ? 'total' : 'each';
  updateTravelSummary();

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

// The line under the travel boxes. It names the exact dates being held and
// says plainly if one of them already has a job on it — which is the whole
// reason for blocking them out in the first place.
function updateTravelSummary() {
  const date   = el('f_date').value;
  const before = Math.max(0, Math.min(14, Number(el('f_tbefore').value || 0)));
  const after  = Math.max(0, Math.min(14, Number(el('f_tafter').value  || 0)));
  const days   = before + after;
  const box    = el('travelsum');

  el('travelfee').classList.toggle('hidden', days === 0);

  if (!days) {
    box.innerHTML = 'No travel days. The calendar stays free either side.';
    return;
  }
  if (!date) {
    box.innerHTML = days + (days === 1 ? ' day held' : ' days held')
      + ' &mdash; set a date to see which.';
    return;
  }

  const draft = {
    shoot_date:    date,
    travel_before: before,
    travel_after:  after,
    travel_fee:    el('f_tfee').value.trim() === '' ? null : Number(el('f_tfee').value),
    travel_each:   el('f_teach').value !== 'total'
  };

  const dates = travelDates(draft);
  const worth = travelMoney(draft);

  const parts = [
    days + (days === 1 ? ' day held' : ' days held'),
    dates.map((t) => longDate(t.iso)).join(', ')
  ];
  if (worth != null) parts.push(money(worth) + ' travel');

  // Anything already booked on a day we're about to hold. The shoot being
  // edited doesn't count as a clash with itself.
  const clashes = dates
    .map((t) => ({
      iso: t.iso,
      hits: allShoots.filter((s) => s.shoot_date === t.iso
        && String(s.id) !== String(editingId))
    }))
    .filter((c) => c.hits.length);

  box.innerHTML = escapeText(parts.join(' · '))
    + clashes.map((c) => `<span class="clash">${longDate(c.iso)} already has `
        + `${escapeText(c.hits.map((s) => s.venue).join(', '))} on it.</span>`).join('');
}

['f_tbefore', 'f_tafter', 'f_tfee', 'f_teach', 'f_date'].forEach((id) => {
  el(id).addEventListener('input', updateTravelSummary);
  el(id).addEventListener('change', updateTravelSummary);
});

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

  // No travel days means no travel money, whatever's still sitting in the
  // box. Saving a fee against zero days would leave a figure that shows up
  // nowhere and can't be found again.
  const tBefore = Math.max(0, Math.min(14, Number(el('f_tbefore').value || 0)));
  const tAfter  = Math.max(0, Math.min(14, Number(el('f_tafter').value  || 0)));
  const tFee    = el('f_tfee').value.trim();

  const row = {
    shoot_date: date,
    call_time:  el('f_time').value || null,
    venue:      venue,
    client:     el('f_client').value.trim() || null,
    fee:        fee === '' ? null : Number(fee),
    job_type:   el('f_type').value,
    status:     el('f_status').value,
    crew:       el('f_crew').value || null,

    travel_before: tBefore,
    travel_after:  tAfter,
    travel_fee:    (tBefore + tAfter) === 0 || tFee === '' ? null : Number(tFee),
    travel_each:   el('f_teach').value !== 'total'
  };

  const saving = editingId;
  el('save').disabled = true;
  el('save').textContent = 'Saving…';

  let problem;
  let shootId = saving;

  if (saving) {
    problem = await changeRow(saving, row);
  } else {
    if (teamId) row.team_id = teamId;
    const { data, error } = await supabase.from('shoots').insert(row).select('id');
    problem = error ? error.message + (error.hint ? ' — ' + error.hint : '') : null;
    if (data && data.length) shootId = data[0].id;
  }

  // The client fee is a second write to a second table, so it can fail on
  // its own. If it does, say so plainly rather than letting you walk away
  // believing a split was recorded.
  if (!problem && isOwner && shootId) {
    problem = await saveClientFee(shootId);
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

async function saveClientFee(shootId) {
  const typed = el('f_actual').value.trim();

  // Cleared the box: there's no split any more, so the row goes.
  if (typed === '') {
    const { error } = await supabase.from('shoot_fees').delete().eq('shoot_id', shootId);
    return error ? 'The shoot saved, but the client fee could not be removed: ' + error.message : null;
  }

  const { error } = await supabase.from('shoot_fees').upsert({
    shoot_id:   shootId,
    actual_fee: Number(typed),
    shared:     el('f_shared').checked,
    updated_at: new Date().toISOString()
  }, { onConflict: 'shoot_id' });

  return error ? 'The shoot saved, but the client fee did not: ' + error.message : null;
}

// ============================================================
// Invoices
//
// An invoice is one row. Its lines live inside that row as a small list,
// because an invoice is only ever read whole — splitting them into their
// own table would buy nothing and cost a second query every time.
//
// The PDF is not stored anywhere. It's redrawn from the row whenever you
// ask for it, which means the file you download in a year's time is
// generated from the same numbers you saved today, and there's no second
// copy that can drift out of step with the first.
// ============================================================

let invoices = [];
let invFilter = 'all';
let editingInvoice = null;

const INV_FILTERS = [
  ['all',   'Everything'],
  ['draft', 'Draft'],
  ['sent',  'Sent'],
  ['chase', 'To chase'],
  ['paid',  'Paid']
];

// Sent, and the due date has passed. This is the only derived state —
// the other three are stored words.
function isLate(inv) {
  return inv.status === 'sent' && String(inv.due_on) < todayISO();
}

function invColour(inv) {
  if (inv.status === 'paid') return 'var(--paid)';
  if (isLate(inv)) return 'var(--stamp)';
  if (inv.status === 'sent') return 'var(--accent-4)';
  return 'var(--neutral)';
}

async function loadInvoices() {
  if (!canInvoice) { invoices = []; return; }

  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .order('seq', { ascending: false });

  if (error) {
    invoices = [];
    el('invlist').innerHTML = '<div class="error">Error: ' + escapeText(error.message) + '</div>';
    return;
  }

  invoices = data || [];
  renderInvoices();
}

function renderInvoices() {
  const sent  = invoices.filter((i) => i.status === 'sent');
  const paid  = invoices.filter((i) => i.status === 'paid');
  const late  = invoices.filter(isLate);

  const sum = (rows) => rows.reduce((t, r) => t + Number(r.total || 0), 0);

  el('i_sent').textContent = money(sum(sent));
  el('i_sent_sub').textContent = sent.length + ' awaiting';
  el('i_paid').textContent = money(sum(paid));
  el('i_paid_sub').textContent = paid.length + ' settled';
  el('i_chase').textContent = money(sum(late));
  el('i_chase_sub').textContent = late.length ? late.length + ' overdue' : 'nothing late';

  buildInvChips();

  const rows = invoices.filter((i) => {
    if (invFilter === 'all') return true;
    if (invFilter === 'chase') return isLate(i);
    return i.status === invFilter;
  });

  el('invlabel').textContent = (INV_FILTERS.find((f) => f[0] === invFilter) || [])[1] || 'Everything';

  if (!invoices.length) {
    el('invlist').innerHTML = '<div class="empty">No invoices yet. Make the first one above.</div>';
    el('invcount').textContent = '0';
    return;
  }

  if (!rows.length) {
    el('invlist').innerHTML = '<div class="empty">Nothing in there.</div>';
    el('invcount').textContent = '0 of ' + invoices.length;
    return;
  }

  el('invcount').textContent = invFilter === 'all'
    ? rows.length + (rows.length === 1 ? ' invoice' : ' invoices')
    : rows.length + ' of ' + invoices.length;

  el('invlist').innerHTML = rows.map(invoiceRowHTML).join('');
}

function buildInvChips() {
  el('invchips').innerHTML = INV_FILTERS.map(([value, text]) => `
    <button type="button" class="chip${value === invFilter ? ' on' : ''}"
            data-inv-filter="${escapeAttr(value)}">${escapeText(text)}</button>`).join('');
}

el('invchips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-inv-filter]');
  if (!chip || chip.dataset.invFilter === invFilter) return;
  invFilter = chip.dataset.invFilter;
  renderInvoices();
});

function invoiceRowHTML(inv) {
  const lines = (inv.lines || []).length;
  const late = isLate(inv);
  const overdueBy = late ? Math.abs(daysUntil(inv.due_on)) : 0;

  const note = inv.status === 'paid'
    ? 'Paid ' + dotDate(inv.paid_on || inv.issued_on)
    : late
      ? `<span class="late">${overdueBy} ${overdueBy === 1 ? 'day' : 'days'} late</span>`
      : 'Due ' + dotDate(inv.due_on);

  const statusChips = ['draft', 'sent', 'paid'].map((s) => `
        <button type="button" class="chip${s === inv.status ? ' on' : ''}"
                data-iact="status" data-id="${escapeAttr(inv.id)}" data-value="${s}">${titleCase(s)}</button>`).join('');

  return `
    <div class="shootwrap inv" data-inv="${escapeAttr(inv.id)}" style="border-left-color:${invColour(inv)}">
      <div class="shoot">
        <div class="when">
          <div class="date">${escapeText(inv.number)}</div>
          <div class="time">${dotDate(inv.issued_on)}</div>
        </div>
        <div class="mid">
          <div class="venue">${escapeText(inv.client || 'No client')}</div>
          <div class="client">${lines} ${lines === 1 ? 'line' : 'lines'} &middot; ${note}</div>
        </div>
        <div class="end">
          <div class="fee">${money2(inv.total)}</div>
          <div class="status" style="color:${invColour(inv)}">${escapeText(late ? 'chase' : inv.status)}</div>
        </div>
        <button type="button" class="dots" data-iact="menu" data-id="${escapeAttr(inv.id)}"
                aria-expanded="false" aria-label="Options for ${escapeAttr(inv.number)}">&#8942;</button>
      </div>
      <div class="menu hidden">
        <div class="error hidden"></div>
        <div class="label">Status</div>
        <div class="chips">${statusChips}</div>
        <div class="chips">
          <button type="button" class="chip" data-iact="pdf"    data-id="${escapeAttr(inv.id)}">Download PDF</button>
          <button type="button" class="chip" data-iact="edit"   data-id="${escapeAttr(inv.id)}">Edit</button>
          <button type="button" class="chip danger" data-iact="delete" data-id="${escapeAttr(inv.id)}">Delete</button>
        </div>
      </div>
    </div>`;
}

function findInvoice(id) {
  return invoices.find((i) => String(i.id) === String(id));
}

el('invlist').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-iact]');
  if (!button) return;

  const id = button.dataset.id;
  const wrap = button.closest('.shootwrap');
  const menu = wrap.querySelector('.menu');
  const act = button.dataset.iact;
  const inv = findInvoice(id);

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

  if (!inv) return;

  if (act === 'pdf') {
    button.textContent = 'Drawing…';
    try {
      await downloadInvoice(inv);
      button.textContent = 'Download PDF';
    } catch (problem) {
      button.textContent = 'Download PDF';
      menuError(menu, 'The PDF didn\'t draw: ' + (problem && problem.message ? problem.message : problem));
    }
    return;
  }

  if (act === 'edit') {
    startEditInvoice(inv);
    return;
  }

  if (act === 'status') {
    const value = button.dataset.value;
    if (inv.status === value) { closeAllMenus(); return; }

    button.textContent = '…';
    const patch = { status: value };
    if (value === 'sent' && !inv.sent_on) patch.sent_on = todayISO();
    if (value === 'paid') patch.paid_on = todayISO();

    const problem = await changeInvoice(id, patch);
    if (problem) {
      button.textContent = titleCase(value);
      menuError(menu, problem);
      return;
    }

    // Marking an invoice paid marks the jobs on it paid too, so the
    // schedule and the invoice list can't tell you different things.
    let alsoDone = 0;
    if (value === 'paid') alsoDone = await markShootsPaid(inv);

    flash(inv.number + ' is now ' + value + '.'
      + (alsoDone ? ` ${alsoDone} ${alsoDone === 1 ? 'shoot' : 'shoots'} marked paid as well.` : ''));
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

    button.textContent = 'Deleting…';
    const { data, error } = await supabase
      .from('invoices').delete().eq('id', id).select('id');

    if (error || !data || !data.length) {
      button.dataset.armed = '';
      button.classList.remove('armed');
      button.textContent = 'Delete';
      menuError(menu, error ? error.message : 'The database refused that.');
      return;
    }

    if (editingInvoice && String(editingInvoice.id) === String(id)) closeInvoiceForm();
    flash(inv.number + ' has gone. The jobs on it are free to invoice again.');
    refresh();
  }
});

async function changeInvoice(id, patch) {
  const { data, error } = await supabase
    .from('invoices').update(patch).eq('id', id).select('id');

  if (error) return error.message;
  if (!data || !data.length) {
    return 'Nothing changed — the database refused it. That usually means this account isn\'t set up to invoice.';
  }
  return null;
}

// Best effort. If a shoot won't update, the invoice is still paid — the
// count in the message just comes back smaller.
async function markShootsPaid(inv) {
  const ids = (inv.shoot_ids || []).map(String);
  if (!ids.length) return 0;

  const { data } = await supabase
    .from('shoots').update({ status: 'paid' }).in('id', ids).select('id');

  return data ? data.length : 0;
}

// ---- the invoice form ----

function nextSeq() {
  return invoices.reduce((top, i) => Math.max(top, Number(i.seq || 0)), 0) + 1;
}

function numberFor(seq) {
  return ME.prefix + String(seq).padStart(3, '0');
}

// Pull the digits back out of whatever's typed, so you can override the
// number by hand and the ordering still makes sense.
function seqFromNumber(text, fallback) {
  const m = String(text).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : fallback;
}

function buildClientList() {
  const names = Array.from(new Set(
    allShoots.map((s) => (s.client || '').trim()).filter(Boolean)
  )).sort();

  el('clientnames').innerHTML = names
    .map((n) => `<option value="${escapeAttr(n)}"></option>`).join('');
}

// Every shoot already sitting on some invoice. Those don't get offered
// again, which is what stops a job being billed twice.
function billedShootIds() {
  const set = new Set();
  invoices.forEach((inv) => {
    if (editingInvoice && String(inv.id) === String(editingInvoice.id)) return;
    (inv.shoot_ids || []).forEach((id) => set.add(String(id)));
  });
  return set;
}

function attachedIds() {
  return Array.from(document.querySelectorAll('#lines .lineitem[data-shoot]'))
    .map((n) => n.dataset.shoot);
}

function renderPicker() {
  const name = el('f_i_client').value.trim().toLowerCase();

  if (!name) {
    hide('pickwrap');
    el('pickshoots').innerHTML = '';
    return;
  }

  const billed = billedShootIds();
  const attached = new Set(attachedIds());

  const rows = allShoots
    .filter((s) => (s.client || '').trim().toLowerCase() === name)
    .filter((s) => !billed.has(String(s.id)))
    .sort(byDateAscending)
    .reverse();

  show('pickwrap');

  if (!rows.length) {
    el('pickshoots').innerHTML = '<div class="pm" style="padding:6px 0">No uninvoiced jobs under that name. Add lines by hand below.</div>';
    return;
  }

  el('pickshoots').innerHTML = rows.map((s) => {
    const fee = feeInfo(s).headline;
    const travel = travelMoney(s);
    return `
      <label class="pickrow">
        <input type="checkbox" data-shoot="${escapeAttr(s.id)}"${attached.has(String(s.id)) ? ' checked' : ''}>
        <span>
          ${escapeText(s.venue)}
          <span class="pm">${longDate(s.shoot_date)} &middot; ${escapeText(s.job_type)} &middot; ${escapeText(s.status)}</span>
          ${travel == null ? '' : `<span class="pm">+ ${escapeText(travelWords(s))} &middot; ${money(travel)}</span>`}
        </span>
        <span class="pf">${fee == null ? '—' : money(fee)}</span>
      </label>`;
  }).join('');
}

// Ticking a job puts a line on the invoice. Unticking takes it off again.
// Nothing to press, and the two can't drift apart.
el('pickshoots').addEventListener('change', (event) => {
  const box = event.target.closest('input[data-shoot]');
  if (!box) return;

  const id = box.dataset.shoot;

  // A job can put two lines on an invoice — the shoot, and its travel.
  // Both carry the same shoot id, so both come off together.
  const existing = document.querySelectorAll(`#lines .lineitem[data-shoot="${CSS.escape(id)}"]`);

  if (!box.checked) {
    existing.forEach((node) => node.remove());
    updateLineTotal();
    return;
  }
  if (existing.length) return;

  const shoot = allShoots.find((s) => String(s.id) === String(id));
  if (!shoot) return;

  addLine({
    d: `${titleCase(shoot.job_type || 'Shoot')} — ${shoot.venue}, ${dotDate(shoot.shoot_date)}`,
    q: 1,
    u: feeInfo(shoot).headline == null ? '' : feeInfo(shoot).headline
  }, shoot.id);

  // Travel is billed on its own line rather than folded into the fee, so
  // the client can see what they're paying for. Per-day travel goes on as
  // a quantity, which is what the QTY column is for.
  const travel = travelMoney(shoot);
  if (travel != null) {
    const days = travelCount(shoot);
    const perDay = shoot.travel_each !== false;

    addLine({
      d: `Travel — ${shoot.venue}, ${dotDate(shoot.shoot_date)}`,
      q: perDay ? days : 1,
      u: perDay ? Number(shoot.travel_fee) : travel
    }, shoot.id);
  }
});

el('f_i_client').addEventListener('input', () => {
  renderPicker();
  prefillBillTo();
});

// The last invoice to the same client already has their address on it.
// Only fills boxes you haven't touched.
function prefillBillTo() {
  const name = el('f_i_client').value.trim().toLowerCase();
  if (!name) return;

  const last = invoices.find((i) => (i.client || '').trim().toLowerCase() === name);
  if (!last) return;

  const pairs = [
    ['f_i_contact', last.bill_contact],
    ['f_i_company', last.bill_company],
    ['f_i_address', last.bill_address],
    ['f_i_phone',   last.bill_phone],
    ['f_i_email',   last.bill_email]
  ];
  pairs.forEach(([id, value]) => {
    if (!el(id).value.trim() && value) el(id).value = value;
  });
}

function lineHTML(line) {
  return `
      <div class="linelabel">Description</div>
      <input type="text" class="ldesc" autocomplete="off" value="${escapeAttr(line.d || '')}">
      <div class="lrow">
        <div>
          <div class="linelabel">Qty</div>
          <input type="number" class="lqty" min="0" step="0.5" inputmode="decimal" value="${line.q == null ? 1 : escapeAttr(line.q)}">
        </div>
        <div>
          <div class="linelabel">Unit price &pound;</div>
          <input type="number" class="lunit" min="0" step="0.01" inputmode="decimal" value="${line.u == null || line.u === '' ? '' : escapeAttr(line.u)}">
        </div>
        <div class="drop">
          <div class="linelabel">&nbsp;</div>
          <button type="button" class="quiet lremove" aria-label="Remove this line">&times;</button>
        </div>
      </div>`;
}

function addLine(line, shootId) {
  const node = document.createElement('div');
  node.className = 'lineitem';
  if (shootId != null) node.dataset.shoot = String(shootId);
  node.innerHTML = lineHTML(line || {});
  el('lines').appendChild(node);
  updateLineTotal();
}

// Each line carries the shoot it came from, if it came from one. Keeping
// that on the line rather than in a list beside it is what stops the two
// falling out of step when an invoice mixes picked jobs with typed ones.
function readLines() {
  return Array.from(document.querySelectorAll('#lines .lineitem')).map((n) => ({
    d: n.querySelector('.ldesc').value.trim(),
    q: Number(n.querySelector('.lqty').value || 0),
    u: Number(n.querySelector('.lunit').value || 0),
    s: n.dataset.shoot || null
  }));
}

function updateLineTotal() {
  const total = readLines().reduce((t, l) => t + l.q * l.u, 0);
  el('linetotal').textContent = money2(total);
}

el('lines').addEventListener('input', updateLineTotal);

el('lines').addEventListener('click', (event) => {
  const button = event.target.closest('.lremove');
  if (!button) return;
  button.closest('.lineitem').remove();
  updateLineTotal();
  renderPicker();
});

el('addline').addEventListener('click', () => addLine({ q: 1 }));

function openInvoiceForm() {
  editingInvoice = null;
  closeAllMenus();
  hide('inverror');
  hide('flash');

  el('newinvoice').reset();
  el('lines').innerHTML = '';
  el('f_i_number').value = numberFor(nextSeq());
  el('f_i_date').value = todayISO();
  el('f_i_terms').value = 7;
  renderPicker();
  addLine({ q: 1 });

  el('invtitle').textContent = 'Make an invoice';
  el('saveinvoice').textContent = 'Save and download PDF';
  show('newinvoice');
  hide('openinvoice');
  el('f_i_client').focus();
}

function startEditInvoice(inv) {
  editingInvoice = inv;
  closeAllMenus();
  hide('inverror');
  hide('flash');

  el('newinvoice').reset();
  el('f_i_number').value = inv.number;
  el('f_i_date').value = inv.issued_on;
  el('f_i_terms').value = inv.terms_days == null ? 7 : inv.terms_days;
  el('f_i_client').value = inv.client || '';
  el('f_i_contact').value = inv.bill_contact || '';
  el('f_i_company').value = inv.bill_company || '';
  el('f_i_address').value = inv.bill_address || '';
  el('f_i_phone').value = inv.bill_phone || '';
  el('f_i_email').value = inv.bill_email || '';

  // Lines that came from a shoot keep their link, so the picker shows
  // them still ticked and can't offer them twice.
  el('lines').innerHTML = '';
  (inv.lines || []).forEach((line) => addLine(line, line.s || null));
  if (!(inv.lines || []).length) addLine({ q: 1 });

  renderPicker();

  el('invtitle').textContent = 'Edit ' + inv.number;
  el('saveinvoice').textContent = 'Save changes and download PDF';
  show('newinvoice');
  hide('openinvoice');
  el('newinvoice').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeInvoiceForm() {
  editingInvoice = null;
  hide('newinvoice');
  show('openinvoice');
}

el('openinvoice').addEventListener('click', openInvoiceForm);
el('cancelinvoice').addEventListener('click', closeInvoiceForm);

el('newinvoice').addEventListener('submit', async (event) => {
  event.preventDefault();
  hide('inverror');

  const number = el('f_i_number').value.trim();
  const issued = el('f_i_date').value;
  const terms  = Number(el('f_i_terms').value || 0);
  const lines  = readLines().filter((l) => l.d !== '' || l.u);

  if (!number || !issued) {
    el('inverror').textContent = 'An invoice number and an issue date are needed before this can be saved.';
    show('inverror');
    return;
  }
  if (!lines.length) {
    el('inverror').textContent = 'An invoice with no lines on it isn\'t an invoice. Tick a job above or fill in a line by hand.';
    show('inverror');
    return;
  }

  // Only the lines that survived keep their shoot links, so a line deleted
  // by hand doesn't leave a job stuck marked as billed.
  // One job can put two lines on an invoice — the shoot and its travel —
  // so the same id can turn up twice. It only needs recording once.
  const shootIds = Array.from(new Set(lines.map((l) => l.s).filter(Boolean)));

  const row = {
    seq:        seqFromNumber(number, editingInvoice ? editingInvoice.seq : nextSeq()),
    number:     number,
    issued_on:  issued,
    due_on:     addDays(issued, terms),
    terms_days: terms,
    client:       el('f_i_client').value.trim() || null,
    bill_contact: el('f_i_contact').value.trim() || null,
    bill_company: el('f_i_company').value.trim() || null,
    bill_address: el('f_i_address').value.trim() || null,
    bill_phone:   el('f_i_phone').value.trim() || null,
    bill_email:   el('f_i_email').value.trim() || null,
    lines:      lines,
    total:      lines.reduce((t, l) => t + l.q * l.u, 0),
    shoot_ids:  shootIds
  };

  el('saveinvoice').disabled = true;
  el('saveinvoice').textContent = 'Saving…';

  let saved = null;
  let problem = null;

  if (editingInvoice) {
    const { data, error } = await supabase
      .from('invoices').update(row).eq('id', editingInvoice.id).select('*');
    problem = error ? error.message : (!data || !data.length ? 'The database refused that.' : null);
    if (data && data.length) saved = data[0];
  } else {
    row.team_id = teamId;
    row.status = 'draft';
    const { data, error } = await supabase.from('invoices').insert(row).select('*');
    problem = error
      ? error.message + (error.code === '23505' ? ' — that invoice number is already used.' : '')
      : null;
    if (data && data.length) saved = data[0];
  }

  el('saveinvoice').disabled = false;
  el('saveinvoice').textContent = editingInvoice ? 'Save changes and download PDF' : 'Save and download PDF';

  if (problem) {
    el('inverror').textContent = problem;
    show('inverror');
    return;
  }

  const wasEdit = !!editingInvoice;
  closeInvoiceForm();
  await refresh();

  try {
    await downloadInvoice(saved);
    flash(saved.number + (wasEdit ? ' updated' : ' saved as a draft')
      + ' and the PDF has downloaded. Mark it sent once it\'s gone out.');
  } catch (trouble) {
    flash(saved.number + ' saved, but the PDF didn\'t draw: '
      + (trouble && trouble.message ? trouble.message : trouble)
      + ' Try Download PDF from the row menu.');
  }
});

// ============================================================
// The money tracker
//
// The one decision worth understanding here: an invoice is NOT copied
// into this table when you make it. The tracker reads your invoices
// directly and turns each one into an income row as it draws.
//
// The alternative — writing a matching row every time an invoice is
// saved — would mean the same figure stored twice, and every edit,
// status change and deletion would have to remember to go and fix the
// second copy. Miss one and the tracker quietly disagrees with the
// invoice, and you'd have no way of knowing which was right.
//
// So this table only holds what an invoice can't tell us: money going
// out, and money coming in that didn't come from an invoice — a client
// paying back a flight you booked, for instance.
// ============================================================

let entries = [];
let editingEntry = null;

let moneyYear   = null;    // which tax year, or null for everything
let moneyFilter = 'all';   // all | in | out | unsettled
let moneyBasis  = 'all';   // all = as invoiced, settled = money actually moved

async function loadEntries() {
  if (!canInvoice) { entries = []; return; }

  const { data, error } = await supabase
    .from('entries')
    .select('*')
    .order('entry_date', { ascending: false });

  if (error) {
    entries = [];
    el('molist').innerHTML = '<div class="error">Error: ' + escapeText(error.message) + '</div>';
    return;
  }
  entries = data || [];
}

// ---- tax years ----
// The UK tax year runs 6 April to 5 April. A date in, say, February 2027
// belongs to the year that started in April 2026, which is the one your
// spreadsheet calls 2026/27.

function taxYearOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return (m > 4 || (m === 4 && d >= 6)) ? y : y - 1;
}

function taxYearLabel(year) {
  return year + '/' + String(year + 1).slice(2);
}

function currentTaxYear() {
  return taxYearOf(todayISO());
}

// ---- one shape for both kinds of row ----

// An invoice, seen as a line of income. Dated by when the money landed
// where that's known, and by the issue date where it hasn't yet — which
// is how your spreadsheet dates them too.
function invoiceAsRow(inv) {
  const first = ((inv.lines || [])[0] || {}).d || '';
  const bits = [inv.client, first].filter(Boolean);

  return {
    key:         'inv:' + inv.id,
    id:          inv.id,
    kind:        'invoice',
    status:      inv.status,
    label:       inv.status_label || '',
    date:        (inv.status === 'paid' && inv.paid_on) ? inv.paid_on : inv.issued_on,
    direction:   'in',
    amount:      Number(inv.total || 0),
    category:    'shoot',
    description: bits.length ? bits.join(' — ') : inv.number,
    ref:         inv.number,
    miles:       null,
    settled:     inv.status === 'paid',
    pendingWord: inv.status === 'draft' ? 'Draft' : 'Invoice pending'
  };
}

function entryAsRow(entry) {
  return {
    key:         'ent:' + entry.id,
    id:          entry.id,
    kind:        'entry',
    status:      entry.status,
    label:       entry.status_label || '',
    date:        entry.entry_date,
    direction:   entry.direction,
    amount:      Number(entry.amount || 0),
    category:    entry.category || '',
    description: entry.description || '',
    ref:         entry.ref || '',
    miles:       entry.miles == null ? null : Number(entry.miles),
    settled:     entry.status === 'settled',
    pendingWord: entry.direction === 'in' ? 'Awaiting payment' : 'To pay'
  };
}

// Everything, newest first.
function allMoneyRows() {
  return invoices.map(invoiceAsRow)
    .concat(entries.map(entryAsRow))
    .sort((a, b) => (a.date === b.date ? (a.key < b.key ? 1 : -1) : (a.date < b.date ? 1 : -1)));
}

// What the chips are currently letting through.
function visibleMoneyRows() {
  return allMoneyRows().filter((r) => {
    if (moneyYear != null && taxYearOf(r.date) !== moneyYear) return false;
    if (moneyFilter === 'in'  && r.direction !== 'in')  return false;
    if (moneyFilter === 'out' && r.direction !== 'out') return false;
    if (moneyFilter === 'unsettled' && r.settled) return false;
    if (moneyBasis === 'settled' && !r.settled) return false;
    return true;
  });
}

// ---- the figures at the top ----

function renderMoney() {
  if (!canInvoice) return;

  buildYearChips();
  buildMoneyChips();

  // The totals ignore the direction chips — narrowing the list to money
  // out shouldn't make it look as though nothing came in — but they do
  // follow the tax year and the basis, because both change what the
  // right answer is.
  const forTotals = allMoneyRows().filter((r) => {
    if (moneyYear != null && taxYearOf(r.date) !== moneyYear) return false;
    if (moneyBasis === 'settled' && !r.settled) return false;
    return true;
  });

  const sum = (rows) => rows.reduce((t, r) => t + r.amount, 0);
  const inRows  = forTotals.filter((r) => r.direction === 'in');
  const outRows = forTotals.filter((r) => r.direction === 'out');
  const income  = sum(inRows);
  const spent   = sum(outRows);

  const waiting = allMoneyRows().filter((r) =>
    (moneyYear == null || taxYearOf(r.date) === moneyYear) && !r.settled);
  const owedIn  = sum(waiting.filter((r) => r.direction === 'in'));
  const owedOut = sum(waiting.filter((r) => r.direction === 'out'));

  el('m_in').textContent   = money(income);
  el('m_in_sub').textContent = owedIn
    ? money(owedIn) + ' not in yet' : inRows.length + (inRows.length === 1 ? ' entry' : ' entries');

  el('m_out').textContent  = money(spent);
  el('m_out_sub').textContent = owedOut
    ? money(owedOut) + ' still to pay' : outRows.length + (outRows.length === 1 ? ' entry' : ' entries');

  el('m_profit').textContent = money(income - spent);
  el('m_profit_sub').textContent = moneyBasis === 'settled' ? 'money that moved' : 'as invoiced';

  const miles = forTotals.reduce((t, r) => t + Number(r.miles || 0), 0);
  el('m_miles').textContent = miles
    ? Math.round(miles) + ' miles logged · ' + money(miles * MILEAGE_RATE) + ' at ' + Math.round(MILEAGE_RATE * 100) + 'p'
    : 'No mileage logged.';

  renderSuggested();
  renderDoubleCheck();
  renderMoneyList();
}

// The one way this table and your invoices can disagree.
//
// Your old sheet's income lines live in here as entries, because the
// invoices behind them were raised before the app existed. If you ever
// raise an invoice in the app carrying a number that's already sitting
// in an imported line, the year would count that money twice. Nothing
// stops you doing it — but you'd want to be told.
function renderDoubleCheck() {
  const numbers = new Set(invoices.map((i) => String(i.number || '').trim().toUpperCase()));

  const clashes = entries.filter((e) =>
    e.ref && numbers.has(String(e.ref).trim().toUpperCase()));

  if (!clashes.length) {
    el('doublecheck').classList.add('hidden');
    return;
  }

  el('doublecheck').classList.remove('hidden');
  el('doublecheck').innerHTML =
    'Counted twice: ' + escapeText(clashes.map((e) => e.ref).join(', '))
    + ' ' + (clashes.length === 1 ? 'is' : 'are')
    + ' both an invoice in the app and a line brought in from your old sheet. '
    + 'Delete the imported line to fix it — tap it, then Delete this entry.';
}

function buildYearChips() {
  // Every tax year that has something in it, plus this one even when it
  // hasn't started filling up yet.
  const years = new Set(allMoneyRows().map((r) => taxYearOf(r.date)));
  years.add(currentTaxYear());

  if (moneyYear === null && !years.has(null)) {
    // first draw: land on the year we're in
    moneyYear = currentTaxYear();
  }

  const list = Array.from(years).sort((a, b) => b - a);

  el('yearchips').innerHTML = list.map((y) => `
    <button type="button" class="chip${y === moneyYear ? ' on' : ''}" data-year="${y}">${taxYearLabel(y)}</button>`).join('')
    + `<button type="button" class="chip${moneyYear === null ? ' on' : ''}" data-year="all">All years</button>`;
}

const MONEY_FILTERS = [
  ['all', 'Everything'], ['in', 'Money in'], ['out', 'Money out'], ['unsettled', 'Outstanding']
];

function buildMoneyChips() {
  el('mochips').innerHTML = MONEY_FILTERS.map(([value, text]) => `
    <button type="button" class="chip${value === moneyFilter ? ' on' : ''}"
            data-mo-filter="${escapeAttr(value)}">${escapeText(text)}</button>`).join('');

  el('basischips').innerHTML = [['all', 'As invoiced'], ['settled', 'Settled only']]
    .map(([value, text]) => `
    <button type="button" class="chip${value === moneyBasis ? ' on' : ''}"
            data-basis="${escapeAttr(value)}">${escapeText(text)}</button>`).join('');
}

el('yearchips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-year]');
  if (!chip) return;
  moneyYear = chip.dataset.year === 'all' ? null : Number(chip.dataset.year);
  renderMoney();
});

el('mochips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-mo-filter]');
  if (!chip || chip.dataset.moFilter === moneyFilter) return;
  moneyFilter = chip.dataset.moFilter;
  renderMoney();
});

el('basischips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-basis]');
  if (!chip || chip.dataset.basis === moneyBasis) return;
  moneyBasis = chip.dataset.basis;
  renderMoney();
});

// ---- costs the tracker can work out for itself ----

// A job that's been invoiced, that somebody else shot, has a fee owed to
// whoever shot it. That fee is already on the shoot, so there's no point
// making you type it again — this offers it, and you tap once to log it.
//
// It only ever suggests. Nothing is written until you press the button,
// because a suggestion that files itself is a guess you can't audit.
function suggestedCosts() {
  if (!myTag) return [];

  const invoiced = new Set();
  invoices.forEach((inv) => (inv.shoot_ids || []).forEach((id) => invoiced.add(String(id))));

  const logged = new Set(
    entries.filter((e) => e.shoot_id && e.category === 'crew fee')
           .map((e) => String(e.shoot_id))
  );

  return allShoots
    .filter((s) => invoiced.has(String(s.id)))
    .filter((s) => s.crew && s.crew !== myTag)
    .filter((s) => s.fee != null && Number(s.fee) > 0)
    .filter((s) => !logged.has(String(s.id)))
    .sort(byDateAscending)
    .reverse()
    .slice(0, 8);
}

function renderSuggested() {
  const rows = suggestedCosts();

  if (!rows.length) {
    el('suggestwrap').classList.add('hidden');
    return;
  }
  el('suggestwrap').classList.remove('hidden');

  el('suggest').innerHTML = rows.map((s) => {
    const who = (crewEntry(s.crew) || {}).name || s.crew;
    return `
      <div class="mini" style="border-left-color:${crewColour(s.crew)}">
        <div>
          <div class="mv">${escapeText(who)}&rsquo;s fee ${crewTag(s.crew)}</div>
          <div class="mm">${escapeText(s.venue)} &middot; ${longDate(s.shoot_date)} &middot; ${money(s.fee)}</div>
        </div>
        <button type="button" class="chip" data-log="${escapeAttr(s.id)}">Log it</button>
      </div>`;
  }).join('');
}

el('suggest').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-log]');
  if (!button) return;

  const shoot = allShoots.find((s) => String(s.id) === String(button.dataset.log));
  if (!shoot) return;

  const who = (crewEntry(shoot.crew) || {}).name || shoot.crew;
  button.textContent = '…';

  const problem = await saveEntry({
    entry_date:  shoot.shoot_date,
    direction:   'out',
    amount:      Number(shoot.fee),
    category:    'crew fee',
    description: who + ' fee — ' + shoot.venue + ', ' + dotDate(shoot.shoot_date),
    status:      'pending',
    shoot_id:    shoot.id
  });

  if (problem) {
    button.textContent = 'Log it';
    flash(problem);
    return;
  }
  flash(who + '\u2019s fee of ' + money(shoot.fee) + ' logged as still to pay.');
  refresh();
});

// ---- the list, laid out as the sheet ----
//
// Six columns in the order your spreadsheet has them, month headings
// between the blocks, and the same three summary lines at the bottom.
// On a narrow phone the table scrolls sideways rather than folding the
// columns up — a column that disappears at certain widths is worse than
// one you have to reach for.

// The word a line says. A line that's been given one of the words above
// says that word. Everything saved before this existed has no word of
// its own, so it carries on saying exactly what it said before.
function labelOf(row) {
  const label = LABELS.find((l) => l.value === row.label);
  if (!label) return null;

  // A word that disagrees with whether the money has actually moved is
  // out of date — the entry form was used to change the status after
  // the word was set. The figures win, and the line goes back to saying
  // the plain thing rather than something the sums don't agree with.
  if (label.settled !== row.settled) return null;

  return label;
}

function statusWord(row) {
  const label = labelOf(row);
  if (label) return label.word;
  if (row.settled) return 'Paid';
  return row.direction === 'in' ? 'Invoice pending' : 'To be paid';
}

// Outline and text colour for the pill. No word of its own means the
// old two-colour treatment, so nothing already on the sheet changes.
function statusColourOf(row) {
  const label = labelOf(row);
  if (label) return tokenValue(label.tone);
  return tokenValue(row.settled ? '--ink2' : '--stamp');
}

// What this line can be set to. An invoice can be a draft; a typed
// entry can't, so it isn't offered one.
function labelsFor(kind, direction) {
  return LABELS.filter((l) => {
    if (l.invoiceOnly && kind !== 'invoice') return false;
    return l.side === 'both' || l.side === direction;
  });
}

function renderMoneyList() {
  const rows = visibleMoneyRows();

  el('molabel').textContent = moneyYear == null ? 'All years' : taxYearLabel(moneyYear);
  el('mocount').textContent = rows.length + (rows.length === 1 ? ' entry' : ' entries');

  if (!rows.length) {
    el('molist').innerHTML = '<div class="empty">Nothing in there yet.</div>';
    return;
  }

  // Grouped by month, newest month first, in the sheet's own order.
  const months = [];
  const seen = {};
  rows.forEach((r) => {
    const key = String(r.date).slice(0, 7);
    if (!seen[key]) { seen[key] = []; months.push(key); }
    seen[key].push(r);
  });

  const body = months.map((key) => {
    const group = seen[key];
    const [y, m] = key.split('-').map(Number);
    const name = new Date(y, m - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const inSum  = group.filter((r) => r.direction === 'in').reduce((t, r) => t + r.amount, 0);
    const outSum = group.filter((r) => r.direction === 'out').reduce((t, r) => t + r.amount, 0);

    const head = `
      <tr class="mrow">
        <td>${escapeText(name.toUpperCase())}</td>
        <td class="num">${inSum ? money2(inSum) : ''}</td>
        <td class="num">${outSum ? money2(outSum) : ''}</td>
        <td colspan="3"></td>
      </tr>`;

    return head + group.map((r) => {
      const isIn = r.direction === 'in';
      return `
      <tr class="r ${r.kind}" data-kind="${r.kind}" data-id="${escapeAttr(r.id)}">
        <td class="dt">${dotDate(r.date)}</td>
        <td class="num in">${isIn ? money2(r.amount) : ''}</td>
        <td class="num out">${isIn ? '' : money2(r.amount)}</td>
        <td class="num">${r.miles == null ? '' : Math.round(r.miles)}</td>
        <td class="ds">${escapeText([r.ref, r.description].filter(Boolean).join(' — '))}</td>
        <td class="st"><button type="button" class="pill${r.settled ? ' paid' : ''}"
              data-st="1" data-kind="${r.kind}" data-id="${escapeAttr(r.id)}"
              data-label="${escapeAttr((labelOf(r) || {}).value || '')}" data-dir="${r.direction}"
              style="color:${statusColourOf(r)};border-color:${statusColourOf(r)}"
              aria-label="Status ${escapeAttr(statusWord(r))}. Tap to change it."
              >${escapeText(statusWord(r))}</button></td>
      </tr>`;
    }).join('');
  }).join('');

  const totalIn  = rows.filter((r) => r.direction === 'in').reduce((t, r) => t + r.amount, 0);
  const totalOut = rows.filter((r) => r.direction === 'out').reduce((t, r) => t + r.amount, 0);
  const miles    = rows.reduce((t, r) => t + Number(r.miles || 0), 0);

  const foot = `
    <tr class="tot">
      <td></td>
      <td class="num">${money2(totalIn)}</td>
      <td class="num">${money2(totalOut)}</td>
      <td class="num">${Math.round(miles)}</td>
      <td colspan="2"></td>
    </tr>
    <tr class="sums"><td colspan="4"></td><td>TOTAL MILEAGE COST</td><td class="num">${money2(miles * MILEAGE_RATE)}</td></tr>
    <tr class="sums"><td colspan="4"></td><td>TOTAL EXPENSES</td><td class="num">${money2(totalOut)}</td></tr>
    <tr class="sums big"><td colspan="4"></td><td>PROFIT</td><td class="num">${money2(totalIn - totalOut)}</td></tr>`;

  el('molist').innerHTML = `
    <div class="sheetwrap">
      <table class="sheet">
        <thead>
          <tr>
            <th>Date</th>
            <th class="num">Income</th>
            <th class="num">Expenditure</th>
            <th class="num">Mileage</th>
            <th>Description</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>${foot}</tfoot>
      </table>
    </div>`;
}

// ---- changing a status from the sheet itself ----
//
// Tapping a pill opens a row of the words that line could say, tucked
// under the line itself. It's a row of the table rather than something
// floating over it, so there's no positioning to go wrong in a table
// that already scrolls sideways — and no native dropdown fighting with
// ours, which is what the two-menus problem was.
//
// Nothing new is stored twice: an entry's word writes to that entry,
// an invoice's word writes to that invoice — the same field the
// Invoices screen writes to. So the sheet and the invoice can't drift.
function closeStatusPicker() {
  const open = document.querySelector('tr.stedit');
  if (open) open.remove();
}

function openStatusPicker(pill) {
  const line = pill.closest('tr');
  const open = document.querySelector('tr.stedit');
  const wasMine = open && open.previousElementSibling === line;

  closeStatusPicker();
  if (wasMine) return;               // tapping the same pill again shuts it

  const now = pill.dataset.label || '';

  const chips = labelsFor(pill.dataset.kind, pill.dataset.dir).map((l) => {
    const tone = tokenValue(l.tone);
    const style = l.value === now
      ? `background:${tone};border-color:${tone};color:${readableOn(l.tone)}`
      : `color:${tone};border-color:${tone}`;

    return `
        <button type="button" class="chip stchip${l.value === now ? ' on' : ''}"
                data-lab="${l.value}" style="${style}"
                >${escapeText(l.word)}</button>`;
  }).join('');

  const editor = document.createElement('tr');
  editor.className = 'stedit';
  editor.dataset.kind = pill.dataset.kind;
  editor.dataset.id = pill.dataset.id;
  editor.innerHTML = `
      <td colspan="6">
        <div class="label">Set this line to</div>
        <div class="chips">${chips}</div>
        <div class="error hidden"></div>
      </td>`;

  line.after(editor);
}

// Returns null if it went through, or the reason it didn't.
async function applyStatus(kind, id, value) {
  const label = LABELS.find((l) => l.value === value);
  if (!label) return 'That word isn\'t in the list any more.';

  if (kind === 'entry') {
    // The word, and the plain settled-or-not the figures run on. Both,
    // together, so the sums can never disagree with what's on screen.
    const problem = await patchEntry(id, {
      status: label.settled ? 'settled' : 'pending',
      status_label: value
    });
    if (problem) return problem;

    flash('Now says ' + label.word.toLowerCase() + '.');
    refresh();
    return null;
  }

  const inv = findInvoice(id);
  if (!inv) return 'That invoice isn\'t there any more. Pull the screen down to reload.';

  // An invoice's own status is still draft, sent or paid — that's what
  // the Invoices screen and the PDF run on. The word chosen here sits
  // alongside it and decides which of the three it means.
  const status = value === 'draft' ? 'draft' : label.settled ? 'paid' : 'sent';

  const patch = { status: status, status_label: value };
  if (status === 'sent' && !inv.sent_on) patch.sent_on = todayISO();
  if (status === 'paid') patch.paid_on = todayISO();
  if (status !== 'paid' && inv.paid_on) patch.paid_on = null;

  const problem = await patchInvoice(id, patch);
  if (problem) return problem;

  // Marking an invoice paid marks the jobs on it paid too, so the
  // schedule and the sheet can't tell you different things.
  let alsoDone = 0;
  if (status === 'paid') alsoDone = await markShootsPaid(inv);

  flash(inv.number + ' now says ' + label.word.toLowerCase() + '.'
    + (alsoDone ? ` ${alsoDone} ${alsoDone === 1 ? 'shoot' : 'shoots'} marked paid as well.` : ''));
  refresh();
  return null;
}

// The word needs a column to live in. If that column hasn't been added
// to the database yet the write comes back complaining about it, so the
// status still goes through and you get told what's missing rather than
// silently losing the wording.
function missingColumn(message) {
  return /status_label/i.test(String(message || ''));
}

async function patchEntry(id, patch) {
  const problem = await changeEntry(id, patch);
  if (!problem || !missingColumn(problem)) return problem;

  const { status_label, ...rest } = patch;
  const second = await changeEntry(id, rest);
  return second || 'Saved as ' + (rest.status === 'settled' ? 'paid' : 'not paid')
    + ', but the wording needs the status_label column adding first — see status-labels.sql.';
}

async function patchInvoice(id, patch) {
  const problem = await changeInvoice(id, patch);
  if (!problem || !missingColumn(problem)) return problem;

  const { status_label, ...rest } = patch;
  const second = await changeInvoice(id, rest);
  return second || 'Status saved, but the wording needs the status_label column adding first — see status-labels.sql.';
}

// Tapping a line opens it. An invoice line's figures can't be edited here
// — the invoice is the original and this is a view of it — so it says so
// rather than opening a form that would write to the wrong place. The
// status is the exception, and that's the pill, handled above.
el('molist').addEventListener('click', async (event) => {
  const pill = event.target.closest('button[data-st]');
  if (pill) {
    openStatusPicker(pill);
    return;
  }

  const chip = event.target.closest('button.stchip');
  if (chip) {
    if (chip.classList.contains('on')) { closeStatusPicker(); return; }

    const editor = chip.closest('tr.stedit');
    const problem = await applyStatus(editor.dataset.kind, editor.dataset.id, chip.dataset.lab);

    // A win redraws the whole sheet. A refusal leaves the old word where
    // it was and says why, on the line it happened to.
    if (problem) {
      const box = editor.querySelector('.error');
      box.textContent = problem;
      box.classList.remove('hidden');
    }
    return;
  }

  const line = event.target.closest('tr[data-id]');
  if (!line) return;

  if (line.dataset.kind === 'invoice') {
    const inv = findInvoice(line.dataset.id);
    flash((inv ? inv.number : 'That line') + ' comes from an invoice. '
      + 'Tap its status to change that here — for the figures or the lines, '
      + 'edit it on the Invoices screen and this line follows.');
    return;
  }

  const entry = entries.find((e) => String(e.id) === String(line.dataset.id));
  if (entry) startEditEntry(entry);
});

async function changeEntry(id, patch) {
  const { data, error } = await supabase
    .from('entries').update(patch).eq('id', id).select('id');

  if (error) return error.message;
  if (!data || !data.length) {
    return 'Nothing changed — the database refused it. That usually means this account isn\'t set up for the money side.';
  }
  return null;
}

async function saveEntry(row) {
  if (teamId) row.team_id = teamId;
  const { data, error } = await supabase.from('entries').insert(row).select('id');
  if (error) return error.message;
  if (!data || !data.length) return 'The database refused that.';
  return null;
}

// ---- adding and editing an entry ----

function fillCategorySelect() {
  const list = el('f_e_dir').value === 'in' ? IN_CATEGORIES : OUT_CATEGORIES;
  fillSelect('f_e_cat', list);
}

function openEntryForm(direction) {
  editingEntry = null;
  closeAllMenus();
  hide('entryerror');
  hide('flash');

  el('newentry').reset();
  el('f_e_dir').value = direction || 'out';
  fillCategorySelect();
  el('f_e_date').value = todayISO();
  el('f_e_status').value = 'settled';
  el('f_e_miles').value = '';

  el('entrytitle').textContent = direction === 'in' ? 'Add money in' : 'Add money out';
  el('saveentry').textContent = 'Save entry';
  hide('deleteentry');
  show('newentry');
  el('f_e_amount').focus();
}

function startEditEntry(entry) {
  editingEntry = entry;
  closeAllMenus();
  hide('entryerror');
  hide('flash');

  el('newentry').reset();
  el('f_e_dir').value = entry.direction;
  fillCategorySelect();

  el('f_e_date').value   = entry.entry_date;
  el('f_e_amount').value = entry.amount;
  el('f_e_desc').value   = entry.description || '';
  el('f_e_ref').value    = entry.ref || '';
  el('f_e_miles').value  = entry.miles == null ? '' : entry.miles;
  el('f_e_status').value = entry.status;
  setSelect('f_e_cat', entry.category);

  el('entrytitle').textContent = 'Edit entry';
  el('saveentry').textContent = 'Save changes';
  el('deleteentry').textContent = 'Delete this entry';
  el('deleteentry').dataset.armed = '';
  el('deleteentry').classList.remove('armed');
  show('deleteentry');
  show('newentry');
  el('newentry').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

el('deleteentry').addEventListener('click', async () => {
  if (!editingEntry) return;
  const button = el('deleteentry');

  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.classList.add('armed');
    button.textContent = 'Tap again to delete';
    setTimeout(() => {
      button.dataset.armed = '';
      button.classList.remove('armed');
      button.textContent = 'Delete this entry';
    }, 5000);
    return;
  }

  button.textContent = 'Deleting…';
  const { data, error } = await supabase
    .from('entries').delete().eq('id', editingEntry.id).select('id');

  if (error || !data || !data.length) {
    button.dataset.armed = '';
    button.classList.remove('armed');
    button.textContent = 'Delete this entry';
    el('entryerror').textContent = error ? error.message : 'The database refused that.';
    show('entryerror');
    return;
  }

  closeEntryForm();
  flash('That entry has gone.');
  refresh();
});

function closeEntryForm() {
  editingEntry = null;
  hide('newentry');
}

el('addin').addEventListener('click', () => openEntryForm('in'));
el('addout').addEventListener('click', () => openEntryForm('out'));
el('cancelentry').addEventListener('click', closeEntryForm);
el('f_e_dir').addEventListener('change', fillCategorySelect);

// Typing miles with the amount left empty prices them for you. Type an
// amount yourself and it's left alone — a toll isn't 45p a mile.
el('f_e_miles').addEventListener('input', () => {
  const miles = Number(el('f_e_miles').value || 0);
  if (miles > 0 && el('f_e_amount').value.trim() === '') {
    el('f_e_amount').value = (miles * MILEAGE_RATE).toFixed(2);
  }
});

el('newentry').addEventListener('submit', async (event) => {
  event.preventDefault();
  hide('entryerror');

  const date   = el('f_e_date').value;
  const amount = el('f_e_amount').value.trim();
  const desc   = el('f_e_desc').value.trim();

  if (!date || amount === '' || !desc) {
    el('entryerror').textContent = 'A date, an amount and a description are needed before this can be saved.';
    show('entryerror');
    return;
  }

  const miles = el('f_e_miles').value.trim();

  const row = {
    entry_date:  date,
    direction:   el('f_e_dir').value,
    amount:      Number(amount),
    category:    el('f_e_cat').value,
    description: desc,
    ref:         el('f_e_ref').value.trim() || null,
    miles:       miles === '' ? null : Number(miles),
    status:      el('f_e_status').value
  };

  el('saveentry').disabled = true;
  el('saveentry').textContent = 'Saving…';

  const problem = editingEntry
    ? await changeEntry(editingEntry.id, row)
    : await saveEntry(row);

  el('saveentry').disabled = false;
  el('saveentry').textContent = editingEntry ? 'Save changes' : 'Save entry';

  if (problem) {
    el('entryerror').textContent = problem;
    show('entryerror');
    return;
  }

  const wasEdit = !!editingEntry;
  closeEntryForm();
  flash(wasEdit ? 'Entry updated.' : 'Entry added to the tracker.');
  refresh();
});

// ---- out to a spreadsheet ----
//
// Same six columns as the sheet you've been keeping, so it opens looking
// like the thing you're used to and your accountant doesn't have to be
// told anything new.

function csvCell(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

el('downloadcsv').addEventListener('click', () => {
  const rows = visibleMoneyRows();
  if (!rows.length) { flash('Nothing to export in that view.'); return; }

  const head = ['DATE', 'INCOME', 'EXPENDITURE', 'MILEAGE', 'DESCRIPTION', 'STATUS'];

  const body = rows.map((r) => [
    dotDate(r.date),
    r.direction === 'in'  ? r.amount.toFixed(2) : '',
    r.direction === 'out' ? r.amount.toFixed(2) : '',
    r.miles == null ? '' : Math.round(r.miles),
    [r.ref, r.description].filter(Boolean).join(' - '),
    r.settled ? 'Paid' : (r.direction === 'in' ? 'Invoice pending' : 'To be paid')
  ]);

  const totalIn  = rows.filter((r) => r.direction === 'in').reduce((t, r) => t + r.amount, 0);
  const totalOut = rows.filter((r) => r.direction === 'out').reduce((t, r) => t + r.amount, 0);
  const miles    = rows.reduce((t, r) => t + Number(r.miles || 0), 0);

  body.push([]);
  body.push(['', totalIn.toFixed(2), totalOut.toFixed(2), Math.round(miles), 'TOTALS', '']);
  body.push(['', '', (miles * MILEAGE_RATE).toFixed(2), '', 'TOTAL MILEAGE COST', '']);
  body.push(['', '', (totalIn - totalOut).toFixed(2), '', 'PROFIT', '']);

  // The BOM is what stops Excel mangling the pound signs.
  const csv = '\ufeff' + [head].concat(body)
    .map((cols) => cols.map(csvCell).join(',')).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = safeFilename('BGL Media I&E '
    + (moneyYear == null ? 'all years' : taxYearLabel(moneyYear))) + '.csv';
  link.click();

  URL.revokeObjectURL(url);
});

// ============================================================
// The PDF
//
// A redraw of your template, measured off the spreadsheet itself: same
// grid, same greys, same Montserrat, same eleven ruled line rows.
//
// Nothing in here reads styles.css. The invoice is its own thing now, so
// recolouring the app leaves it alone — which is the way round it should
// have been from the start.
// ============================================================

// Points to millimetres. Every row height in the template is in points.
const PT = 25.4 / 72;

// The template's colours, straight out of the spreadsheet's cells.
const T = {
  band:  '#666666',   // the bar top and bottom, and the table header
  panel: '#F3F3F3',   // behind the logo, and every other line row
  navy:  '#1F3864',   // INVOICE TO / FROM, the date and the number
  slate: '#333F4F',   // payment terms, SUBTOTAL, Balance Due
  grey:  '#434343',   // Payment Details and the bank lines
  word:  '#7F7F7F',   // the word INVOICE
  cell:  '#999999',   // the box around the table
  thin:  '#BFBFBF',   // the underlines
  due:   '#B7B7B7',   // the block behind the balance
  black: '#000000',
  white: '#FFFFFF'
};

// The column grid, in millimetres across an A4 page. These come from
// measuring the template's own column widths, then centring the result.
const S = {
  sheetL: 11.65, sheetR: 198.35,
  tableL: 18.52,     // where the ruled box starts
  colC:   38.96,     // Payment Details sits here
  descR: 102.84,     // description | qty
  qtyR:  129.51,     // qty | unit price
  unitR: 162.53,     // unit price | total
  tableR: 191.74,    // where the ruled box ends
  fromX: 102.84,     // the INVOICE FROM block
  pad: 1.6           // how far text sits off a rule
};

// How deep the pale block behind the logo is, in millimetres. This is the
// one measurement not taken off the template — shortening it is what stops
// the logo floating with more air below it than above.
const PANEL = 40;

// Where every row starts. The template is eleven line rows deep whether
// you use them or not — that's part of how it looks — so a short invoice
// still gets the full ruled box.
function layout(lineCount) {
  const rows = Math.max(11, lineCount);
  const R18 = 18 * PT;

  // Everything except the line rows and the panel, in points.
  const fixed = (14.25 + 18 + 18 + 15.75 + 4.5 + 6 * 18 + 4.5 + 18
                 + 22.5 + 33.75 + 9.75 + 9.75 + 15.75 + 15.75
                 + 21 + 15.75) * PT;

  const height = fixed + PANEL + rows * R18;
  let y = Math.max(10, (297 - height) / 2);

  const at = { rowH: R18, rows: rows };

  at.band1 = y;                 y += 14.25 * PT;
  at.panel = y;                 y += PANEL;
  at.panelEnd = y;
  at.middle = (at.panel + at.panelEnd) / 2;
  at.r10 = y;                   y += R18;
  at.r11 = y;                   y += R18;   // payment terms
  at.r12 = y;                   y += 15.75 * PT;
  at.r12End = y;                y += 4.5 * PT;
  at.details = y;               y += 6 * R18;
                                y += 4.5 * PT;
  at.head = y;                  y += R18;
  at.headEnd = y;
  at.body = y;                  y += rows * R18;
  at.bodyEnd = y;
  at.r33 = y;                   y += 22.5 * PT;
  at.r33End = y;
  at.r34 = y;                   y += 33.75 * PT;
  at.r34End = y;
                                y += (9.75 + 9.75 + 15.75 + 15.75 + 21 + 15.75) * PT;
  at.band2 = y;                 y += 15.75 * PT;
  at.end = y;

  return at;
}

// The template prints unit prices bare and totals with the sign, so
// they're two different formats and not an oversight.
function bare(value) {
  return Number(value || 0).toFixed(2);
}

// Fetched the first time you ask for a PDF, not on load, so the app opens
// as fast as it always did. jsPDF is pinned to a version on purpose:
// version 2 mangles the pound sign, which on a British invoice matters.
let pdfKit = null;
function loadPdfKit() {
  if (!pdfKit) {
    pdfKit = Promise.all([
      import('https://cdn.jsdelivr.net/npm/jspdf@3.0.1/+esm'),
      import('./fonts.js')
    ]).then(([lib, fonts]) => ({
      JsPDF: lib.jsPDF || (lib.default && lib.default.jsPDF) || lib.default,
      fonts: fonts
    }));
  }
  return pdfKit;
}

// logo.png sits next to index.html. If it isn't there the invoice still
// draws, with the company name set in type where the mark would go.
let logoData = null;
function loadLogo() {
  if (!logoData) {
    logoData = fetch('logo.png')
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('missing'))))
      .then((blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }))
      .catch(() => null);
  }
  return logoData;
}

function safeFilename(text) {
  return String(text).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}

async function downloadInvoice(inv) {
  const doc = await drawInvoice(inv);
  const name = [inv.number, inv.client].filter(Boolean).join(' - ');
  doc.save(safeFilename(name) + '.pdf');
}

async function drawInvoice(inv) {
  const kit = await loadPdfKit();
  const logo = await loadLogo();

  const doc = new kit.JsPDF({ unit: 'mm', format: 'a4', compress: true });

  doc.addFileToVFS('Montserrat-Regular.ttf', kit.fonts.MONTSERRAT_REGULAR);
  doc.addFont('Montserrat-Regular.ttf', 'Montserrat', 'normal');
  doc.addFileToVFS('Montserrat-Bold.ttf', kit.fonts.MONTSERRAT_BOLD);
  doc.addFont('Montserrat-Bold.ttf', 'Montserrat', 'bold');

  const lines = inv.lines || [];
  const at = layout(lines.length);

  // ---- the small helpers ----

  // Excel sits text on the floor of its cell. This works out where that
  // floor is for a given size, so nothing has to be nudged by hand.
  const foot = (bottom, size) => bottom - size * PT * 0.28 - 0.75;

  const type = (size, weight, colour) => {
    doc.setFont('Montserrat', weight || 'normal');
    doc.setFontSize(size);
    doc.setTextColor(colour || T.black);
  };

  const fill = (x, y, w, h, colour) => {
    doc.setFillColor(colour);
    doc.rect(x, y, w, h, 'F');
  };

  const rule = (x1, y, x2, colour, weight) => {
    doc.setDrawColor(colour || T.thin);
    doc.setLineWidth(weight || 0.2);
    doc.line(x1, y, x2, y);
  };

  const vrule = (x, y1, y2, colour) => {
    doc.setDrawColor(colour || T.cell);
    doc.setLineWidth(0.2);
    doc.line(x, y1, x, y2);
  };

  // ---- the bar across the top ----
  fill(S.sheetL, at.band1, S.sheetR - S.sheetL, at.panel - at.band1, T.band);

  // ---- the pale block the logo sits on ----
  fill(S.sheetL, at.panel, S.sheetR - S.sheetL, at.panelEnd - at.panel, T.panel);

  // The mark, at its own proportions, centred on the block.
  // logo.png is cropped to the artwork, so there's no padding to allow for.
  if (logo) {
    const w = 58;
    const h = w / 7.03;
    doc.addImage(logo, 'PNG', 25.76, at.middle - h / 2, w, h);
  } else {
    type(18, 'bold', T.black);
    doc.text(ME.company.toUpperCase(), 25.76, at.middle + 2);
  }

  // ---- INVOICE, the date and the number ----
  // The three of them are placed as one group against the middle of the
  // block, so the air above and below comes out the same.
  type(18, 'normal', T.word);
  doc.text(' INVOICE', S.unitR, at.middle - 7.5);

  type(10, 'bold', T.navy);
  const midG = (S.unitR + S.tableR) / 2;

  doc.text(dotDate(inv.issued_on), midG, foot(at.middle + 2, 10), { align: 'center' });
  rule(S.unitR, at.middle + 2, S.tableR, T.thin);

  doc.text(inv.number, midG, foot(at.middle + 11.5, 10), { align: 'center' });
  rule(S.unitR, at.middle + 11.5, S.tableR, T.thin);

  // ---- payment terms ----
  type(9, 'normal', T.slate);
  doc.text(
    `Payment terms - Due within ${inv.terms_days == null ? 7 : inv.terms_days} days of receipt`,
    S.tableR, foot(at.r12, 9), { align: 'right' }
  );

  // ---- the two address blocks ----
  type(9, 'bold', T.navy);
  doc.text('INVOICE TO', S.tableL, foot(at.r12End, 9));
  doc.text('INVOICE FROM', S.fromX, foot(at.r12End, 9));
  rule(S.tableL, at.r12End, 90.76, T.thin);
  rule(S.fromX, at.r12End, S.tableR, T.thin);

  const block = (rows, x, limit) => {
    type(10, 'normal', T.black);
    let y = at.details + at.rowH;
    rows.filter(Boolean).forEach((text) => {
      doc.splitTextToSize(String(text), limit - x).forEach((piece) => {
        doc.text(piece, x, foot(y, 10));
        y += at.rowH;
      });
    });
  };

  block([inv.bill_contact, inv.bill_company, inv.bill_address, inv.bill_phone, inv.bill_email],
        S.tableL, 90.76);
  block([ME.company, ME.name, ME.address, ME.phone, ME.email],
        S.fromX, S.tableR);

  // ---- the table header ----
  fill(S.tableL, at.head, S.tableR - S.tableL, at.headEnd - at.head, T.band);

  type(9, 'bold', T.white);
  const headY = foot(at.headEnd, 9);
  doc.text('DESCRIPTION', (S.tableL + S.descR) / 2, headY, { align: 'center' });
  doc.text('QTY',         (S.descR + S.qtyR) / 2,  headY, { align: 'center' });
  doc.text('UNIT PRICE',  (S.qtyR + S.unitR) / 2,  headY, { align: 'center' });
  doc.text('TOTAL',       (S.unitR + S.tableR) / 2, headY, { align: 'center' });

  // ---- the ruled line rows ----
  // Every other row is shaded, and the shading runs whether or not there's
  // anything on it. That banding is most of what makes the template look
  // like the template.
  for (let i = 0; i < at.rows; i++) {
    const top = at.body + i * at.rowH;
    if (i % 2 === 1) {
      fill(S.tableL, top, S.tableR - S.tableL, at.rowH, T.panel);
    }

    const line = lines[i];
    if (!line) continue;

    type(9, 'normal', T.black);
    const base = foot(top + at.rowH, 9);
    const text = doc.splitTextToSize(String(line.d || ''), S.descR - S.tableL - 2 * S.pad)[0] || '';

    doc.text(text, S.tableL + S.pad, base);
    doc.text(String(line.q == null ? 1 : line.q), (S.descR + S.qtyR) / 2, base, { align: 'center' });
    doc.text(bare(line.u), S.unitR - S.pad, base, { align: 'right' });
    doc.text(money2(Number(line.q || 0) * Number(line.u || 0)), S.tableR - S.pad, base, { align: 'right' });
  }

  // The box: four uprights, a lid and a floor.
  [S.tableL, S.descR, S.qtyR, S.unitR, S.tableR].forEach((x) => {
    vrule(x, at.body, at.bodyEnd, T.cell);
  });
  rule(S.tableL, at.body, S.tableR, T.cell);
  rule(S.tableL, at.bodyEnd, S.tableR, T.cell);

  // ---- payment details, and the totals ----
  type(12, 'bold', T.grey);
  doc.text('Payment Details', S.colC, foot(at.r33End, 12));

  type(8, 'bold', T.slate);
  doc.text('SUBTOTAL', S.unitR, foot(at.r33End, 8), { align: 'right' });

  type(9, 'normal', T.black);
  doc.text(money2(inv.total), S.tableR - S.pad, foot(at.r33End, 9), { align: 'right' });
  rule(S.unitR, at.r33End, S.tableR, T.thin);

  // The bank lines, three of them, sitting under the heading.
  type(9, 'normal', T.grey);
  ME.bank.forEach((text, i) => {
    doc.text(text, S.colC, at.r34 + 3.6 + i * 3.6);
  });

  // Balance due: pale block, black line above and below, the only heavy
  // number on the page.
  fill(S.unitR, at.r34, S.tableR - S.unitR, at.r34End - at.r34, T.due);
  rule(S.qtyR, at.r34, S.tableR, T.black, 0.3);
  rule(S.unitR, at.r34End, S.tableR, T.black, 0.3);

  type(12, 'bold', T.slate);
  doc.text('Balance Due', S.unitR - S.pad, foot(at.r34End, 12), { align: 'right' });

  type(14, 'bold', T.black);
  doc.text(money2(inv.total), S.tableR - S.pad, foot(at.r34End, 14), { align: 'right' });

  // ---- the bar across the bottom ----
  fill(S.sheetL, at.band2, S.sheetR - S.sheetL, at.end - at.band2, T.band);

  return doc;
}

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
    closeMoreMenu();
    show('login');
    return;
  }

  hide('login');
  show('app');
  show('tabs');
  el('who').textContent = session.user.email;
  myTag = DEFAULT_TAG_BY_EMAIL[session.user.email.trim().toLowerCase()] || '';

  if (started) return;
  started = true;

  await loadProfile(session.user.id);
  goto('home');
  refresh();
}



supabase.auth.onAuthStateChange((_event, session) => render(session));

const { data } = await supabase.auth.getSession();
render(data.session);
