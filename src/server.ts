import { readFileSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import { CONFIG } from './config.js';
import { buildAuthUrl, exchangeCodeForTokens, isAuthorized } from './oauth.js';
import { buildExport, ack } from './exporter.js';
import { runSync } from './sync.js';
import { startScheduler } from './scheduler.js';

const app = Fastify({ logger: true });

function bearer(req: FastifyRequest): string {
  const h = (req.headers['authorization'] ?? '') as string;
  return h.replace(/^Bearer\s+/i, '').trim();
}

function publicHtml(file: string): string {
  return readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
}

function messagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} - Health Bridge</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6f8;color:#18212f}.card{max-width:520px;background:white;border:1px solid #dde3ea;border-radius:18px;padding:34px;box-shadow:0 18px 50px rgba(24,33,47,.08)}h1{margin:0 0 10px;font-size:28px;line-height:1.15}p{margin:0;color:#5d6b7a;line-height:1.6}code{background:#eef2f6;border-radius:6px;padding:2px 6px}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// ---- Liveness ----
app.get('/healthz', async () => ({ ok: true, authorized: isAuthorized() }));

// ---- Public app info pages required by Google OAuth production publishing ----
app.get('/', async (_req, reply) => reply.type('text/html').send(publicHtml('index.html')));
app.get('/privacy', async (_req, reply) => reply.type('text/html').send(publicHtml('privacy.html')));
app.get('/privacy.html', async (_req, reply) => reply.type('text/html').send(publicHtml('privacy.html')));
app.get('/terms', async (_req, reply) => reply.type('text/html').send(publicHtml('terms.html')));
app.get('/terms.html', async (_req, reply) => reply.type('text/html').send(publicHtml('terms.html')));

// ---- One-time OAuth bootstrap (protected by ?admin=ADMIN_TOKEN) ----
app.get('/auth/start', async (req, reply) => {
  const admin = (req.query as Record<string, string>)?.admin;
  if (admin !== CONFIG.adminToken) {
    return reply
      .code(403)
      .type('text/html')
      .send(messagePage('Access denied', 'Admin token required or incorrect.'));
  }
  return reply.redirect(buildAuthUrl());
});

app.get('/auth/callback', async (req, reply) => {
  const code = (req.query as Record<string, string>)?.code;
  if (!code) {
    return reply
      .code(400)
      .type('text/html')
      .send(messagePage('Authorization incomplete', 'No authorization code was returned by Google.'));
  }
  try {
    await exchangeCodeForTokens(code);
    return reply.type('text/html').send(messagePage('You are connected', 'Health Bridge is linked to your Google Health account. You can close this tab.'));
  } catch (err) {
    req.log.error(err);
    return reply.code(500).type('text/html').send(messagePage('Authorization failed', (err as Error).message));
  }
});

// ---- Shortcut endpoints (protected by Bearer SHORTCUT_TOKEN) ----
app.get('/export', async (req, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  return buildExport();
});

app.post('/ack', async (req, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  const body = (req.body ?? {}) as { batchId?: string };
  if (!body.batchId) return reply.code(400).send({ error: 'batchId required' });
  return { ok: ack(body.batchId) };
});

// ---- Manual sync trigger (testing) ----
app.post('/sync', async (req, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  return runSync();
});

// ---- Future: Google Health webhook (sleep push). Implements the verification handshake. ----
app.post('/webhooks/google-health', async (req, reply) => {
  const body = (req.body ?? {}) as { type?: string };
  if (body.type === 'verification') {
    return bearer(req) === CONFIG.webhookToken ? reply.code(200).send() : reply.code(401).send();
  }
  reply.code(204).send();
  setImmediate(() => {
    runSync().catch((err) => app.log.error(err));
  });
});

async function main(): Promise<void> {
  await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
  startScheduler();
  if (CONFIG.syncOnBoot && isAuthorized()) {
    runSync()
      .then((r) => app.log.info(`[boot] sync added ${r.added}/${r.fetched} samples`))
      .catch((err) => app.log.error(`[boot] sync failed: ${(err as Error).message}`));
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
