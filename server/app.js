'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb } = require('./db');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v, { max = 200, required = false, field = 'value' } = {}) => {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} is too long`);
  return t;
};

const isoDate = (v, field) => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
    throw new HttpError(400, `${field} must be an ISO 8601 date`);
  }
  return new Date(v).toISOString();
};

function createApp({ dbFile = ':memory:' } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // ---------- realtime (Server-Sent Events) ----------
  const streams = new Map(); // userId -> Set<res>

  function publish(calendarId, type, payload) {
    const members = db
      .prepare('SELECT user_id FROM memberships WHERE calendar_id = ?')
      .all(calendarId);
    const data = `event: ${type}\ndata: ${JSON.stringify({ calendarId, ...payload })}\n\n`;
    for (const { user_id } of members) {
      for (const res of streams.get(user_id) || []) res.write(data);
    }
  }

  function logActivity(calendarId, userId, kind, summary, eventId = null) {
    const row = db
      .prepare(
        `INSERT INTO activities (calendar_id, user_id, kind, summary, event_id)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .get(calendarId, userId, kind, summary, eventId);
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const activity = { ...row, user_name: user.name };
    publish(calendarId, 'activity', { activity });
    return activity;
  }

  // ---------- auth ----------
  function userForToken(token) {
    if (!token) return null;
    return db
      .prepare(
        `SELECT u.id, u.name, u.email FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token = ?`
      )
      .get(token);
  }

  function auth(req, _res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = userForToken(token);
    if (!user) return next(new HttpError(401, 'login required'));
    req.user = user;
    req.token = token;
    next();
  }

  function issueToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    return token;
  }

  function requireMember(calendarId, userId) {
    const row = db
      .prepare('SELECT role FROM memberships WHERE calendar_id = ? AND user_id = ?')
      .get(calendarId, userId);
    if (!row) throw new HttpError(404, 'calendar not found');
    return row.role;
  }

  function loadEvent(eventId, userId) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!ev) throw new HttpError(404, 'event not found');
    requireMember(ev.calendar_id, userId);
    return ev;
  }

  const eventView = (id) =>
    db
      .prepare(
        `SELECT e.*, cu.name AS created_by_name, uu.name AS updated_by_name,
                (SELECT COUNT(*) FROM comments c WHERE c.event_id = e.id) AS comment_count
         FROM events e
         JOIN users cu ON cu.id = e.created_by
         JOIN users uu ON uu.id = e.updated_by
         WHERE e.id = ?`
      )
      .get(id);

  const calendarView = (id, userId) => {
    const cal = db
      .prepare(
        `SELECT c.*, m.role FROM calendars c
         JOIN memberships m ON m.calendar_id = c.id AND m.user_id = ?
         WHERE c.id = ?`
      )
      .get(userId, id);
    if (!cal) return null;
    cal.members = db
      .prepare(
        `SELECT u.id, u.name, m.role FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.calendar_id = ? ORDER BY m.joined_at`
      )
      .all(id);
    return cal;
  };

  const newInviteCode = () => crypto.randomBytes(6).toString('base64url');

  const api = express.Router();

  api.post('/auth/register', (req, res) => {
    const name = str(req.body.name, { required: true, max: 50, field: 'name' });
    const email = str(req.body.email, { required: true, max: 200, field: 'email' }).toLowerCase();
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters');
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'email already registered');
    }
    const user = db
      .prepare(
        'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id, name, email'
      )
      .get(name, email, hashPassword(password));

    // Every user starts with a personal calendar, like TimeTree.
    const cal = db
      .prepare(
        'INSERT INTO calendars (name, color, invite_code, owner_id) VALUES (?, ?, ?, ?) RETURNING id'
      )
      .get(`${name}のカレンダー`, '#2ecc71', newInviteCode(), user.id);
    db.prepare("INSERT INTO memberships (calendar_id, user_id, role) VALUES (?, ?, 'owner')").run(
      cal.id,
      user.id
    );

    res.status(201).json({ token: issueToken(user.id), user });
  });

  api.post('/auth/login', (req, res) => {
    const email = str(req.body.email, { required: true, field: 'email' }).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, 'invalid email or password');
    }
    res.json({
      token: issueToken(row.id),
      user: { id: row.id, name: row.name, email: row.email },
    });
  });

  api.post('/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.status(204).end();
  });

  api.get('/me', auth, (req, res) => res.json({ user: req.user }));

  // ---------- calendars ----------
  api.get('/calendars', auth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id FROM calendars c
         JOIN memberships m ON m.calendar_id = c.id
         WHERE m.user_id = ? ORDER BY c.created_at, c.id`
      )
      .all(req.user.id);
    res.json({ calendars: rows.map((r) => calendarView(r.id, req.user.id)) });
  });

  api.post('/calendars', auth, (req, res) => {
    const name = str(req.body.name, { required: true, max: 50, field: 'name' });
    const color = req.body.color ?? '#2ecc71';
    if (!COLOR_RE.test(color)) throw new HttpError(400, 'color must be #rrggbb');
    const cal = db
      .prepare(
        'INSERT INTO calendars (name, color, invite_code, owner_id) VALUES (?, ?, ?, ?) RETURNING id'
      )
      .get(name, color, newInviteCode(), req.user.id);
    db.prepare("INSERT INTO memberships (calendar_id, user_id, role) VALUES (?, ?, 'owner')").run(
      cal.id,
      req.user.id
    );
    res.status(201).json({ calendar: calendarView(cal.id, req.user.id) });
  });

  api.get('/calendars/:id', auth, (req, res) => {
    const cal = calendarView(Number(req.params.id), req.user.id);
    if (!cal) throw new HttpError(404, 'calendar not found');
    res.json({ calendar: cal });
  });

  api.patch('/calendars/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    requireMember(id, req.user.id);
    const name = str(req.body.name, { max: 50, field: 'name' });
    const color = req.body.color;
    if (color !== undefined && !COLOR_RE.test(color)) {
      throw new HttpError(400, 'color must be #rrggbb');
    }
    db.prepare(
      'UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?'
    ).run(name || null, color ?? null, id);
    const cal = calendarView(id, req.user.id);
    publish(id, 'calendar', { calendar: cal });
    res.json({ calendar: cal });
  });

  api.post('/calendars/:id/invite/regenerate', auth, (req, res) => {
    const id = Number(req.params.id);
    if (requireMember(id, req.user.id) !== 'owner') {
      throw new HttpError(403, 'only the owner can reset the invite link');
    }
    db.prepare('UPDATE calendars SET invite_code = ? WHERE id = ?').run(newInviteCode(), id);
    res.json({ calendar: calendarView(id, req.user.id) });
  });

  api.get('/invites/:code', auth, (req, res) => {
    const cal = db
      .prepare(
        `SELECT c.id, c.name, c.color, u.name AS owner_name,
                (SELECT COUNT(*) FROM memberships m WHERE m.calendar_id = c.id) AS member_count
         FROM calendars c JOIN users u ON u.id = c.owner_id WHERE c.invite_code = ?`
      )
      .get(req.params.code);
    if (!cal) throw new HttpError(404, 'invite link is invalid or expired');
    res.json({ calendar: cal });
  });

  api.post('/invites/:code/join', auth, (req, res) => {
    const cal = db.prepare('SELECT id FROM calendars WHERE invite_code = ?').get(req.params.code);
    if (!cal) throw new HttpError(404, 'invite link is invalid or expired');
    const result = db
      .prepare('INSERT OR IGNORE INTO memberships (calendar_id, user_id) VALUES (?, ?)')
      .run(cal.id, req.user.id);
    if (result.changes) {
      logActivity(cal.id, req.user.id, 'member.joined', `${req.user.name}さんが参加しました`);
      publish(cal.id, 'calendar', { calendar: calendarView(cal.id, req.user.id) });
    }
    res.json({ calendar: calendarView(cal.id, req.user.id) });
  });

  api.delete('/calendars/:id/members/me', auth, (req, res) => {
    const id = Number(req.params.id);
    requireMember(id, req.user.id);
    const others = db
      .prepare('SELECT user_id FROM memberships WHERE calendar_id = ? AND user_id != ? ORDER BY joined_at')
      .all(id, req.user.id);
    if (others.length === 0) {
      db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
    } else {
      logActivity(id, req.user.id, 'member.left', `${req.user.name}さんが退出しました`);
      db.prepare('DELETE FROM memberships WHERE calendar_id = ? AND user_id = ?').run(id, req.user.id);
      // Hand ownership over if the owner leaves.
      const owner = db
        .prepare("SELECT 1 FROM memberships WHERE calendar_id = ? AND role = 'owner'")
        .get(id);
      if (!owner) {
        db.prepare("UPDATE memberships SET role = 'owner' WHERE calendar_id = ? AND user_id = ?").run(
          id,
          others[0].user_id
        );
        db.prepare('UPDATE calendars SET owner_id = ? WHERE id = ?').run(others[0].user_id, id);
      }
      publish(id, 'calendar', { calendar: calendarView(id, others[0].user_id) });
    }
    res.status(204).end();
  });

  api.get('/calendars/:id/activities', auth, (req, res) => {
    const id = Number(req.params.id);
    requireMember(id, req.user.id);
    const activities = db
      .prepare(
        `SELECT a.*, u.name AS user_name FROM activities a
         JOIN users u ON u.id = a.user_id
         WHERE a.calendar_id = ? ORDER BY a.id DESC LIMIT 50`
      )
      .all(id);
    res.json({ activities });
  });

  // ---------- events ----------
  function parseEventBody(body, existing) {
    const out = {};
    const title = str(body.title, { max: 100, field: 'title', required: !existing });
    if (title !== undefined) {
      if (!title) throw new HttpError(400, 'title is required');
      out.title = title;
    }
    if (body.start_at !== undefined) out.start_at = isoDate(body.start_at, 'start_at');
    else if (!existing) throw new HttpError(400, 'start_at is required');
    if (body.end_at !== undefined) out.end_at = isoDate(body.end_at, 'end_at');
    else if (!existing) out.end_at = out.start_at;
    if (body.all_day !== undefined) out.all_day = body.all_day ? 1 : 0;
    if (body.color !== undefined) {
      if (body.color !== null && !COLOR_RE.test(body.color)) {
        throw new HttpError(400, 'color must be #rrggbb');
      }
      out.color = body.color;
    }
    const location = str(body.location, { max: 200, field: 'location' });
    if (location !== undefined) out.location = location;
    const memo = str(body.memo, { max: 5000, field: 'memo' });
    if (memo !== undefined) out.memo = memo;

    const start = out.start_at ?? existing?.start_at;
    const end = out.end_at ?? existing?.end_at;
    if (end < start) throw new HttpError(400, 'end_at must not be before start_at');
    return out;
  }

  api.get('/calendars/:id/events', auth, (req, res) => {
    const id = Number(req.params.id);
    requireMember(id, req.user.id);
    const from = req.query.from ? isoDate(req.query.from, 'from') : '0000';
    const to = req.query.to ? isoDate(req.query.to, 'to') : '9999';
    const ids = db
      .prepare(
        `SELECT id FROM events WHERE calendar_id = ? AND end_at >= ? AND start_at < ?
         ORDER BY all_day DESC, start_at, id`
      )
      .all(id, from, to);
    res.json({ events: ids.map((r) => eventView(r.id)) });
  });

  api.post('/calendars/:id/events', auth, (req, res) => {
    const id = Number(req.params.id);
    requireMember(id, req.user.id);
    const e = parseEventBody(req.body, null);
    const row = db
      .prepare(
        `INSERT INTO events (calendar_id, title, start_at, end_at, all_day, color, location, memo,
                             created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        id,
        e.title,
        e.start_at,
        e.end_at,
        e.all_day ?? 0,
        e.color ?? null,
        e.location ?? '',
        e.memo ?? '',
        req.user.id,
        req.user.id
      );
    const event = eventView(row.id);
    publish(id, 'event.upsert', { event });
    logActivity(id, req.user.id, 'event.created', `「${event.title}」を追加しました`, event.id);
    res.status(201).json({ event });
  });

  api.get('/events/:id', auth, (req, res) => {
    const ev = loadEvent(Number(req.params.id), req.user.id);
    res.json({ event: eventView(ev.id) });
  });

  api.patch('/events/:id', auth, (req, res) => {
    const ev = loadEvent(Number(req.params.id), req.user.id);
    const changes = parseEventBody(req.body, ev);
    const keys = Object.keys(changes);
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(
        `UPDATE events SET ${sets}, updated_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(...keys.map((k) => changes[k]), req.user.id, ev.id);
    }
    const event = eventView(ev.id);
    publish(ev.calendar_id, 'event.upsert', { event });
    logActivity(ev.calendar_id, req.user.id, 'event.updated', `「${event.title}」を更新しました`, ev.id);
    res.json({ event });
  });

  api.delete('/events/:id', auth, (req, res) => {
    const ev = loadEvent(Number(req.params.id), req.user.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    publish(ev.calendar_id, 'event.delete', { eventId: ev.id });
    logActivity(ev.calendar_id, req.user.id, 'event.deleted', `「${ev.title}」を削除しました`);
    res.status(204).end();
  });

  // ---------- comments ----------
  api.get('/events/:id/comments', auth, (req, res) => {
    const ev = loadEvent(Number(req.params.id), req.user.id);
    const comments = db
      .prepare(
        `SELECT c.*, u.name AS user_name FROM comments c
         JOIN users u ON u.id = c.user_id WHERE c.event_id = ? ORDER BY c.id`
      )
      .all(ev.id);
    res.json({ comments });
  });

  api.post('/events/:id/comments', auth, (req, res) => {
    const ev = loadEvent(Number(req.params.id), req.user.id);
    const body = str(req.body.body, { required: true, max: 2000, field: 'body' });
    const row = db
      .prepare('INSERT INTO comments (event_id, user_id, body) VALUES (?, ?, ?) RETURNING *')
      .get(ev.id, req.user.id, body);
    const comment = { ...row, user_name: req.user.name };
    publish(ev.calendar_id, 'comment', { eventId: ev.id, comment });
    logActivity(ev.calendar_id, req.user.id, 'comment.created', `「${ev.title}」にコメントしました`, ev.id);
    res.status(201).json({ comment });
  });

  // ---------- realtime stream ----------
  // EventSource cannot send headers, so the token comes in the query string.
  api.get('/stream', (req, res) => {
    const user = userForToken(req.query.token);
    if (!user) throw new HttpError(401, 'login required');
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    if (!streams.has(user.id)) streams.set(user.id, new Set());
    streams.get(user.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(user.id)?.delete(res);
    });
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'invalid JSON');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
