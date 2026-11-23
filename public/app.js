'use strict';

const COLORS = ['#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#e74c3c', '#f39c12', '#1abc9c', '#607d8b'];
const MAX_CHIPS = 3;

const state = {
  token: localStorage.getItem('token'),
  user: null,
  calendars: [],
  calId: Number(localStorage.getItem('calId')) || null,
  month: startOfMonth(new Date()),
  events: [],
  stream: null,
  openEventId: null,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
const pad = (n) => String(n).padStart(2, '0');
const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDate = (d) => `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;

function fmtRelative(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
}

function fmtRange(ev) {
  const s = new Date(ev.start_at);
  const e = new Date(ev.end_at);
  if (ev.all_day) {
    return sameDay(s, e) ? `${fmtDate(s)} 終日` : `${fmtDate(s)} 〜 ${fmtDate(e)} 終日`;
  }
  return sameDay(s, e)
    ? `${fmtDate(s)} ${fmtTime(s)} 〜 ${fmtTime(e)}`
    : `${fmtDate(s)} ${fmtTime(s)} 〜 ${fmtDate(e)} ${fmtTime(e)}`;
}

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.token && !path.startsWith('/auth')) {
    logoutLocal();
    throw new Error('ログインし直してください');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

const currentCal = () => state.calendars.find((c) => c.id === state.calId);
const eventColor = (ev) => ev.color || currentCal()?.color || COLORS[0];

// ---------- auth ----------
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  const nameLabel = $('.register-only');
  nameLabel.hidden = mode !== 'register';
  nameLabel.querySelector('input').required = mode === 'register';
  $('#auth-submit').textContent = mode === 'register' ? '登録してはじめる' : 'ログイン';
  $('#auth-form [name=password]').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { email: f.get('email'), password: f.get('password') };
  if (authMode === 'register') body.name = f.get('name');
  try {
    const data = await api(`/auth/${authMode}`, { method: 'POST', body });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    e.target.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

function logoutLocal() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  state.stream?.close();
  state.stream = null;
  $('#app-screen').hidden = true;
  $('#auth-screen').hidden = false;
}

$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  logoutLocal();
});

// ---------- boot ----------
async function boot() {
  if (!state.token) {
    $('#auth-screen').hidden = false;
    $('#app-screen').hidden = true;
    return;
  }
  try {
    state.user = (await api('/me')).user;
  } catch {
    logoutLocal();
    return;
  }
  $('#auth-screen').hidden = true;
  $('#app-screen').hidden = false;
  $('#me-name').textContent = state.user.name;
  await loadCalendars();
  connectStream();

  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    history.replaceState(null, '', location.pathname);
    showInvite(invite);
  }
}

async function loadCalendars() {
  state.calendars = (await api('/calendars')).calendars;
  if (!currentCal()) state.calId = state.calendars[0]?.id ?? null;
  renderCalendarList();
  await selectCalendar(state.calId);
}

async function selectCalendar(id) {
  state.calId = id;
  if (id) localStorage.setItem('calId', id);
  renderCalendarList();
  const cal = currentCal();
  $('#topbar').style.background = cal?.color || '';
  await Promise.all([loadEvents(), loadActivities()]);
}

function visibleRange() {
  const first = state.month;
  const start = addDays(first, -first.getDay());
  return { start, end: addDays(start, 42) };
}

async function loadEvents() {
  if (!state.calId) { state.events = []; renderGrid(); return; }
  const { start, end } = visibleRange();
  const q = `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
  state.events = (await api(`/calendars/${state.calId}/events?${q}`)).events;
  renderGrid();
}

async function loadActivities() {
  if (!state.calId) return;
  const { activities } = await api(`/calendars/${state.calId}/activities`);
  renderActivities(activities);
}

