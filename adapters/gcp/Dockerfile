# Build from the repository root: docker build -f adapters/gcp/Dockerfile -t ultrastable-tick .
FROM node:22-slim
WORKDIR /app
COPY worker/src ./worker/src
COPY worker/migrations ./worker/migrations
COPY autonomy ./autonomy
COPY adapters ./adapters
ENV PORT=8080 ULTRASTABLE_DB=/data/ultrastable.db
CMD ["node", "--no-warnings", "adapters/gcp/server.js"]
