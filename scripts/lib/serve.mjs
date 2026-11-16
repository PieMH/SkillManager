// The status page: a small server on 127.0.0.1 for one project. Tier moves, update checks and skips are
// applied here directly, with no model and no tokens. Everything else is queued for Claude: "Send to Claude"
// stops the server and hands the queue to `onExit`, which the CLI prints. When the CLI runs as a background
// task, that exit re-invokes Claude with the queue. The server never installs or uninstalls anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, oneLine, paths } from './inventory.mjs';
import { FILE, TIERABLE, TIERS, lead, moveItems, parse, reconcile, split, summarize } from './tiers.mjs';
import { check, passDue, pending, readState, skip, stampPass } from './updates.mjs';

const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));
const KINDS = new Set(['update', 'updates', 'uninstall', 'similar', 'research']);
const fwd = (p) => String(p).replace(/\\/g, '/');

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

export function startServer({ projectDir, env = process.env, home, idleMs = 30 * 60000, onExit = () => {}, io } = {}) {
  const p = paths(env, home);
  const token = crypto.randomBytes(24).toString('hex');
  const queue = [];
  let last = Date.now();
  let port = 0;
  let done = false;
  const things = () => inventory({ projectDir, env, home: p.home }).things;

  function snapshot() {
    const text = fs.readFileSync(path.join(projectDir, FILE), 'utf8');
    const { items } = parse(text);
    const all = things();
    const byId = new Map(all.map((t) => [t.id, t]));
    const view = (id, extra) => {
      const t = byId.get(id);
      const [kind, name] = split(id);
      return { id, kind, name, installed: TIERABLE.has(kind) ? Boolean(t) : true, source: t?.source || null, uses: t?.uses || 0, ...extra };
    };
    const st = readState(p);
    return {
      project: fwd(projectDir),
      scope: /^Scope:\s*(.*)$/m.exec(text)?.[1] || '',
      tiers: Object.fromEntries(TIERS.map((tier) => [tier, items.filter((i) => i.tier === tier).map((i) => view(i.id, { text: lead(i.text) }))])),
      untiered: reconcile(items, all).untiered.map((id) => view(id, { text: oneLine(byId.get(id)?.description, 120) })),
      updates: pending(st),
      checkedAt: st.checkedAt || null,
      passAt: st.passAt || null,
      passDue: passDue(st),
      queue,
    };
  }

  const timer = setInterval(() => { if (Date.now() - last > idleMs) finish('idle'); }, Math.min(60000, idleMs));
  timer.unref();
  let server;
  function finish(reason) {
    if (done) return;
    done = true;
    clearInterval(timer);
    server.close();
    server.closeAllConnections?.();
    onExit({ reason, queue: [...queue] });
  }

  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const json = (res, code, body) => { res.writeHead(code, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  server = http.createServer(async (req, res) => {
    try {
      // Only this machine's own names: a site that points its domain at 127.0.0.1 (DNS rebinding) would
      // otherwise count as the page's origin. Cross-origin requests are refused outright.
      const host = String(req.headers.host || '').toLowerCase();
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: 'unknown host' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'cross-origin request' });
      const url = new URL(req.url, `http://${host}`);
      last = Date.now();

      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) { res.writeHead(403, { ...headers, 'Content-Type': 'text/plain' }); return res.end('Open the link Claude gave you.'); }
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = fs.readFileSync(PAGE, 'utf8').replaceAll('{{NONCE}}', nonce).replace('{{CONFIG}}', JSON.stringify({ token }).replace(/</g, '\\u003c'));
        res.writeHead(200, {
          ...headers, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        return res.end(html);
      }
      if (req.headers['x-skillset-token'] !== token) return json(res, 403, { error: 'missing or wrong token' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot());
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'send JSON' });
      const body = await readBody(req);

      switch (url.pathname) {
        case '/api/move': {
          if (!TIERS.includes(body.tier)) return json(res, 400, { error: 'unknown tier' });
          const r = moveItems(projectDir, body.tier, [].concat(body.ids || []).map(String), things());
          return json(res, 200, { changes: summarize(r.changes), reload: Boolean(r.reload), unenforced: r.unenforced, error: r.error || null, state: snapshot() });
        }
        // The update pass: a fresh check, stamped; anything pending goes to Claude at once as one review,
        // with whatever else is queued. With nothing pending the pass is done and the page stays.
        case '/api/pass': {
          await check(p, io);
          stampPass(p);
          const count = pending(readState(p)).length;
          if (!count) return json(res, 200, { sent: false, state: snapshot() });
          if (!queue.some((q) => q.kind === 'updates')) queue.push({ kind: 'updates', id: null, text: null });
          res.on('finish', () => finish('sent'));
          return json(res, 200, { sent: true, count: queue.length, updates: count });
        }
        case '/api/skip':
          skip(p, String(body.id || ''), String(body.reason || '').slice(0, 300));
          return json(res, 200, { state: snapshot() });
        case '/api/queue': {
          const item = { kind: String(body.kind || ''), id: body.id ? String(body.id).slice(0, 200) : null, text: body.text ? String(body.text).trim().slice(0, 1000) : null };
          const needs = { research: 'text', updates: false }[item.kind] ?? 'id'; // false: "review every update" needs neither
          if (!KINDS.has(item.kind) || (needs && !item[needs])) return json(res, 400, { error: 'unknown request' });
          if (item.kind === 'updates' && queue.some((q) => q.kind === 'updates')) return json(res, 200, { queue });
          if (queue.length >= 50) return json(res, 400, { error: 'the queue is full; send it first' });
          queue.push(item);
          return json(res, 200, { queue });
        }
        case '/api/unqueue': {
          const i = Number(body.index);
          if (Number.isInteger(i) && i >= 0 && i < queue.length) queue.splice(i, 1);
          return json(res, 200, { queue });
        }
        case '/api/send':
          res.on('finish', () => finish('sent'));
          return json(res, 200, { ok: true, count: queue.length });
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/?t=${token}`, port, token, close: () => finish('closed') });
    });
  });
}
