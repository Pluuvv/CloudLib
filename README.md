# CloudLib

CloudLib is a Quarkus-based, multi-tenant campus library service. Its MVP includes book and copy cataloging, borrowing and returns, computer reservations, visitor check-ins, and a per-tenant dashboard.

## Requirements

- JDK 21
- Docker, for building the container image
- `kubectl`, for Kubernetes deployment

## Run locally

Set `DB_PASSWORD` in your local environment and make a PostgreSQL database available at `localhost:5432` with database/user `cloudlib`. Flyway applies the schema and seed data at startup. Keep the password in a local secret store or environment, not in the repository.

```powershell
.\mvnw.cmd quarkus:dev
```

Run the automated tests with:

```powershell
.\mvnw.cmd test
```

## Build the container

```powershell
docker build -t cloudlib:1.0.0 .
```

The image uses a multi-stage Java 21 build and runs as the non-root UID 185.

## Deploy to Kubernetes

Create the namespace and runtime Secret before applying the Kustomize resources. Supply the same database password to the application and PostgreSQL; do not commit it or put it in a manifest.
For a k3d cluster, import the built image with `k3d image import cloudlib:1.0.0 -c <cluster-name>` before deploying. Docker Desktop Kubernetes can use the local Docker image directly.

```powershell
kubectl create namespace cloudlib --dry-run=client -o yaml | kubectl apply -f -
kubectl -n cloudlib create secret generic cloudlib-secret `
  --from-literal=DB_PASSWORD="$env:DB_PASSWORD" `
  --from-literal=POSTGRES_PASSWORD="$env:DB_PASSWORD" `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k .\k8s
```

Verify the rollout and services:

```powershell
kubectl -n cloudlib rollout status deployment/cloudlib-app
kubectl -n cloudlib get deployments,services,ingress
```

The app Deployment has liveness, readiness, and startup probes, resource requests/limits, and two replicas. The Ingress host is `cloudlib.local`; configure local DNS or a hosts entry to reach it.

## Evidence and milestone scope

The milestone evidence reports are in [`docs/evidence`](docs/evidence). They describe the tested M2 workflows and the M3 container/Kubernetes baseline, including known limitations.

## API overview

Tenant-scoped requests use the `X-Tenant` header. The API includes:

- `GET/POST /books`, `GET/POST /books/copies`
- `POST /loans`, `POST /loans/return`, `GET /loans/active`, `GET /loans/history`
- `GET/POST /computers`, `GET/POST /computers/reservations`
- `GET/POST /attendance`, `POST /attendance/checkin`
- `GET /dashboard/summary`
