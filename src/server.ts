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

// ---- Liveness ----
app.get('/healthz', async () => ({ ok: true, authorized: isAuthorized() }));

// ---- One-time OAuth bootstrap (protected by ?admin=ADMIN_TOKEN) ----
app.get('/auth/start', async (req, reply) => {
  const admin = (req.query as Record<string, string>)?.admin;
  if (admin !== CONFIG.adminToken) return reply.code(403).send('forbidden');
  return reply.redirect(buildAuthUrl());
});

app.get('/auth/callback', async (req, reply) => {
  const code = (req.query as Record<string, string>)?.code;
  if (!code) return reply.code(400).send('missing code');
  try {
    await exchangeCodeForTokens(code);
    return reply.type('text/html').send('<h2>Authorized.</h2><p>You can close this tab.</p>');
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send(`Authorization failed: ${(err as Error).message}`);
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
