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

## Local encrypted backup CLI (formatVersion 1)

The current M7 session stores encrypted business database backups in the application's `backups/` directory. This local mode requires PostgreSQL 17 tools, Node 22 or later, age/age-keygen and tar. It needs no Google, OAuth or rclone setup. A backup on the same drive cannot recover a lost drive or laptop; off-host storage is deferred. Keycloak data, PostgreSQL roles, role passwords and application configuration are outside this logical database archive.

Copy `backup.config.example.json` into ignored `reliability/.runtime/backup/config.json` and fill the empty placeholders. Use absolute paths for `backupDir` (this checkout's `backups/`), `runtimeDir` (a private working subdirectory), and `encryption.identityFile`. Pin the actual application image digest/commit. Read `recovery.systemIdentifier` using `SELECT system_identifier FROM pg_control_system();` only after independently verifying the recovery container, project, network and volume identities described above. Do not substitute the primary server identity. The source connection is read-only during backup; the recovery connection must have administrative rights to create a separate candidate database and assume the existing application role.

Create a fresh identity with `age-keygen -o <private-identity-path>` and derive its public recipient using `age-keygen -y <private-identity-path>`. Store only that public recipient in config. On Linux, restrict runtime/key directories to mode 0700 and identity/config files to 0600. On Windows, restrict the runtime/key directory ACL to the current user and SYSTEM before running; POSIX modes alone do not restrict Windows ACLs. Keep plaintext runtime outside `backups/`. An independent private-key copy is advised, handled by the user without putting the key in chat or Git. Current prepared machine credentials and identities remain private and are not required for teammates to configure their own local run.

Passwords are optional environment references (`passwordEnv`), never literal command-line arguments or config password values. Standard `PGPASSFILE` also works. Connection fields are `host`, `port`, `user`, and source `database`. Tool entries have `{ "command": "absolute-or-PATH-program", "args": [] }`; `args` are a fixed, nonsecret command prefix. Defaults in the sample use ordinary Linux/Windows binaries. Optional `source.tools.psql`/`source.tools.pg_dump` and `recovery.tools.psql`/`recovery.tools.pg_dump`/`recovery.tools.pg_restore` override global tools for endpoints in separate containers. For example, a source psql entry may be `{ "command": "docker", "args": ["exec", "-i", "-u", "postgres", "-e", "PGOPTIONS", "capstone-postgres", "psql"] }`; use its own `pg_dump` prefix too, and recovery prefixes must address only `cloudlib-recovery-postgres`. Omit `passwordEnv` for an approved local trust connection; if Docker needs a password, prefix `-e PGPASSWORD` to forward the environment value without placing it in arguments. Tool paths must never depend on the private `.scratch` directory in shared config.

```powershell
$config = (Resolve-Path reliability/.runtime/backup/config.json).Path
node --env-file=reliability/.runtime/.env reliability/backup.mjs create --config $config
node reliability/backup.mjs list --config $config
node --env-file=reliability/.runtime/.env reliability/backup.mjs restore --config $config --id <backupId> --target cloudlib_recovery_verify
```

Every command emits one JSON object on stdout. Exit 0 is `{ "formatVersion":1, "status":"ok", "command":"create|list|restore", ... }`. Exit 2 covers `USAGE`, `INVALID_CONFIG`, `UNSAFE_TARGET` or `KEY_MISMATCH`; other operational/integrity failures exit 1 with `{ "formatVersion":1, "status":"error", "code":"..." }`. Subprocess output and credentials are suppressed. Consumers must require both exit 0 and `status:ok`.

`create` returns `backup`; `list` returns `backups`, newest snapshot first, verifying each candidate's checksum, age authentication and dump readability on every invocation. It ignores incomplete/orphan archives and snapshots older than `maxAgeHours` (default/max 24). Other corruption fails the command closed. `restore` rejects an expired snapshot. Seven-day retention is independent of this freshness cutoff; a scheduler owns retention. Metadata fields are `formatVersion`, `backupId`, `logicalSource`, `snapshotAt`, `startedAt`, `endedAt`, `pgMajor`, `appImage`, `appCommit`, `schemaFingerprint`, `sizeBytes`, `sha256`, `archiveName`, `localVerifiedAt`, `localPublishedAt`. The last two timestamps separately record readback verification and final publication. There is no off-host verification field. Snapshot time, rather than dump completion time, is the RPO reference.

`create` holds an exported, read-only repeatable-read PostgreSQL snapshot shared by pg_dump, all application table row fingerprints and schema inventory. The archive includes every tenant, Flyway history, table relationships and sequence state. Because sequences are not MVCC, it rejects sequence drift observed across the dump. Detailed row hashes and sequence values are inside the age-encrypted payload; public metadata contains only the schema fingerprint. Only encrypted files are staged in `backups/`; their exclusive partial file is read back, checksum-checked, fully decrypted and inspected before same-directory atomic rename. The final JSON marker publishes the backup last. This works when `backupDir` and `runtimeDir` are separate Linux mounts. Interrupted partial/orphan files are never usable. The CLI removes its own plaintext working directory in all outcomes; an abrupt process kill can leave plaintext in the restricted runtime directory for operator cleanup.

Restore requires an explicit allowlisted candidate named `cloudlib_recovery_verify`, `cloudlib_recovery_candidate`, or `cloudlib_recovery_candidate_<suffix>`. It never overwrites an existing database, restores into `capstone`, or restores into the configured source database. The fully authenticated payload and pinned PostgreSQL 17 recovery system identifier are checked before candidate creation. It restores transactionally with exit-on-error/no-owner/no-privileges, and validates table contents, schema and sequences against the encrypted snapshot inventory. The candidate database remains owned by the recovery administrator; application objects are owned by `recovery.appRole`. That existing role must be non-superuser and distinct from the recovery administrator. The CLI does not create roles, set passwords or change their LOGIN/NOLOGIN state. A successful restore grants CONNECT to the application role only after verification; failures leave a fenced candidate and do not drop it automatically. `restore` additionally returns `target`, `restoredAt` and `verified:{tables,sequences,data:true,schema:true}`. This SQL verification does not claim HTTP/application acceptance.

The recovery worker must fence the application/Flyway and maintain its independent incident lock, call restore into the absent candidate, inspect success, then separately promote/rename and open the intended recovery database. A successful candidate restore is not permission to modify the primary database. Worker-owned LOGIN/NOLOGIN fencing is preserved by this CLI. Reprovision runtime roles and app/OIDC settings using the baseline guide before attempting authenticated circulation checks against a restored candidate.

Integration tests use an independently initialized loopback-only PG17 cluster, real age and files under `backups/<test-run>/`. Set `CLOUDLIB_BACKUP_TEST_PG_BIN`, `CLOUDLIB_BACKUP_TEST_AGE`, `CLOUDLIB_BACKUP_TEST_AGE_KEYGEN` to installed tool paths, then run `node --test reliability/tests/backup.test.mjs`. Missing tool settings skip these tests visibly; a skipped run is not acceptance evidence. They cover synthetic SQL data fidelity and fail-closed boundaries. Actual CloudLib backup, final-image authenticated circulation and RTO/RPO acceptance still require the live isolated baseline.
