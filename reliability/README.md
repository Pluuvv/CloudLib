# CloudLib recovery baseline

Run from the CloudLib application checkout on the Windows lab host. The lab image is promoted by Gitea Actions and Argo CD. The recovery app uses the same registry digest and runs on a dedicated Docker Compose project.

## Provision the local lab

1. Confirm the current application source from `origin/main`, the current Gitea application revision, and the GitOps revision Argo CD is running. The lab uses the `cloudlib-app` repository and the `overlays/dev` path in `capstone-gitops`.
2. Create `reliability/.runtime/.env` with five independent random values. Keep the directory accessible only to the lab operator and the local system account. The directory is excluded from Git and the application image build.

   ```dotenv
   CLOUDLIB_RECOVERY_OWNER_PASSWORD=
   CLOUDLIB_RECOVERY_APP_PASSWORD=
   CLOUDLIB_PETUGAS_PASSWORD=
   CLOUDLIB_MAHASISWA_PASSWORD=
   CLOUDLIB_ADMIN_PASSWORD=
   ```

3. With the lab Keycloak already running, provision a new CloudLib realm and three synthetic accounts. This command requires the locally managed Keycloak administrator credentials in the infrastructure environment file and is intended for an absent realm.

   ```powershell
   node --env-file=../../infrastructure/.env --env-file=reliability/.runtime/.env reliability/provision-keycloak.mjs
   ```

   The fixture accounts authenticate through the public frontend client using Authorization Code with S256 PKCE. The local browser issuer is `http://localhost:8081/realms/cloudlib`. The team pod reaches Keycloak at `http://keycloak:8080/realms/cloudlib`. The recovery container reaches it at `http://host.docker.internal:8081/realms/cloudlib`. Both backends require the exact browser issuer and API audience and use their internal JWKS path.

## Create and validate the recovery copy

```powershell
docker compose --env-file reliability/.runtime/.env -f reliability/compose.yaml up -d --wait postgres
node reliability/baseline.mjs clone cloudlib-recovery-postgres
```

The clone reads the complete `capstone` business database through `pg_dump` in read-only mode and streams it to an empty `cloudlib_recovery` database on PostgreSQL 17. It requires the recovery project, network, volume, and database identity. The recovery app login owns the imported app objects. Before promotion, start the candidate on the recovery copy and check Flyway validation and readiness.

Push the reviewed application revision to local Gitea `main` after validating compatibility. Keep the GitOps OIDC ConfigMap in `capstone-gitops`. Gitea builds, tests, and scans the image before promoting it. Confirm Argo CD reports the promoted revision as Synced and Healthy. From the pod image ID, obtain the digest and set `CLOUDLIB_BASELINE_IMAGE=localhost:5001/student/cloudlib-app@sha256:<digest>` in the private runtime environment file. Then start the recovery application with that digest.

```powershell
docker compose --env-file reliability/.runtime/.env -f reliability/compose.yaml up -d --wait app
node --env-file=reliability/.runtime/.env --test reliability/test/baseline-cli.test.mjs reliability/test/baseline-http.test.mjs

$env:CLOUDLIB_TEST_ORIGIN = 'http://localhost:8089'
$env:CLOUDLIB_TEST_TRANSACTIONS = '1'
node --env-file=reliability/.runtime/.env --test reliability/test/baseline-http.test.mjs
node reliability/baseline.mjs inventory cloudlib-recovery-postgres
```

The first HTTP run checks the lab without writing business records. The recovery run adds a synthetic loan and return, reservation, and visit. Keep only aggregate SQL counts, migration status, timestamps, image identifiers, and HTTP outcomes in evidence. Record the Keycloak and PostgreSQL versions in use.

The recovery PostgreSQL container uses the `cloudlib-recovery-net` network and `cloudlib-recovery-pgdata` volume. Its database owner is `cloudlib_recovery_owner` and the application uses `cloudlib_recovery_app`. PostgreSQL is reachable through the recovery network or `docker exec`. The recovery app binds to Windows loopback on port 8089.

To stop the drill without removing the recovery data, run `docker compose --env-file reliability/.runtime/.env -f reliability/compose.yaml stop`. To roll back the lab release, revert the image-promotion commit in the GitOps repository, push it to the local GitOps main branch, and verify Argo CD has restored the previous healthy revision. The primary PostgreSQL volume is outside this procedure.