// ---------- realtime ----------
function connectStream() {
  state.stream?.close();
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.stream = es;

  es.addEventListener('event.upsert', (m) => {
    const { calendarId, event } = JSON.parse(m.data);
    if (calendarId !== state.calId) return;
    const i = state.events.findIndex((e) => e.id === event.id);
    if (i >= 0) state.events[i] = event; else state.events.push(event);
    renderGrid();
    // Refresh an open detail view, unless the user is editing or typing a comment.
    const typing = $('#modal .comment-form input')?.value;
    if (state.openEventId === event.id && !$('#modal form.event-form') && !typing) openEvent(event.id);
  });

  es.addEventListener('event.delete', (m) => {
    const { calendarId, eventId } = JSON.parse(m.data);
    if (calendarId !== state.calId) return;
    state.events = state.events.filter((e) => e.id !== eventId);
    renderGrid();
    if (state.openEventId === eventId) closeModal();
  });

  es.addEventListener('comment', (m) => {
    const { eventId, comment } = JSON.parse(m.data);
    const list = $('#modal .comments');
    if (state.openEventId === eventId && list && !list.querySelector(`[data-id="${comment.id}"]`)) {
      list.append(commentItem(comment));
      list.scrollTop = list.scrollHeight;
    }
  });

  es.addEventListener('calendar', (m) => {
    const { calendar } = JSON.parse(m.data);
    const i = state.calendars.findIndex((c) => c.id === calendar.id);
    if (i >= 0) {
      // role is viewer-specific; keep ours
      state.calendars[i] = { ...calendar, role: state.calendars[i].role, invite_code: state.calendars[i].invite_code };
      renderCalendarList();
      if (calendar.id === state.calId) $('#topbar').style.background = calendar.color;
    }
  });

  es.addEventListener('activity', (m) => {
    const { calendarId, activity } = JSON.parse(m.data);
    if (activity.user_id !== state.user.id) {
      const cal = state.calendars.find((c) => c.id === calendarId);
      toast(`${cal ? `[${cal.name}] ` : ''}${activity.user_name}: ${activity.summary}`);
    }
    if (calendarId === state.calId) loadActivities();
  });
}

// ---------- rendering ----------
function renderCalendarList() {
  const list = $('#calendar-list');
  list.replaceChildren(
    ...state.calendars.map((c) =>
      h('li', {
        class: c.id === state.calId ? 'active' : '',
        onclick: () => { selectCalendar(c.id); $('#sidebar').classList.remove('open'); },
      },
      h('span', { class: 'dot', style: `background:${c.color}` }),
      c.name,
      h('span', { class: 'count' }, `${c.members.length}人`))
    )
  );
}

function renderActivities(activities) {
  $('#activity-list').replaceChildren(
    ...(activities.length
      ? activities.slice(0, 20).map((a) => {
          const exists = a.event_id && state.events.some((e) => e.id === a.event_id);
          return h('li', {
            class: exists ? 'clickable' : '',
            onclick: exists ? () => openEvent(a.event_id) : null,
          },
          h('span', { class: 'who' }, a.user_name), ' ', a.summary,
          h('time', {}, fmtRelative(a.created_at)));
        })
      : [h('li', { class: 'more' }, 'まだ更新はありません')])
  );
}

function eventsOnDay(day) {
  const s = startOfDay(day);
  const e = addDays(s, 1);
  return state.events
    .filter((ev) => new Date(ev.start_at) < e && new Date(ev.end_at) >= s)
    .sort((a, b) => b.all_day - a.all_day || a.start_at.localeCompare(b.start_at));
}

function renderGrid() {
  const cal = currentCal();
  $('#month-label').textContent = `${state.month.getFullYear()}年${state.month.getMonth() + 1}月`;
  const { start } = visibleRange();
  const today = new Date();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    const evs = cal ? eventsOnDay(day) : [];
    const cls = ['day'];
    if (day.getMonth() !== state.month.getMonth()) cls.push('other');
    if (sameDay(day, today)) cls.push('today');
    const numCls = day.getDay() === 0 ? 'num sun' : day.getDay() === 6 ? 'num sat' : 'num';
    cells.push(
      h('div', { class: cls.join(' '), onclick: () => openDay(day) },
        h('span', { class: numCls }, day.getDate()),
        ...evs.slice(0, MAX_CHIPS).map((ev) => {
          const color = eventColor(ev);
          const multi = ev.all_day || !sameDay(new Date(ev.start_at), new Date(ev.end_at));
          return h('div', {
            class: multi ? 'chip' : 'chip timed',
            style: multi ? `background:${color}` : `--c:${color}`,
            title: `${ev.title}\n${fmtRange(ev)}`,
            onclick: (e) => { e.stopPropagation(); openEvent(ev.id); },
          }, ev.title);
        }),
        evs.length > MAX_CHIPS ? h('span', { class: 'more' }, `他${evs.length - MAX_CHIPS}件`) : null)
    );
  }
  $('#grid').replaceChildren(...cells);
}

