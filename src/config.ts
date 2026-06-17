import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export const CONFIG = {
  port: Number(opt('PORT', '8080')),
  publicBaseUrl: req('PUBLIC_BASE_URL'),

  googleClientId: req('GOOGLE_CLIENT_ID'),
  googleClientSecret: req('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: req('GOOGLE_REDIRECT_URI'),
  googleScopes: req('GOOGLE_SCOPES'),

  shortcutToken: req('SHORTCUT_TOKEN'),
  adminToken: req('ADMIN_TOKEN'),
  // Webhook auth token (future). Falls back to the shortcut token if unset.
  webhookToken: opt('WEBHOOK_TOKEN', req('SHORTCUT_TOKEN')),

  userTz: opt('USER_TZ', 'Europe/London'),
  lookbackDays: Number(opt('LOOKBACK_DAYS', '4')),
  sqlitePath: opt('SQLITE_PATH', '/data/health-bridge.db'),

  debugDump: opt('DEBUG_DUMP', '0') === '1',
  syncOnBoot: opt('SYNC_ON_BOOT', '1') === '1',
  // Steps/distance duplicate what the iPhone already logs — set to 0 to avoid double-counting.
  syncActivity: opt('SYNC_ACTIVITY', '1') === '1',
} as const;
