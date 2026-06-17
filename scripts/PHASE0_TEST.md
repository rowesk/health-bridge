# Phase 0 — Prove your Fitbit Air data is reachable (before any infra)

Goal: confirm the Google Health API actually returns **HRV** and **sleep** for your
account, and capture the **real field names**, before deploying anything.

## A. Get a temporary access token

Easiest: **Google OAuth 2.0 Playground** (https://developers.google.com/oauthplayground).

1. Click the gear (top right) → tick **Use your own OAuth credentials** → paste your
   Client ID + Secret (from spec §3). In the Cloud console, add
   `https://developers.google.com/oauthplayground` as an authorized redirect URI.
2. In "Step 1", paste these scopes (read-only) and click **Authorize APIs**:
   ```
   https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
   https://www.googleapis.com/auth/googlehealth.sleep.readonly
   https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
   ```
3. Sign in with the Google account that owns the Air; approve (click through the
   "unverified app" screen if shown).
4. "Step 2" → **Exchange authorization code for tokens**. Copy the **access token**.

## B. Hit the API (replace ACCESS_TOKEN)

```bash
TOKEN="ACCESS_TOKEN"
BASE="https://health.googleapis.com/v4/users/me"

# Identity (sanity check auth works)
curl -s "$BASE/identity" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq

# Daily HRV — last ~7 days (THE important one for Bevel)
curl -s "$BASE/dataTypes/daily-heart-rate-variability/dataPoints?filter=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("daily_heart_rate_variability.interval.civil_start_time >= \"2026-06-09T00:00:00\""))')" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq

# Resting HR
curl -s "$BASE/dataTypes/daily-resting-heart-rate/dataPoints" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq '.dataPoints[0]'

# SpO2
curl -s "$BASE/dataTypes/daily-oxygen-saturation/dataPoints" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq '.dataPoints[0]'

# Respiratory rate
curl -s "$BASE/dataTypes/daily-respiratory-rate/dataPoints" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq '.dataPoints[0]'

# Sleep (with stages) via reconcile
curl -s "$BASE/dataTypes/sleep/dataPoints:reconcile?dataSourceFamily=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("users/me/dataSourceFamilies/google-wearables"))')&filter=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("sleep.interval.civil_end_time >= \"2026-06-09\""))')" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq '.dataPoints[0]'

# Steps
curl -s "$BASE/dataTypes/steps/dataPoints?filter=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("steps.interval.civil_start_time >= \"2026-06-15T00:00:00\""))')" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq '.dataPoints[0]'
```

## C. Record the real field names

For each response, note the exact path to the **numeric value** and the **date/time**,
then reconcile against the `[VERIFY]` markers in `src/mapping.ts`. Examples to confirm:

| Metric | Expected value path in `mapping.ts` | Confirm actual |
|---|---|---|
| Daily HRV | `dailyHeartRateVariability.rmssdMilliseconds` | ? |
| Resting HR | `dailyRestingHeartRate.bpm` | ? |
| SpO2 | `dailyOxygenSaturation.percentage` | ? |
| Respiratory rate | `respiratoryRateSleepSummary.breathsPerMinute` | ? |
| Distance | `distance.lengthMillimeters` | ? |
| Sleep stages | `sleep.stages[].{startTime,endTime,type}` | ✅ (confirmed in docs) |

Update `mapping.ts` `firstNum(...)` candidate lists if any differ. The `firstNum` helper
already tries several common names, so small differences may "just work" — but verify.

## D. Decision gate

If HRV + sleep return real numbers here, the whole pipeline is viable — proceed to deploy.
If HRV is empty, check that the Air has synced in the Google Health app and that Premium
(if required for HRV) is active on the account.
