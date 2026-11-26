#!/usr/bin/env bash
set -euo pipefail

# Automated Google Cloud Run Deployment Script (1000m / 1 vCPU, 1 GiB RAM, Upstash Redis backend)
# Supports isolated staging tests via DEPLOY_ENV=staging (uses iluo-staging-* secrets & service name)
# and automatically falls back to `gcloud run deploy --source .` when local Docker is unavailable.
#
# Usage:
#   Production: GCP_PROJECT_ID=your-project bash deploy-cloudrun.sh
#   Staging:    DEPLOY_ENV=staging GCP_PROJECT_ID=your-project bash deploy-cloudrun.sh

if [ ! -f "Dockerfile" ] || [ ! -f "package.json" ]; then
  echo "ERROR: Run this script from inside the project directory containing Dockerfile and package.json." >&2
  exit 1
fi

if [ -z "${GCP_PROJECT_ID:-}" ]; then
  echo "ERROR: Set GCP_PROJECT_ID to a GCP project with active Billing enabled." >&2
  echo "Example: DEPLOY_ENV=staging GCP_PROJECT_ID=my-billing-project bash deploy-cloudrun.sh" >&2
  exit 1
fi

DEPLOY_ENV="${DEPLOY_ENV:-production}"
RUN_PROJECT="${GCP_PROJECT_ID}"
REGION="${CLOUD_RUN_REGION:-asia-southeast1}"

if [ "${DEPLOY_ENV}" = "staging" ]; then
  SERVICE_NAME="${CLOUD_RUN_SERVICE:-iluo-skill-portal-staging}"
  SECRET_PREFIX="${SECRET_PREFIX:-iluo-staging}"
  FAIL_CLOSED_STORAGE="${FAIL_CLOSED_STORAGE:-true}"
  FAIL_CLOSED_AUTH="${FAIL_CLOSED_AUTH:-true}"
else
  SERVICE_NAME="${CLOUD_RUN_SERVICE:-iluo-skill-portal}"
  SECRET_PREFIX="${SECRET_PREFIX:-iluo}"
  FAIL_CLOSED_STORAGE="${FAIL_CLOSED_STORAGE:-false}"
  FAIL_CLOSED_AUTH="${FAIL_CLOSED_AUTH:-false}"
fi

AR_REPO="${AR_REPO:-iluo-portal}"
CLOUD_RUN_CPU="1"
CLOUD_RUN_MEMORY="${CLOUD_RUN_MEMORY:-1Gi}"
CLOUD_RUN_CONCURRENCY="${CLOUD_RUN_CONCURRENCY:-40}"
ADMIN_EMAIL="${ADMIN_EMAIL:-reubengeoffrey16@gmail.com}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

echo "==> Environment: ${DEPLOY_ENV} | Service: ${SERVICE_NAME} | Secret Prefix: ${SECRET_PREFIX}"
echo "==> Target Cloud Run Project: ${RUN_PROJECT} (${REGION})"
gcloud config set project "${RUN_PROJECT}" >/dev/null

echo "==> Enabling required Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "${RUN_PROJECT}" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Ensuring Cloud Run runtime SA (${RUNTIME_SA}) has Secret Manager access..."
gcloud projects add-iam-policy-binding "${RUN_PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet >/dev/null || true

ensure_secret_random() {
  local name="$1"
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    echo "==> Creating secret ${name} (auto-generated random value)..."
    openssl rand -base64 48 | gcloud secrets create "${name}" --data-file=-
  else
    echo "==> Secret ${name} already exists (reusing)."
  fi
}

ensure_secret_prompt() {
  local name="$1"
  local prompt_msg="$2"
  local env_default="${3:-}"
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    local val="${env_default}"
    if [ -z "${val}" ]; then
      read -r -s -p "${prompt_msg}: " val
      echo ""
    fi
    if [ -z "${val}" ]; then
      echo "ERROR: ${name} cannot be empty." >&2
      exit 1
    fi
    printf '%s' "${val}" | gcloud secrets create "${name}" --data-file=-
  else
    echo "==> Secret ${name} already exists (reusing)."
  fi
}

