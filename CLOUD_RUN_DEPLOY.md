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

## Option B: Deploy to Google Cloud Run (1000m / 1 vCPU, 1 GiB RAM, `port 8080`)

Requires a GCP project with **active Billing enabled** and permissions to use Cloud Run, Artifact Registry, and Secret Manager.

> **1 vCPU (`1000m`) Profile:** Both `deploy-cloudrun.sh` and `service.yaml` pin container limits strictly to `cpu: 1000m` (`1 vCPU`), `memory: 1Gi`, `containerConcurrency: 40`, `UV_THREADPOOL_SIZE=2`, and `PORT=8080` so the service stays comfortably under a `1500m` project ceiling.

### 1. Run the Automated Deployment Script

From inside the project directory (containing `Dockerfile`, `service.yaml`, and `package.json`):

```bash
GCP_PROJECT_ID=your-billing-enabled-project bash deploy-cloudrun.sh
```

---

## Verification Checklist After Deploy

1. `GET https://<DEPLOY_URL>/` returns `200 OK` (Management Portal).
2. `GET https://<DEPLOY_URL>/employee` returns `200 OK` (Employee Portal).
3. `GET https://<DEPLOY_URL>/api/csrf-token` returns `200 OK` with `{ success: true }`.
4. Sign in on Management Portal (`admin` / password) and confirm employees, records, and staff settings persist in Upstash Redis.
