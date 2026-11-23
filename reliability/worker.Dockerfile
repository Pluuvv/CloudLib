FROM node:22-bookworm-slim AS node
FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends age ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/cloudlib
COPY reliability/backup.mjs reliability/worker.mjs ./reliability/
RUN mkdir -p /var/lib/cloudlib-worker && chown postgres:postgres /var/lib/cloudlib-worker
USER postgres
ENTRYPOINT ["node", "reliability/worker.mjs"]
CMD ["--config", "/run/cloudlib/worker.json"]
