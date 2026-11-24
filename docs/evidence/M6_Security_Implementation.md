# Milestone 6 Evidence — Security Implementation

- **Project:** CloudLib
- **Status:** Backend OIDC/RBAC implementation and automated authorization checks completed; live Keycloak verification and vulnerability-scan evidence are pending.

## Controls implemented

| Control | Implementation | Verification |
|---|---|---|
| OIDC bearer authentication | OIDC is enabled by default for the API. The issuer, API client ID, and expected audience are configurable through environment variables. An importable realm configuration is provided at `keycloak/cloudlib-realm.json`. | Automated anonymous-request test expects HTTP 401. Live signature and issuer verification against Keycloak remains pending. |
| Role-based authorization | API methods use `@RolesAllowed` for `mahasiswa`, `petugas`, and `admin`. | Automated tests verify that students cannot create books, access the admin dashboard, or list tenants, while an admin can create books. |
| Tenant isolation | The API selects the tenant from the verified JWT `tenant` claim. A supplied legacy `X-Tenant` header is accepted only when it matches the token. | Automated tests verify header spoofing and unprovisioned tenant claims are rejected. |
| Record ownership | Student loan lists are scoped to the token's `member_ref`. Student reservation and check-in records use that claim instead of a request-body value. | Automated tests verify students see only their own loans and cannot substitute another member reference. |
| Secret handling | Database passwords remain Kubernetes Secret references and are not added to application configuration. | Manifest inspection; cluster encryption-at-rest and secret rotation are outside this code-level test. |

## Role and endpoint policy

- `mahasiswa`, `petugas`, and `admin`: read book catalog/copies and computer catalog.
- `admin`: create books/computers, view dashboard summary, and manage tenant records.
- `petugas` and `admin`: create book copies; `petugas` alone performs loan/return operations.
- `mahasiswa`: create computer reservations; reservation reads are limited to the student's own records.
- `mahasiswa` and `petugas`: check in; student identity is taken from `member_ref`.
- `petugas` and `admin`: read attendance and all tenant-scoped loan/reservation records.

## Test evidence and limitations

The automated suite uses Quarkus `@TestSecurity` identities to test endpoint authorization and trusted tenant/member attributes. The latest run passed 20 tests with no failures. This verifies application policy but does **not** substitute for a live Keycloak test of token signatures, issuer, audience, role mappers, or browser redirect configuration.

The SPA now uses Authorization Code Flow with PKCE, validates the OAuth state and OIDC nonce, and keeps access tokens in memory rather than local/session storage. The UI decodes claims only for presentation; the API is responsible for cryptographic token validation and authorization.

The student UI now records check-in directly using the authenticated identity; it no longer displays a generated mock QR. The API does not yet issue or validate short-lived, single-use QR tokens. Do not claim QR anti-replay protection based on this implementation.

The non-sensitive `/hello` endpoint and Quarkus health endpoints remain public. Tenant-scoped business endpoints require an authenticated identity and the specified role.

Before marking M6 complete, run the app with the provisioned `cloudlib` Keycloak realm, verify the role/tenant scenarios with real accounts, rescan the built image with Trivy, and attach the resulting logs/screenshots to the submission's `06-security` folder.
