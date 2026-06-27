# Google OAuth Production Checklist

Use this checklist to move Health Bridge out of Google OAuth testing mode and stop
7-day refresh-token expiry.

## Public URLs

After deploying this build, these public pages should return HTTP 200:

- App homepage: `https://googlehealth.rowesk.cloud/`
- Privacy policy: `https://googlehealth.rowesk.cloud/privacy`
- Terms of service: `https://googlehealth.rowesk.cloud/terms`

The OAuth callback URL remains:

- Authorized redirect URI: `https://googlehealth.rowesk.cloud/auth/callback`

## Google Cloud Fields

Project: `health-bridge-499615`

In Google Cloud Auth Platform:

1. Open **Audience**.
2. Confirm the app is configured as an external app.
3. Publish the app to **In production**.

In **Branding** or the equivalent app information page, use:

- App name: `Health Bridge`
- App homepage: `https://googlehealth.rowesk.cloud/`
- Privacy policy URL: `https://googlehealth.rowesk.cloud/privacy`
- Terms of service URL: `https://googlehealth.rowesk.cloud/terms`
- Authorized domain: `rowesk.cloud`

In **Clients**, open the Web application client and confirm:

- Authorized redirect URI: `https://googlehealth.rowesk.cloud/auth/callback`

## Required Scopes

The deployed app currently requests:

- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`

## Reauthorize

After publishing, open the live backend auth URL:

```text
https://googlehealth.rowesk.cloud/auth/start?admin=YOUR_ADMIN_TOKEN
```

Sign in with the Google account that owns the Fitbit / Google Health data and
accept the requested scopes. The callback should show "You are connected."

## Backfill

Run a manual sync:

```bash
curl -X POST https://googlehealth.rowesk.cloud/sync \
  -H "Authorization: Bearer YOUR_SHORTCUT_TOKEN"
```

Then run the iPhone Shortcut manually so it calls `/export`, writes samples into
Apple Health, and calls `/ack`.

## Verify

Check public pages:

```bash
curl -I https://googlehealth.rowesk.cloud/
curl -I https://googlehealth.rowesk.cloud/privacy
curl -I https://googlehealth.rowesk.cloud/terms
```

Check auth state:

```bash
curl https://googlehealth.rowesk.cloud/healthz
```

Expected:

```json
{"ok":true,"authorized":true}
```

On the server, confirm samples exist after June 24:

```bash
sqlite3 -header -column /var/lib/docker/volumes/home-googlehealth-741c52-data/_data/health-bridge.db '
SELECT civil_date, COUNT(*) AS total, SUM(acked_at IS NULL) AS unacked
FROM samples
WHERE civil_date >= "2026-06-24"
GROUP BY civil_date
ORDER BY civil_date;
'
```

