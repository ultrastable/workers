# Deploy on Google Cloud

Prereqs: a GCP project with billing, `gcloud` signed in, this repo checked out.

```bash
PROJECT=my-project REGION=us-central1 ./deploy/gcp/deploy.sh
```

What it does: enables Cloud Run, Cloud Scheduler, Secret Manager and Artifact Registry; stores a generated bearer token in Secret Manager; deploys the container to Cloud Run (min=max=1 instance); creates a Cloud Scheduler job that `POST`s `/tick` every 10 minutes with the token; prints the dashboard URL.

Operating notes
* The dashboard is read-only without the token; gate resolution and item creation need it (`?token=` on the dashboard URL).
* Storage is the instance's SQLite file: demo-grade. Move to Cloud SQL (Postgres) via the store adapter before real customers (roadmap).
* To use Gemini via Vertex AI as an additional model adapter: implement `Agent.do/verify` against the Vertex endpoint (roadmap; same contract as `AnthropicAgent`).
* The Dockerfile is not yet built in this repo's CI environment locally; CI builds it on every push.
