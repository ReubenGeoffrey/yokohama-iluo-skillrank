# Deployment Guide (Redis-Only Architecture)

This guide covers deploying the **Yokohama ILUO Skill Assessment & Analytics Portal** with **Upstash Redis** as the sole persistent database and native server-side authentication (no Google Cloud SQL and no Firebase).

- **Management Portal**: `/` and `/management`
- **Employee Portal**: `/employee`
- **Database**: Upstash Redis REST (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)

---

## Option A: Deploy to Vercel (Fastest, No GCP Billing Required)

The repository already includes `vercel.json` configured for both portals and CSP headers.

1. Download/extract the project files locally or push to GitHub.
2. In your **Upstash Console**, create a Redis database and copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. In your **Vercel Project → Settings → Environment Variables**, set:
   - `NODE_ENV=production`
   - `SESSION_SECRET` (random 32+ character string, e.g., `openssl rand -base64 48`)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD` (your chosen admin password)
   - `ADMIN_EMAIL` (your HR/admin OTP email)
   - `ALLOWED_ORIGINS` (your `https://your-app.vercel.app` URL)
4. Deploy from inside the project directory:
   ```bash
   vercel --prod
   ```

---

## Option B: Google Cloud Run Staging Test (Isolated Database — Recommended Test Setup)

Always test on a **separate Upstash Redis database** and separate Cloud Run service (`iluo-skill-portal-staging`) so production data on `yokohama-iluo-portal.vercel.app` is untouched.

### Step 1: Create an Isolated Staging Redis Database
1. Open [Upstash Console](https://console.upstash.com/) and click **Create Database** (e.g. `iluo-staging-db`).
2. Copy the new staging **REST URL** (`UPSTASH_REDIS_REST_URL`) and **Read-Write REST Token** (`UPSTASH_REDIS_REST_TOKEN`).

### Step 2: Run Automated Staging Deploy (Cloud Shell or Local Bash)
From inside the project directory (see `.env.staging.example` and `service.staging.yaml`):

```bash
DEPLOY_ENV=staging GCP_PROJECT_ID=your-billing-enabled-project bash deploy-cloudrun.sh
```

What `DEPLOY_ENV=staging` does automatically:
1. Creates isolated GCP secrets prefixed with `iluo-staging-*` (`iluo-staging-session-secret`, `iluo-staging-redis-url`, `iluo-staging-redis-token`, `iluo-staging-admin-password`).
2. Sets `FAIL_CLOSED_STORAGE=true` and `FAIL_CLOSED_AUTH=true` so staging refuses to silently fall back if Redis secrets are wrong.
3. Builds from `Dockerfile` (using local `docker` if available, or `gcloud run deploy --source .` directly in Google Cloud Shell) and deploys `iluo-skill-portal-staging` (`1 vCPU`, `1 GiB` RAM, port `8080`).

---

## Option C: Google AI Studio Full-Stack Build Setup (With Isolated Staging DB)

> **Important:** Because `server.js` runs Express REST endpoints, authentication, and Redis persistence, AI Studio must run the **Full-Stack Node runtime** (`node server.js`), not a browser-only static HTML preview.

1. **Push Safely to GitHub:**
   - Initialize/push this directory to a GitHub repo. `.gitignore` already excludes `.env`, `.env.local`, `audit_logs*.json`, `custom_*.json`, `assessment_records*.json`, `ojt_evaluations*.json`, and `dist/`.
2. **Import into Google AI Studio (`aistudio.google.com`):**
   - Open **Build** -> click **+** -> **Import from GitHub** and select your repository (`metadata.json` is already included).
3. **Add Isolated Staging Secrets in AI Studio:**
   - Refer to `.env.staging.example` and configure server-side secrets for your **staging** Upstash DB (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `NODE_ENV=production`, `PORT=8080`). Never reuse production Redis keys in test prompts/workspaces.
4. **Deploy to Cloud Run from AI Studio / Verify Health:**
   - Check `GET https://<STAGING_URL>/api/health` -> verify `"provider": "upstash-redis"`, `"connected": true`, `"writable": true`.
   - Open **HR Login -> Database** in the portal sidebar to verify staging keystore initialization (`Seeded` & live ping).

---

## Option D: Production Cloud Run Deploy (1000m / 1 vCPU, 1 GiB RAM, `port 8080`)

Requires a GCP project with **active Billing enabled** and permissions to use Cloud Run, Artifact Registry, Secret Manager, and Cloud Build.

> **1 vCPU (`1000m`) Profile:** `deploy-cloudrun.sh`, `service.yaml`, and `service.staging.yaml` pin container limits strictly to `cpu: 1000m` (`1 vCPU`), `memory: 1Gi`, `containerConcurrency: 40`, `UV_THREADPOOL_SIZE=2`, and `PORT=8080` so the service stays comfortably under a `1500m` project ceiling.

```bash
GCP_PROJECT_ID=your-billing-enabled-project bash deploy-cloudrun.sh
```

---

## Verification Checklist After Deploy

1. `GET https://<DEPLOY_URL>/` returns `200 OK` (Management Portal).
2. `GET https://<DEPLOY_URL>/employee` returns `200 OK` (Employee Portal).
3. `GET https://<DEPLOY_URL>/api/csrf-token` returns `200 OK` with `{ success: true }`.
4. Sign in on Management Portal (`admin` / password) and confirm employees, records, and staff settings persist in Upstash Redis.
