import { CONFIG } from './config.js';
import { db, type OAuthRow } from './db.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IDENTITY_URL = 'https://health.googleapis.com/v4/users/me/identity';

/** Build the consent URL for the one-time /auth/start bootstrap. */
export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CONFIG.googleClientId,
    redirect_uri: CONFIG.googleRedirectUri,
    response_type: 'code',
    scope: CONFIG.googleScopes,
    access_type: 'offline', // required to receive a refresh token
    prompt: 'consent', // force a refresh_token even on re-consent
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Exchange the authorization code for tokens and persist the refresh token. */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CONFIG.googleClientId,
      client_secret: CONFIG.googleClientSecret,
      redirect_uri: CONFIG.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!t.refresh_token) {
    throw new Error(
      'No refresh_token returned. Revoke prior access at myaccount.google.com/permissions and retry /auth/start.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO oauth (id, refresh_token, access_token, access_expires, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token  = excluded.access_token,
       access_expires= excluded.access_expires,
       updated_at    = excluded.updated_at`,
  ).run(t.refresh_token, t.access_token, now + t.expires_in - 60, Date.now());

  // Store the user's identity (recommended by Google).
  try {
    const id = await getIdentity(t.access_token);
    db.prepare(`UPDATE oauth SET health_user_id = ?, legacy_user_id = ? WHERE id = 1`).run(
      id.healthUserId ?? null,
      id.legacyUserId ?? null,
    );
  } catch {
    // Non-fatal; identity is informational.
  }
}

/** Return a valid access token, refreshing it if expired. */
export async function getAccessToken(): Promise<string> {
  const row = db.prepare(`SELECT * FROM oauth WHERE id = 1`).get() as OAuthRow | undefined;
  if (!row?.refresh_token) {
    throw new Error('Not authorized yet — visit /auth/start?admin=ADMIN_TOKEN');
  }

  const now = Math.floor(Date.now() / 1000);
  if (row.access_token && row.access_expires && row.access_expires > now) {
    return row.access_token;
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.googleClientId,
      client_secret: CONFIG.googleClientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // A 400 invalid_grant means the refresh token was revoked/expired — re-run /auth/start.
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const t = (await res.json()) as { access_token: string; expires_in: number };
  db.prepare(`UPDATE oauth SET access_token = ?, access_expires = ?, updated_at = ? WHERE id = 1`).run(
    t.access_token,
    now + t.expires_in - 60,
    Date.now(),
  );
  return t.access_token;
}

export function isAuthorized(): boolean {
  const row = db.prepare(`SELECT refresh_token FROM oauth WHERE id = 1`).get() as
    | Pick<OAuthRow, 'refresh_token'>
    | undefined;
  return Boolean(row?.refresh_token);
}

interface Identity {
  healthUserId?: string;
  legacyUserId?: string;
}

async function getIdentity(accessToken: string): Promise<Identity> {
  const res = await fetch(IDENTITY_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return {};
  return (await res.json()) as Identity;
}