// ---------- modal ----------
const modal = $('#modal');
function openModal(...content) {
  $('#modal-body').replaceChildren(...content.filter((c) => c !== null && c !== undefined));
  if (!modal.open) modal.showModal();
}
function closeModal() {
  state.openEventId = null;
  if (modal.open) modal.close();
}
modal.addEventListener('close', () => { state.openEventId = null; });
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

const modalHead = (title) =>
  h('div', { class: 'modal-head' }, h('h3', {}, title),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': '閉じる', onclick: closeModal }, '×'));

function openDay(day) {
  if (!currentCal()) return;
  const evs = eventsOnDay(day);
  if (!evs.length) return openEventForm(null, day);
  openModal(
    modalHead(fmtDate(day)),
    h('ul', { class: 'day-list' },
      evs.map((ev) => h('li', { style: `--c:${eventColor(ev)}`, onclick: () => openEvent(ev.id) },
        h('div', {}, ev.title),
        h('div', { class: 't' }, ev.all_day ? '終日' : fmtRange(ev))))),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => openEventForm(null, day) }, '＋ 予定を追加'))
  );
}

function colorPicker(selected, onPick) {
  const wrap = h('div', { class: 'swatches' });
  const opts = [null, ...COLORS];
  const render = () => wrap.replaceChildren(...opts.map((c) => h('button', {
    type: 'button',
    class: `swatch${c === selected ? ' selected' : ''}`,
    style: `background:${c || currentCal()?.color}`,
    title: c ? c : 'カレンダーの色',
    onclick: () => { selected = c; onPick(c); render(); },
  })));
  render();
  return wrap;
}

function openEventForm(ev, day = new Date()) {
  const isNew = !ev;
  let start, end;
  if (ev) {
    start = new Date(ev.start_at);
    end = new Date(ev.end_at);
  } else {
    start = startOfDay(day);
    const now = new Date();
    start.setHours(sameDay(day, now) ? Math.min(now.getHours() + 1, 23) : 10);
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }
  let color = ev?.color ?? null;
  const error = h('p', { class: 'error' });

  const form = h('form', { class: 'event-form' },
    h('label', {}, 'タイトル', h('input', { name: 'title', required: true, maxlength: 100, value: ev?.title ?? '', placeholder: '予定のタイトル' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'all_day', checked: !!ev?.all_day }), '終日'),
    h('div', { class: 'row' },
      h('label', {}, '開始', h('input', { type: 'date', name: 'sd', required: true, value: dateInput(start) })),
      h('label', { class: 'time' }, '時刻', h('input', { type: 'time', name: 'st', value: timeInput(start) }))),
    h('div', { class: 'row' },
      h('label', {}, '終了', h('input', { type: 'date', name: 'ed', required: true, value: dateInput(end) })),
      h('label', { class: 'time' }, '時刻', h('input', { type: 'time', name: 'et', value: timeInput(end) }))),
    h('label', {}, 'ラベル色'),
    colorPicker(color, (c) => { color = c; }),
    h('label', {}, '場所', h('input', { name: 'location', maxlength: 200, value: ev?.location ?? '' })),
    h('label', {}, 'メモ', h('textarea', { name: 'memo', maxlength: 5000 }, ev?.memo ?? '')),
    error,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'ghost', onclick: () => (isNew ? closeModal() : openEvent(ev.id)) }, 'キャンセル'),
      h('button', { type: 'submit', class: 'primary' }, isNew ? '追加' : '保存'))
  );

  const allDay = form.elements.all_day;
  const syncTimes = () => form.querySelectorAll('.time').forEach((el) => { el.hidden = allDay.checked; });
  allDay.addEventListener('change', syncTimes);
  syncTimes();
  // Keep the end date from falling before the start date.
  form.elements.sd.addEventListener('change', () => {
    if (form.elements.ed.value < form.elements.sd.value) form.elements.ed.value = form.elements.sd.value;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const isAllDay = f.all_day.checked;
    const s = new Date(`${f.sd.value}T${isAllDay ? '00:00' : f.st.value || '00:00'}`);
    const en = new Date(`${f.ed.value}T${isAllDay ? '23:59:59' : f.et.value || '00:00'}`);
    if (en < s) { error.textContent = '終了は開始より後にしてください'; return; }
    const body = {
      title: f.title.value,
      all_day: isAllDay,
      start_at: s.toISOString(),
      end_at: en.toISOString(),
      color,
      location: f.location.value,
      memo: f.memo.value,
    };
    try {
      const { event } = isNew
        ? await api(`/calendars/${state.calId}/events`, { method: 'POST', body })
        : await api(`/events/${ev.id}`, { method: 'PATCH', body });
      const i = state.events.findIndex((x) => x.id === event.id);
      if (i >= 0) state.events[i] = event; else state.events.push(event);
      renderGrid();
      openEvent(event.id);
    } catch (err) {
      error.textContent = err.message;
    }
  });

  state.openEventId = ev?.id ?? null;
  openModal(modalHead(isNew ? '予定を追加' : '予定を編集'), form);
  form.elements.title.focus();
}

