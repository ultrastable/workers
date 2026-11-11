FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 ULTRASTABLE_DB=/data/ultrastable.db PORT=8080
WORKDIR /app
COPY pyproject.toml ./
COPY ultrastable ./ultrastable
RUN pip install --no-cache-dir . && useradd -m app && mkdir /data && chown app /data
USER app
EXPOSE 8080
# Cloud Scheduler (or cron) POSTs /tick; --auto-tick N makes the container self-driving instead.
CMD ["python", "-m", "ultrastable", "serve", "--seed-demo"]