SECRET_SESSION="${SECRET_PREFIX}-session-secret"
SECRET_REDIS_URL="${SECRET_PREFIX}-redis-url"
SECRET_REDIS_TOKEN="${SECRET_PREFIX}-redis-token"
SECRET_ADMIN_PW="${SECRET_PREFIX}-admin-password"

ensure_secret_random "${SECRET_SESSION}"
ensure_secret_prompt "${SECRET_REDIS_URL}" "Enter ${DEPLOY_ENV} UPSTASH_REDIS_REST_URL" "${UPSTASH_REDIS_REST_URL:-}"
ensure_secret_prompt "${SECRET_REDIS_TOKEN}" "Enter ${DEPLOY_ENV} UPSTASH_REDIS_REST_TOKEN" "${UPSTASH_REDIS_REST_TOKEN:-}"
ensure_secret_prompt "${SECRET_ADMIN_PW}" "Choose ${DEPLOY_ENV} Admin portal password for ${ADMIN_USERNAME}" "${ADMIN_PASSWORD:-}"

ENV_VARS="NODE_ENV=production,UV_THREADPOOL_SIZE=2,NODE_OPTIONS=--max-old-space-size=512,FAIL_CLOSED_STORAGE=${FAIL_CLOSED_STORAGE},FAIL_CLOSED_AUTH=${FAIL_CLOSED_AUTH},ADMIN_EMAIL=${ADMIN_EMAIL},ADMIN_USERNAME=${ADMIN_USERNAME}"
SECRETS_MAP="SESSION_SECRET=${SECRET_SESSION}:latest,UPSTASH_REDIS_REST_URL=${SECRET_REDIS_URL}:latest,UPSTASH_REDIS_REST_TOKEN=${SECRET_REDIS_TOKEN}:latest,ADMIN_PASSWORD=${SECRET_ADMIN_PW}:latest"

if [ "${USE_SOURCE_DEPLOY:-false}" != "true" ] && command -v docker >/dev/null 2>&1; then
  IMAGE_URI="${REGION}-docker.pkg.dev/${RUN_PROJECT}/${AR_REPO}/${SERVICE_NAME}:latest"
  echo "==> Preparing Artifact Registry repository (${AR_REPO})..."
  if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
    gcloud artifacts repositories create "${AR_REPO}" \
      --repository-format=docker \
      --location="${REGION}"
  fi

  echo "==> Building and pushing Docker image (${IMAGE_URI})..."
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  docker build -t "${IMAGE_URI}" .
  docker push "${IMAGE_URI}"

  echo "==> Deploying ${SERVICE_NAME} via container image..."
  gcloud run deploy "${SERVICE_NAME}" \
    --image "${IMAGE_URI}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --port 8080 \
    --cpu "${CLOUD_RUN_CPU}" \
    --memory "${CLOUD_RUN_MEMORY}" \
    --min-instances 0 \
    --max-instances 3 \
    --concurrency "${CLOUD_RUN_CONCURRENCY}" \
    --timeout 120 \
    --set-env-vars "${ENV_VARS}" \
    --set-secrets "${SECRETS_MAP}"
else
  echo "==> Deploying ${SERVICE_NAME} directly from Dockerfile source (--source .)..."
  gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --port 8080 \
    --cpu "${CLOUD_RUN_CPU}" \
    --memory "${CLOUD_RUN_MEMORY}" \
    --min-instances 0 \
    --max-instances 3 \
    --concurrency "${CLOUD_RUN_CONCURRENCY}" \
    --timeout 120 \
    --set-env-vars "${ENV_VARS}" \
    --set-secrets "${SECRETS_MAP}"
fi

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(status.url)')"

echo "==> Updating ALLOWED_ORIGINS to ${SERVICE_URL}..."
gcloud run services update "${SERVICE_NAME}" \
  --region "${REGION}" \
  --update-env-vars "ALLOWED_ORIGINS=${SERVICE_URL}" >/dev/null

echo ""
echo "=================================================================="
echo "Deployment complete!"
echo "Management Portal : ${SERVICE_URL}/"
echo "Employee Portal   : ${SERVICE_URL}/employee"
echo "Database Backend  : Upstash Redis REST"
echo "=================================================================="
