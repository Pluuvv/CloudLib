# CloudLib

CloudLib is a Quarkus-based, multi-tenant campus library service. Its MVP includes book and copy cataloging, borrowing and returns, computer reservations, visitor check-ins, and a per-tenant dashboard.

## Requirements

- JDK 21
- Docker, for building the container image
- `kubectl`, for Kubernetes deployment

## Run locally

Set `DB_PASSWORD` in your local environment and make a PostgreSQL database available at `localhost:5432` with database/user `cloudlib`. Start the Keycloak service from the infrastructure workspace and configure the `cloudlib` realm as described under [OIDC and role configuration](#oidc-and-role-configuration). Flyway applies the schema and seed data at startup. Keep passwords and client secrets in a local secret store or environment, not in the repository.

```powershell
$env:OIDC_AUTH_SERVER_URL = "http://localhost:8081/realms/cloudlib"
$env:OIDC_API_CLIENT_ID = "cloudlib-api"
$env:OIDC_API_AUDIENCE = "cloudlib-api"
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

## CI and lab delivery

GitHub Actions runs Maven `verify` with Java 21 for pull requests targeting `main` and pushes to `main`. To deploy in the course lab, push the reviewed application commit to `main` in the local Gitea `cloudlib-app` repository. Gitea Actions tests and builds the image, scans it with Trivy, and stops before publishing if it finds any `CRITICAL` vulnerabilities.

After the scan passes, Gitea publishes the image tagged with the application commit SHA and updates `overlays/dev/kustomization.yaml` in `capstone-gitops`. Verify that Argo CD reports `Synced` and `Healthy` for the GitOps revision and that the [lab readiness endpoint](http://cloudlib.localhost:8088/q/health/ready) returns `UP`.

## Standalone Kubernetes deployment

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

The app Deployment has liveness, readiness, and startup probes and resource requests/limits. The HPA scales it between 1 and 5 replicas at a CPU target of 70% of requests; a working metrics-server is required. The Ingress host is `cloudlib.local`; configure local DNS or a hosts entry to reach it.

## Autoscaling and load test

The reusable HPA is in [`k8s/autoscaling/base`](k8s/autoscaling/base); standalone
`kubectl apply -k k8s` renders it in namespace `cloudlib`. The lab overlay in
[`k8s/autoscaling/lab`](k8s/autoscaling/lab) renders only the HPA in namespace
`capstone`. [`k8s/argocd/application.yaml`](k8s/argocd/application.yaml) contains the
team lab Application configuration that lets HPA control replicas during Argo CD sync.
The lab still deploys manifests from the separate `capstone-gitops` repository.

From the application repository, test the existing team lab with Python 3.10+:

```powershell
py -B scripts/test-autoscaling.py --duration 300 --concurrency 32 --cooldown 420
```

Results are saved under `scripts/.runtime/autoscaling/` and ignored by Git.
See [the autoscaling guide](docs/autoscaling.md) for setup, GitOps migration,
standalone parameters, prerequisites, and interpreting results.

## OIDC and role configuration

The API uses OIDC bearer-token authentication. It validates tokens against the configured Keycloak realm, requires the `cloudlib-api` audience, and maps realm roles from `realm_access/roles`. The SPA uses Authorization Code Flow with PKCE, checks selected OIDC claims to drive the UI, and keeps tokens in memory only; it never asks for or stores a user's Keycloak password. The backend remains authoritative for token validation and authorization; hiding a UI control is not an authorization check.

Configure the Keycloak `cloudlib` realm with:

- Realm roles `mahasiswa`, `petugas`, and `admin`.
- A public OIDC client `cloudlib-frontend` with Standard Flow enabled, Direct Access Grants disabled, and PKCE method `S256`.
- Exact redirect URIs and web origins for the CloudLib UI origin, such as `http://localhost:8080/*` and `http://localhost:8080`. Use HTTPS for non-local environments.
- An access-token audience mapper that adds `cloudlib-api` to the `aud` claim.
- User-attribute protocol mappers that add `tenant` and, for student accounts, `member_ref` to the access token. Assign each account only the role and tenant it needs.

An importable starting configuration is provided in [`keycloak/cloudlib-realm.json`](keycloak/cloudlib-realm.json). Start the infrastructure workspace's Keycloak service, import this realm from the Keycloak Admin Console, then create the required test users and set their `tenant` and `member_ref` user attributes. The export contains no user passwords. For `cloudlib.local` or another HTTPS origin, update the client's redirect URI and web origin in the realm and the UI issuer meta tag to match the actual deployment.

The local UI issuer and client ID are configured in the `cloudlib-oidc-issuer` and `cloudlib-oidc-client-id` meta tags in `src/main/resources/META-INF/resources/index.html`. The issuer must match Keycloak's canonical realm issuer. In the team lab, the GitOps ConfigMap pins the browser issuer at `http://localhost:8081/realms/cloudlib` and fetches signing keys through the internal Keycloak address. For standalone Kubernetes, update `k8s/01-configmap.yaml` for the actual network. See the [recovery baseline procedure](reliability/README.md) for the local lab and recovery topology.

The browser requires HTTPS or a localhost origin for Web Crypto and PKCE. Use a localhost port-forward for local HTTP testing, or configure HTTPS for a custom hostname such as `cloudlib.local`.

The local lab accounts use `mhs_upn` (mahasiswa), `petugas_upn` (petugas), and
`admin_upn` (application admin). The recovery provisioning and login checks use
the same usernames. Passwords are supplied through `CLOUDLIB_MAHASISWA_PASSWORD`,
`CLOUDLIB_PETUGAS_PASSWORD`, and `CLOUDLIB_ADMIN_PASSWORD` in the private local
environment; they are not stored in Git. Renaming an existing lab account keeps
its password, role, tenant and member identity so existing records remain accessible.

Tenant scope comes from the verified token's `tenant` claim. If a request includes `X-Tenant`, the API only accepts it when it matches the token claim; it is never used to select another tenant. Student loan/reservation/check-in ownership is taken from `member_ref`, not from a request body. Staff-entered member references remain available only on staff-authorized workflows. The student UI records check-in directly using the authenticated identity; server-issued QR tickets and single-use QR validation are not implemented.

## Evidence and milestone scope

The milestone evidence reports are in [`docs/evidence`](docs/evidence). M2-M5 reports preserve the evidence and limitations observed at their original test dates. M6 implementation notes and automated authorization tests are recorded in `docs/evidence/M6_Security_Implementation.md`; live Keycloak verification and vulnerability-scan evidence must be captured in the target lab before claiming the complete security milestone.

## API overview

Tenant-scoped requests use the tenant claim from the authenticated bearer token. `X-Tenant`, when supplied by older clients, is checked against that claim. The API includes:

- `GET/POST /books`, `GET/POST /books/copies`
- `POST /loans`, `POST /loans/return`, `GET /loans/active`, `GET /loans/history`
- `GET/POST /computers`, `GET/POST /computers/reservations`
- `GET/POST /attendance`, `POST /attendance/checkin`
- `GET /dashboard/summary`
