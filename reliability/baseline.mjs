import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const main = { container: 'capstone-postgres', name: 'capstone', user: 'capstone' };
const recovery = {
  container: 'cloudlib-recovery-postgres',
  name: 'cloudlib_recovery',
  user: 'cloudlib_recovery_owner',
};
const tables = ['tenant', 'book', 'book_copy', 'loan', 'computer', 'computer_reservation', 'visitor_log'];

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Docker ' + args[0] + ' failed (exit ' + result.status + ')');
  return result.stdout.trim();
}

function psql(database, sql, readOnly = true) {
  const args = ['exec', '-i', '-u', 'postgres'];
  if (readOnly) args.push('-e', 'PGOPTIONS=-c default_transaction_read_only=on');
  args.push(database.container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', database.user, '-d', database.name);
  return docker(args, sql);
}

function verifyTarget() {
  const inspected = docker(['inspect', '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}',
    recovery.container]);
  const [project, service, mounts, networks] = inspected.split('|');
  const databaseMount = JSON.parse(mounts).find((mount) => mount.Destination === '/var/lib/postgresql/data');
  if (project !== 'cloudlib-recovery' || service !== 'postgres' ||
      databaseMount?.Type !== 'volume' || databaseMount.Name !== 'cloudlib-recovery-pgdata' ||
      Object.keys(JSON.parse(networks)).join() !== 'cloudlib-recovery-net') {
    throw new Error('Recovery target does not have the expected project, volume and isolated network');
  }
  const identity = psql(recovery, "SELECT current_database(), current_user, current_setting('server_version_num')::int / 10000;");
  if (identity !== 'cloudlib_recovery|cloudlib_recovery_owner|17') {
    throw new Error('Recovery target database, owner or PostgreSQL version does not match');
  }
}

function snapshot(database) {
  const rows = tables.map((table) => {
    const key = table === 'tenant' ? 'id' : 'tenant_id';
    return "SELECT '" + table + "' AS table_name, tenant.code AS tenant_code, count(record.id) AS rows, " +
      "md5(string_agg(to_jsonb(record)::text, ',' ORDER BY record.id)) AS fingerprint " +
      'FROM tenant LEFT JOIN ' + table + ' AS record ON record.' + key + ' = tenant.id GROUP BY tenant.code';
  }).join(' UNION ALL ');
  const sql = [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    "SET LOCAL TIME ZONE 'UTC';",
    "SELECT current_setting('server_version');",
    'SELECT * FROM (' + rows + ') AS inventory ORDER BY table_name, tenant_code;',
    'SELECT installed_rank, version, script, checksum, success FROM flyway_schema_history ORDER BY installed_rank;',
    "SELECT format('SELECT %L, last_value, is_called FROM %I.%I;', sequencename, schemaname, sequencename) " +
      "FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename \\gexec",
    'COMMIT;',
  ].join('\n');
  return psql(database, sql).split('\n').map((line) => line.trimEnd());
}

function showSnapshot(lines) {
  console.log('PostgreSQL ' + lines[0]);
  console.log('Business tables (table|tenant|count):');
  for (const table of tables) {
    const counts = lines.filter((line) => line.startsWith(table + '|'));
    if (counts.length === 0) console.log(table + '|all|0');
    for (const count of counts) console.log(count.split('|').slice(0, 3).join('|'));
  }
  console.log('Flyway (rank|version|script|checksum|success):');
  for (const migration of lines.filter((line) => /^\d+\|/.test(line))) console.log(migration);
  const sequences = lines.filter((line) => /^[a-z_]+_seq\|/.test(line));
  console.log('Sequences inspected: ' + sequences.length);
}

function waitForExit(child, operation) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not start ' + operation)));
    child.once('close', (status) => {
      if (status === 0) resolve();
      else reject(new Error(operation + ' failed (exit ' + status + ')'));
    });
  });
}

async function importDatabase() {
  const dump = spawn('docker', ['exec', '-u', 'postgres', '-e', 'PGOPTIONS=-c default_transaction_read_only=on',
    main.container, 'pg_dump', '-Fc', '-U', main.user, '-d', main.name],
  { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const restore = spawn('docker', ['exec', '-i', '-u', 'postgres', recovery.container,
    'pg_restore', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges',
    '--role=cloudlib_recovery_app', '-U', recovery.user, '-d', recovery.name],
  { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  try {
    await Promise.all([waitForExit(dump, 'pg_dump'), waitForExit(restore, 'pg_restore'),
      pipeline(dump.stdout, restore.stdin)]);
  } finally {
    if (dump.exitCode === null) dump.kill();
    if (restore.exitCode === null) restore.kill();
  }
}

async function clone() {
  verifyTarget();
  const objects = psql(recovery,
    "SELECT count(*) FROM pg_class JOIN pg_namespace ON pg_namespace.oid = relnamespace " +
    "WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%';");
  if (objects !== '0') throw new Error('Recovery database must be empty before a baseline import');
  const before = snapshot(main);
  psql(recovery, [
    '\\getenv app_password CLOUDLIB_RECOVERY_APP_PASSWORD',
    "SELECT format('CREATE ROLE cloudlib_recovery_app LOGIN PASSWORD %L', :'app_password')",
    "WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cloudlib_recovery_app') \\gexec",
    'REVOKE CONNECT ON DATABASE cloudlib_recovery FROM PUBLIC;',
    'GRANT CONNECT ON DATABASE cloudlib_recovery TO cloudlib_recovery_app;',
    'GRANT CREATE ON SCHEMA public TO cloudlib_recovery_app;',
  ].join('\n'), false);
  await importDatabase();
  const after = snapshot(recovery);
  if (before.slice(1).join('\n') !== after.slice(1).join('\n')) {
    throw new Error('Source and recovery snapshots differ in rows, migrations or sequences');
  }
  console.log('Full business database imported; row contents, Flyway and sequence state matched the source.');
  showSnapshot(after);
}

const [command, target, ...extra] = process.argv.slice(2);
if (target !== recovery.container || extra.length || !['clone', 'inventory'].includes(command)) {
  console.error('Usage: node reliability/baseline.mjs clone|inventory cloudlib-recovery-postgres (refusing non-recovery target)');
  process.exitCode = 2;
} else {
  try {
    if (command === 'clone') await clone();
    else {
      verifyTarget();
      showSnapshot(snapshot(recovery));
    }
  } catch (error) {
    console.error('Recovery baseline failed: ' + error.message);
    process.exitCode = 1;
  }
}
