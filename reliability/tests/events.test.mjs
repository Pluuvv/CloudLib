import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
const enabled = Boolean(
  process.env.CLOUDLIB_BACKUP_TEST_PG_BIN &&
  process.env.CLOUDLIB_BACKUP_TEST_AGE &&
  process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN
);
const tool = (n) =>
  join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN, n + (process.platform === 'win32' ? '.exe' : ''));
let dir,
  config,
  path,
  worker,
  logs = '';
function run(c, a, input) {
  return spawnSync(c, a, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    ...(a.includes('start') ? { stdio: 'ignore' } : {})
  });
}
function sql(s, db = 'postgres') {
  const r = run(
    tool('psql'),
    ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '18439', '-U', 'worker_owner', '-d', db],
    s
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('deadline; sanitized worker output: ' + logs);
}
function start() {
  const p = spawn(process.execPath, ['reliability/worker.mjs', '--config', path], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', (d) => (logs += d));
  p.stderr.on('data', (d) => (logs += d));
  return p;
}
before(() => {
  if (!enabled) return;
  mkdirSync(resolve('reliability/.runtime/worker/tests'), { recursive: true });
  dir = mkdtempSync(resolve('reliability/.runtime/worker/tests/pg17-'));
  assert.equal(
    run(tool('initdb'), [
      '-D',
      join(dir, 'pgdata'),
      '-U',
      'worker_owner',
      '--auth=trust',
      '--no-locale',
      '--encoding=UTF8'
    ]).status,
    0
  );
  assert.equal(
    run(tool('pg_ctl'), [
      '-D',
      join(dir, 'pgdata'),
      '-l',
      join(dir, 'postgres.log'),
      '-o',
      '-h 127.0.0.1 -p 18439 -c logging_collector=on -c log_destination=jsonlog -c log_statement=ddl -c log_directory=../logs -c log_filename=events.log -c log_rotation_age=0',
      '-w',
      'start'
    ]).status,
    0
  );
  sql(
    'CREATE ROLE fixture_denied LOGIN; CREATE ROLE fixture_app LOGIN; CREATE ROLE worker_recovery LOGIN CREATEDB CREATEROLE NOSUPERUSER; GRANT fixture_app TO worker_recovery WITH ADMIN TRUE; GRANT pg_signal_backend TO worker_recovery; GRANT EXECUTE ON FUNCTION pg_control_system() TO worker_recovery; CREATE DATABASE business_fixture; CREATE DATABASE cloudlib_recovery;'
  );
  sql(
    "CREATE TABLE book(id serial PRIMARY KEY,title text); INSERT INTO book(title) VALUES('Worker snapshot'); SELECT setval('book_id_seq',42,true);",
    'business_fixture'
  );
  const identity = join(dir, 'identity');
  assert.equal(run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-o', identity]).status, 0);
  config = {
    formatVersion: 1,
    runtimeDir: join(dir, 'backup-work'),
    backupDir: resolve('backups', basename(dir)),
    logicalSource: 'worker-fixture',
    app: { image: 'fixture:v7', commit: 'fixture' },
    source: { host: '127.0.0.1', port: 18439, user: 'worker_owner', database: 'business_fixture' },
    recovery: {
      host: '127.0.0.1',
      port: 18439,
      user: 'worker_recovery',
      systemIdentifier: sql('SELECT system_identifier FROM pg_control_system();'),
      allowedDatabases: ['cloudlib_recovery_verify'],
      appRole: 'fixture_app'
    },
    encryption: {
      identityFile: identity,
      recipient: run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-y', identity]).stdout.trim()
    },
    tools: {
      psql: { command: tool('psql') },
      pg_dump: { command: tool('pg_dump') },
      pg_restore: { command: tool('pg_restore') },
      age: { command: process.env.CLOUDLIB_BACKUP_TEST_AGE },
      age_keygen: { command: process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN },
      tar: { command: 'tar' }
    }
  };
  const bp = join(dir, 'backup.json');
  writeFileSync(bp, JSON.stringify(config));
  const b = run(process.execPath, ['reliability/backup.mjs', 'create', '--config', bp]);
  assert.equal(b.status, 0, b.stdout);
  path = join(dir, 'worker.json');
  writeFileSync(
    path,
    JSON.stringify({
      formatVersion: 1,
      backupConfig: bp,
      stateDir: join(dir, 'state'),
      target: 'cloudlib_recovery',
      candidate: 'cloudlib_recovery_verify',
      intervalMs: 60000,
      eventLogDir: join(dir, 'logs'),
      maxAttempts: 1
    })
  );
});
after(() => {
  worker?.kill();
  if (dir) run(tool('pg_ctl'), ['-D', join(dir, 'pgdata'), '-m', 'fast', '-w', 'stop']);
});
async function stopWorker() {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill();
    await new Promise((r) => worker.once('close', r));
  }
}
function status() {
  return JSON.parse(readFileSync(join(dir, 'state', 'status.json')));
}
afterEach(async () => {
  await stopWorker();
});
test(
  'real PostgreSQL DROP log triggers the shared recovery before periodic reconciliation',
  { skip: !enabled },
  async () => {
    worker = start();
    await until(() => logs.includes('healthy'));
    await new Promise((r) => setTimeout(r, 300));
    const injectedAt = new Date().toISOString();
    sql('DROP DATABASE cloudlib_recovery;');
    await until(() => existsSync(join(dir, 'state', 'status.json')) && status().phase === 'open', 15000);
    const s = status();
    assert.equal(s.triggerChannel, 'event');
    assert.ok(Date.parse(s.receivedEventAt) >= Date.parse(injectedAt));
    assert.ok(Date.parse(s.lossConfirmedAt) >= Date.parse(s.receivedEventAt));
    assert.ok(Date.parse(s.recoveryStartedAt) >= Date.parse(s.lossConfirmedAt));
    assert.ok(s.sourceEventAt);
    console.log(
      JSON.stringify({
        fixture: 'actual-sql-drop',
        injectedAt,
        triggerChannel: s.triggerChannel,
        sourceEventAt: s.sourceEventAt,
        receivedEventAt: s.receivedEventAt,
        lossConfirmedAt: s.lossConfirmedAt,
        recoveryStartedAt: s.recoveryStartedAt
      })
    );
    assert.equal(sql('SELECT title FROM book;', 'cloudlib_recovery'), 'Worker snapshot');
    assert.ok(!logs.includes('statement:'));
    await stopWorker();
  }
);
function connection(user = 'worker_owner') {
  const p = spawn(
    tool('psql'),
    ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '18439', '-U', user, '-d', 'postgres'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  p.stdin.on('error', () => {});
  p.output = '';
  p.stdout.on('data', (d) => (p.output += d));
  p.stderr.resume();
  return p;
}
function configure(change = {}) {
  const c = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...c, ...change }));
  logs = '';
}
test('early DROP candidate is followed until blocked command completes', { skip: !enabled }, async () => {
  configure();
  worker = start();
  await until(() => logs.includes('"phase":"observed"') || logs.includes('healthy'));
  const lock = connection(),
    drop = connection();
  try {
    lock.stdin.write("BEGIN; ALTER DATABASE cloudlib_recovery CONNECTION LIMIT -1; SELECT 'locked';\n");
    await until(() => lock.output.includes('locked'));
    logs = '';
    drop.stdin.write('DROP DATABASE cloudlib_recovery;\n');
    await until(() => logs.includes('"phase":"candidate"'));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';"), '1');
    lock.stdin.write('COMMIT;\n');
    const previous = status().incidentId;
    await until(() => status().phase === 'open' && status().incidentId !== previous, 15000);
    assert.equal(status().triggerChannel, 'event');
  } finally {
    lock.kill();
    drop.kill();
    await stopWorker();
  }
});
test(
  'failed unauthorized DROP and unknown or SQL-string targets never restore healthy data',
  { skip: !enabled },
  async () => {
    configure();
    worker = start();
    await until(() => logs.includes('"phase":"observed"') || logs.includes('healthy'));
    const previous = status().incidentId;
    sql("INSERT INTO book(title) VALUES('Preserve live data');", 'cloudlib_recovery');
    const denied = run(
      tool('psql'),
      [
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        '127.0.0.1',
        '-p',
        '18439',
        '-U',
        'fixture_denied',
        '-d',
        'postgres'
      ],
      'DROP DATABASE cloudlib_recovery;'
    );
    assert.notEqual(denied.status, 0);
    await until(() => logs.includes('"phase":"candidate"'));
    const duplicate = run(
      tool('psql'),
      [
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        '127.0.0.1',
        '-p',
        '18439',
        '-U',
        'fixture_denied',
        '-d',
        'postgres'
      ],
      'DROP DATABASE cloudlib_recovery;'
    );
    assert.notEqual(duplicate.status, 0);
    await new Promise((r) => setTimeout(r, 30600));
    assert.equal((logs.match(/"phase":"candidate"/g) || []).length, 1);
    logs = '';
    sql('CREATE DATABASE unknown_target;');
    sql('DROP DATABASE unknown_target;');
    sql('CREATE TABLE "DROP DATABASE cloudlib_recovery;" (id integer);');
    sql('DROP TABLE "DROP DATABASE cloudlib_recovery;";');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!logs.includes('"phase":"candidate"'));
    assert.equal(status().incidentId, previous);
    assert.equal(sql('SELECT count(*) FROM book;', 'cloudlib_recovery'), '2');
    assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery_verify';"), '0');
    assert.ok(!logs.includes('Preserve live data'));
    await stopWorker();
  }
);
test(
  'new PostgreSQL log file after rotation is consumed without duplicate recovery',
  { skip: !enabled },
  async () => {
    configure();
    worker = start();
    await until(() => logs.includes('"phase":"observed"') || logs.includes('healthy'));
    sql("ALTER SYSTEM SET log_filename='rotated.log';");
    sql('SELECT pg_reload_conf();');
    await new Promise((r) => setTimeout(r, 200));
    sql('SELECT pg_rotate_logfile();');
    await new Promise((r) => setTimeout(r, 500));
    const previous = status().incidentId;
    sql('DROP DATABASE cloudlib_recovery;');
    await until(() => status().phase === 'open' && status().incidentId !== previous, 15000);
    assert.equal(status().triggerChannel, 'event');
    const restored = status().incidentId;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(status().incidentId, restored);
    await stopWorker();
  }
);
test(
  'disconnected log reader reconciles loss and restart never replays old events over healthy data',
  { skip: !enabled },
  async () => {
    configure({ eventLogDir: join(dir, 'disconnected-logs'), intervalMs: 700 });
    worker = start();
    await until(() => logs.includes('"phase":"observed"') || logs.includes('healthy'));
    const previous = status().incidentId;
    sql('DROP DATABASE cloudlib_recovery;');
    await until(() => status().phase === 'open' && status().incidentId !== previous, 15000);
    assert.equal(status().triggerChannel, 'reconcile');
    assert.equal(status().receivedEventAt, undefined);
    await stopWorker();
    sql("INSERT INTO book(title) VALUES('After fallback');", 'cloudlib_recovery');
    configure({ eventLogDir: join(dir, 'logs'), intervalMs: 700 });
    worker = start();
    await until(() => logs.includes('"phase":"observed"') || logs.includes('healthy'));
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(sql('SELECT count(*) FROM book;', 'cloudlib_recovery'), '2');
    assert.ok(!logs.includes('"phase":"candidate"'));
    await stopWorker();
  }
);
test(
  'maintenance outage reconnects without forgetting verified data readiness',
  { skip: !enabled },
  async () => {
    configure({ intervalMs: 300, eventLogDir: join(dir, 'logs') });
    worker = start();
    await until(() => logs.includes('"phase":"observed"'));
    assert.equal(run(tool('pg_ctl'), ['-D', join(dir, 'pgdata'), '-m', 'fast', '-w', 'stop']).status, 0);
    await until(() => logs.includes('MAINTENANCE_UNAVAILABLE'));
    assert.match(readFileSync(join(dir, 'state', 'metrics.prom'), 'utf8'), /cloudlib_recovery_data_ready 0/);
    assert.equal(
      run(tool('pg_ctl'), [
        '-D',
        join(dir, 'pgdata'),
        '-l',
        join(dir, 'postgres.log'),
        '-o',
        '-h 127.0.0.1 -p 18439 -c logging_collector=on -c log_destination=jsonlog -c log_statement=ddl -c log_directory=../logs -c log_filename=network.log -c log_rotation_age=0',
        '-w',
        'start'
      ]).status,
      0
    );
    logs = '';
    await until(() => logs.includes('"phase":"observed"'));
    assert.match(readFileSync(join(dir, 'state', 'metrics.prom'), 'utf8'), /cloudlib_recovery_data_ready 1/);
    const previous = status().incidentId;
    sql('DROP DATABASE cloudlib_recovery;');
    await until(() => status().phase === 'open' && status().incidentId !== previous, 15000);
    assert.equal(sql('SELECT title FROM book;', 'cloudlib_recovery'), 'Worker snapshot');
  }
);