function commentItem(c) {
  return h('li', { 'data-id': c.id },
    h('span', { class: 'who' }, c.user_name), c.body, h('time', {}, fmtRelative(c.created_at)));
}

async function openEvent(id) {
  let ev, comments;
  try {
    [{ event: ev }, { comments }] = await Promise.all([api(`/events/${id}`), api(`/events/${id}/comments`)]);
  } catch (err) {
    toast(err.message);
    return;
  }
  state.openEventId = id;
  const list = h('ul', { class: 'comments' }, comments.map(commentItem));
  const input = h('input', { placeholder: 'コメントを書く', maxlength: 2000 });
  const commentForm = h('form', { class: 'comment-form' }, input, h('button', { class: 'primary', type: 'submit' }, '送信'));
  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    try {
      const { comment } = await api(`/events/${id}/comments`, { method: 'POST', body: { body: input.value } });
      input.value = '';
      if (!list.querySelector(`[data-id="${comment.id}"]`)) list.append(commentItem(comment));
      list.scrollTop = list.scrollHeight;
    } catch (err) { toast(err.message); }
  });

  const updated = ev.updated_at !== ev.created_at
    ? ` ・ ${ev.updated_by_name}が更新 (${fmtRelative(ev.updated_at)})` : '';

  openModal(
    h('div', { class: 'detail-bar', style: `background:${eventColor(ev)}` }),
    h('div', { class: 'modal-head' },
      h('h3', { class: 'detail-title' }, ev.title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '閉じる', onclick: closeModal }, '×')),
    h('p', { class: 'detail-meta' }, '🕒 ', fmtRange(ev)),
    ev.location ? h('p', { class: 'detail-meta' }, '📍 ', ev.location) : null,
    ev.memo ? h('div', { class: 'detail-memo' }, ev.memo) : null,
    h('p', { class: 'detail-by' }, `${ev.created_by_name}が作成${updated}`),
    h('div', { class: 'actions' },
      h('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          if (!confirm(`「${ev.title}」を削除しますか？`)) return;
          try {
            await api(`/events/${id}`, { method: 'DELETE' });
            state.events = state.events.filter((x) => x.id !== id);
            renderGrid();
            closeModal();
          } catch (err) { toast(err.message); }
        },
      }, '削除'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'primary', onclick: () => openEventForm(ev) }, '編集')),
    h('h4', {}, `コメント (${comments.length})`),
    list,
    commentForm
  );
  list.scrollTop = list.scrollHeight;
}

function openNewCalendar() {
  let color = COLORS[1];
  const error = h('p', { class: 'error' });
  const form = h('form', {},
    h('label', {}, 'カレンダー名', h('input', { name: 'name', required: true, maxlength: 50, placeholder: '例: 家族、サークル、チーム' })),
    h('label', {}, '色'),
    colorPickerFixed(color, (c) => { color = c; }),
    error,
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, '作成')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { calendar } = await api('/calendars', { method: 'POST', body: { name: form.elements.name.value, color } });
      state.calendars.push(calendar);
      await selectCalendar(calendar.id);
      openShare();
    } catch (err) { error.textContent = err.message; }
  });
  openModal(modalHead('新しいカレンダー'), form);
  form.elements.name.focus();
}

function colorPickerFixed(selected, onPick) {
  const wrap = h('div', { class: 'swatches' });
  const render = () => wrap.replaceChildren(...COLORS.map((c) => h('button', {
    type: 'button', class: `swatch${c === selected ? ' selected' : ''}`, style: `background:${c}`,
    onclick: () => { selected = c; onPick(c); render(); },
  })));
  render();
  return wrap;
}

