#!/usr/bin/env bash
# Deploy Ultrastable to Google Cloud Run with a Cloud Scheduler heartbeat.
# Usage: PROJECT=my-gcp-project REGION=us-central1 ./deploy.sh
set -euo pipefail
: "${PROJECT:?set PROJECT}"; REGION="${REGION:-us-central1}"; SVC="${SVC:-ultrastable}"
TOKEN="${ULTRASTABLE_TOKEN:-$(openssl rand -hex 24)}"
gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
printf %s "$TOKEN" | gcloud secrets create ultrastable-token --data-file=- 2>/dev/null || printf %s "$TOKEN" | gcloud secrets versions add ultrastable-token --data-file=-
# One instance: the demo-grade store is SQLite on the instance disk. Production uses the Postgres adapter (roadmap).
gcloud run deploy "$SVC" --source "$(dirname "$0")/../.." --region "$REGION" --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --set-secrets ULTRASTABLE_TOKEN=ultrastable-token:latest
URL="$(gcloud run services describe "$SVC" --region "$REGION" --format 'value(status.url)')"
gcloud scheduler jobs create http ultrastable-tick --location "$REGION" --schedule "*/10 * * * *" \
  --uri "$URL/tick" --http-method POST --headers "Authorization=Bearer $TOKEN" 2>/dev/null \
  || gcloud scheduler jobs update http ultrastable-tick --location "$REGION" --schedule "*/10 * * * *" \
       --uri "$URL/tick" --http-method POST --headers "Authorization=Bearer $TOKEN"
echo "Dashboard: $URL   (writes need: Authorization: Bearer <token in Secret Manager 'ultrastable-token'>)"
