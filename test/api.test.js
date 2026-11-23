'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

let n = 0;
async function register(name) {
  const { status, data } = await call('/auth/register', {
    method: 'POST',
    body: { name, email: `${name.toLowerCase()}${++n}@example.com`, password: 'secret123' },
  });
  assert.equal(status, 201);
  return data;
}

// Collects SSE messages for a user.
function listen(token) {
  const messages = [];
  return new Promise((resolve) => {
    const req = http.get(`${base}/stream?token=${token}`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type === 'ready') resolve({ messages, close: () => req.destroy() });
          else if (type) messages.push({ type, data: JSON.parse(data) });
        }
      });
    });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 50));

test('register, login and personal calendar', async () => {
  const { token, user } = await register('Alice');
  assert.equal(user.name, 'Alice');

  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: user.email, password: 'secret123' },
  });
  assert.equal(login.status, 200);

  const bad = await call('/auth/login', { method: 'POST', body: { email: user.email, password: 'nope' } });
  assert.equal(bad.status, 401);

  const { data } = await call('/calendars', { token });
  assert.equal(data.calendars.length, 1);
  assert.equal(data.calendars[0].role, 'owner');

  assert.equal((await call('/calendars')).status, 401);
  assert.equal((await call('/auth/register', { method: 'POST', body: { name: 'x', email: user.email, password: 'secret123' } })).status, 409);
});

test('sharing a calendar via invite and syncing events in realtime', async () => {
  const alice = await register('Alice');
  const bob = await register('Bob');
  const carol = await register('Carol');

  const { data: created } = await call('/calendars', {
    token: alice.token, method: 'POST', body: { name: '家族', color: '#3498db' },
  });
  const cal = created.calendar;

  // Outsiders cannot see the calendar.
  assert.equal((await call(`/calendars/${cal.id}/events`, { token: bob.token })).status, 404);

  const preview = await call(`/invites/${cal.invite_code}`, { token: bob.token });
  assert.equal(preview.data.calendar.name, '家族');
  const joined = await call(`/invites/${cal.invite_code}/join`, { token: bob.token, method: 'POST' });
  assert.equal(joined.data.calendar.members.length, 2);

  const bobStream = await listen(bob.token);
  const carolStream = await listen(carol.token);

  const { status, data } = await call(`/calendars/${cal.id}/events`, {
    token: alice.token,
    method: 'POST',
    body: {
      title: '旅行',
      start_at: '2026-12-24T00:00:00Z',
      end_at: '2026-12-26T00:00:00Z',
      all_day: true,
      location: '箱根',
    },
  });
  assert.equal(status, 201);
  const ev = data.event;
  assert.equal(ev.created_by_name, 'Alice');

  await tick();
  const upsert = bobStream.messages.find((m) => m.type === 'event.upsert');
  assert.equal(upsert.data.event.title, '旅行');
  assert.ok(bobStream.messages.some((m) => m.type === 'activity'));
  assert.equal(carolStream.messages.length, 0, 'non-members get nothing');

  // Bob edits; range query finds it.
  const patched = await call(`/events/${ev.id}`, { token: bob.token, method: 'PATCH', body: { title: '箱根旅行' } });
  assert.equal(patched.data.event.updated_by_name, 'Bob');

  const range = await call(
    `/calendars/${cal.id}/events?from=2026-12-25T00:00:00Z&to=2026-12-31T00:00:00Z`,
    { token: alice.token }
  );
  assert.deepEqual(range.data.events.map((e) => e.title), ['箱根旅行']);
  const outside = await call(
    `/calendars/${cal.id}/events?from=2027-01-01T00:00:00Z&to=2027-02-01T00:00:00Z`,
    { token: alice.token }
  );
  assert.equal(outside.data.events.length, 0);

  // Comments.
  await call(`/events/${ev.id}/comments`, { token: bob.token, method: 'POST', body: { body: '楽しみ！' } });
  const comments = await call(`/events/${ev.id}/comments`, { token: alice.token });
  assert.equal(comments.data.comments[0].user_name, 'Bob');
  assert.equal((await call(`/events/${ev.id}/comments`, { token: carol.token })).status, 404);

  // Activity feed.
  const feed = await call(`/calendars/${cal.id}/activities`, { token: alice.token });
  assert.deepEqual(
    feed.data.activities.map((a) => a.kind),
    ['comment.created', 'event.updated', 'event.created', 'member.joined']
  );

  // Delete propagates.
  assert.equal((await call(`/events/${ev.id}`, { token: alice.token, method: 'DELETE' })).status, 204);
  await tick();
  assert.ok(bobStream.messages.some((m) => m.type === 'event.delete' && m.data.eventId === ev.id));

  bobStream.close();
  carolStream.close();
});

test('validation', async () => {
  const { token } = await register('Dave');
  const { data } = await call('/calendars', { token });
  const id = data.calendars[0].id;
  const post = (body) => call(`/calendars/${id}/events`, { token, method: 'POST', body });

  assert.equal((await post({ start_at: '2026-01-01T00:00:00Z' })).status, 400);
  assert.equal((await post({ title: 'x', start_at: 'nope' })).status, 400);
  assert.equal(
    (await post({ title: 'x', start_at: '2026-01-02T00:00:00Z', end_at: '2026-01-01T00:00:00Z' })).status,
    400
  );
  assert.equal((await post({ title: 'x', start_at: '2026-01-01T00:00:00Z', color: 'red' })).status, 400);
  assert.equal((await post({ title: 'x', start_at: '2026-01-01T00:00:00Z' })).status, 201);
});

test('owner leaving hands over ownership; last member leaving deletes calendar', async () => {
  const alice = await register('Alice');
  const bob = await register('Bob');
  const { data } = await call('/calendars', { token: alice.token, method: 'POST', body: { name: 'Team' } });
  const cal = data.calendar;
  await call(`/invites/${cal.invite_code}/join`, { token: bob.token, method: 'POST' });

  assert.equal((await call(`/calendars/${cal.id}/members/me`, { token: alice.token, method: 'DELETE' })).status, 204);
  const after = await call(`/calendars/${cal.id}`, { token: bob.token });
  assert.equal(after.data.calendar.role, 'owner');
  assert.equal(after.data.calendar.members.length, 1);

  // Old invite code dies after regeneration.
  await call(`/calendars/${cal.id}/invite/regenerate`, { token: bob.token, method: 'POST' });
  assert.equal((await call(`/invites/${cal.invite_code}`, { token: alice.token })).status, 404);

  await call(`/calendars/${cal.id}/members/me`, { token: bob.token, method: 'DELETE' });
  assert.equal((await call(`/calendars/${cal.id}`, { token: bob.token })).status, 404);
});

test('auth endpoints are rate limited per IP', async () => {
  const app = createApp({ authAttemptLimit: 3 });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/login`;
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'wrong' }),
    });
    statuses.push(res.status);
  }
  srv.close();
  assert.deepEqual(statuses, [401, 401, 401, 429]);
});