function openShare() {
  const cal = currentCal();
  if (!cal) return;
  const link = `${location.origin}${location.pathname}?invite=${cal.invite_code}`;
  const linkInput = h('input', { readonly: true, value: link, onclick: (e) => e.target.select() });
  let color = cal.color;
  const nameInput = h('input', { value: cal.name, maxlength: 50 });

  openModal(
    modalHead(cal.name),
    h('p', { class: 'detail-meta' }, 'このリンクを送ると、相手がカレンダーに参加できます。'),
    h('div', { class: 'invite-box' }, linkInput,
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          try { await navigator.clipboard.writeText(link); toast('招待リンクをコピーしました'); }
          catch { linkInput.select(); }
        },
      }, 'コピー')),
    cal.role === 'owner'
      ? h('button', {
          type: 'button', class: 'link',
          onclick: async () => {
            if (!confirm('招待リンクを作り直しますか？古いリンクは使えなくなります。')) return;
            const { calendar } = await api(`/calendars/${cal.id}/invite/regenerate`, { method: 'POST' });
            Object.assign(cal, calendar);
            openShare();
          },
        }, 'リンクを再発行')
      : null,
    h('h4', {}, `メンバー (${cal.members.length})`),
    h('ul', { class: 'members' }, cal.members.map((m) =>
      h('li', {}, m.name + (m.id === state.user.id ? '（あなた）' : ''),
        m.role === 'owner' ? h('span', { class: 'badge' }, 'オーナー') : null))),
    h('h4', {}, '設定'),
    h('label', {}, 'カレンダー名', nameInput),
    colorPickerFixed(color, (c) => { color = c; }),
    h('div', { class: 'actions' },
      h('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          const last = cal.members.length === 1;
          const msg = last ? 'あなたが最後のメンバーです。退出するとカレンダーと予定が削除されます。よろしいですか？' : `「${cal.name}」から退出しますか？`;
          if (!confirm(msg)) return;
          await api(`/calendars/${cal.id}/members/me`, { method: 'DELETE' });
          closeModal();
          state.calId = null;
          await loadCalendars();
        },
      }, '退出'),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          try {
            const { calendar } = await api(`/calendars/${cal.id}`, { method: 'PATCH', body: { name: nameInput.value, color } });
            Object.assign(cal, calendar);
            renderCalendarList();
            $('#topbar').style.background = cal.color;
            renderGrid();
            toast('保存しました');
          } catch (err) { toast(err.message); }
        },
      }, '保存'))
  );
}

async function showInvite(code) {
  try {
    const { calendar } = await api(`/invites/${encodeURIComponent(code)}`);
    if (state.calendars.some((c) => c.id === calendar.id)) {
      await selectCalendar(calendar.id);
      toast(`「${calendar.name}」にはすでに参加しています`);
      return;
    }
    openModal(
      modalHead('カレンダーへの招待'),
      h('p', {}, `${calendar.owner_name}さんの「`, h('strong', {}, calendar.name), `」に招待されています（${calendar.member_count}人参加中）。`),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'やめる'),
        h('button', {
          type: 'button', class: 'primary',
          onclick: async () => {
            const { calendar: joined } = await api(`/invites/${encodeURIComponent(code)}/join`, { method: 'POST' });
            closeModal();
            state.calendars.push(joined);
            await selectCalendar(joined.id);
            toast(`「${joined.name}」に参加しました`);
          },
        }, '参加する')));
  } catch (err) {
    toast(err.message);
  }
}

// ---------- wire up ----------
$('#prev-month').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); loadEvents(); });
$('#next-month').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); loadEvents(); });
$('#today-btn').addEventListener('click', () => { state.month = startOfMonth(new Date()); loadEvents(); });
$('#share-btn').addEventListener('click', openShare);
$('#add-event-btn').addEventListener('click', () => openEventForm(null, new Date()));
$('#new-calendar-btn').addEventListener('click', openNewCalendar);
$('.open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('.close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));

// If the invite link is opened while logged out, nudge toward sign-up.
if (!state.token && new URLSearchParams(location.search).has('invite')) setAuthMode('register');

fetch('/api/config').then((r) => r.json()).then(({ demoNotice }) => {
  $('#demo-notice').hidden = !demoNotice;
  $('#demo-badge').hidden = !demoNotice;
}).catch(() => {});

boot();
