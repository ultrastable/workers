#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
# Deploy the Ultrastable tick to Google Cloud. NOT YET RUN against a real project (needs a GCP project and billing; owner step).
# Usage: PROJECT=my-proj REGION=us-central1 ORG=acme bash adapters/gcp/deploy.sh   (from the repository root)
set -euo pipefail
: "${PROJECT:?}" "${REGION:=us-central1}" "${ORG:=demo}"
SVC=ultrastable-tick; BUCKET="${PROJECT}-ultrastable-${ORG}"; SA="${SVC}@${PROJECT}.iam.gserviceaccount.com"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com storage.googleapis.com --project "$PROJECT"
gcloud storage buckets create "gs://${BUCKET}" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access || true
gcloud iam service-accounts create "$SVC" --project "$PROJECT" || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${SA}" --role roles/storage.objectAdmin
head -c 32 /dev/urandom | base64 | gcloud secrets create ultrastable-tick-token --data-file=- --project "$PROJECT" || true
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" --source . --no-allow-unauthenticated \
  --service-account "$SA" --max-instances 1 --min-instances 0 \
  --set-env-vars "ULTRASTABLE_ORG=${ORG}" --set-secrets "TICK_TOKEN=ultrastable-tick-token:latest" \
  --add-volume "name=data,type=cloud-storage,bucket=${BUCKET}" --add-volume-mount "volume=data,mount-path=/data"
URL=$(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret ultrastable-tick-token --project "$PROJECT")
# Cloud Scheduler: every 10 minutes, with the shared token and a Google identity token so Cloud Run IAM also passes.
gcloud scheduler jobs create http ultrastable-tick --project "$PROJECT" --location "$REGION" --schedule "*/10 * * * *" \
  --uri "${URL}/tick" --http-method POST --headers "X-Tick-Token=${TOKEN}" \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" || true
echo "deployed ${URL}; health: curl -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" ${URL}/health"
