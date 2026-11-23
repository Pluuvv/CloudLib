import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
const enabled = Boolean(
  process.env.CLOUDLIB_BACKUP_TEST_PG_BIN &&
  process.env.CLOUDLIB_BACKUP_TEST_AGE &&
  process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN
);
const tool = (n) => join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN, n + (process.platform === 'win32' ? '.exe' : ''));
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
    ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '17439', '-U', 'worker_owner', '-d', db],
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
      '-h 127.0.0.1 -p 17439',
      '-w',
      'start'
    ]).status,
    0
  );
  sql(
    'CREATE ROLE fixture_app LOGIN; CREATE ROLE worker_recovery LOGIN CREATEDB CREATEROLE NOSUPERUSER; GRANT fixture_app TO worker_recovery WITH ADMIN TRUE; GRANT pg_signal_backend TO worker_recovery; GRANT EXECUTE ON FUNCTION pg_control_system() TO worker_recovery; CREATE DATABASE business_fixture; CREATE DATABASE cloudlib_recovery;'
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
    source: { host: '127.0.0.1', port: 17439, user: 'worker_owner', database: 'business_fixture' },
    recovery: {
      host: '127.0.0.1',
      port: 17439,
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
      intervalMs: 200,
      maxAttempts: 1
    })
  );
});
after(() => {
  worker?.kill();
  if (dir) run(tool('pg_ctl'), ['-D', join(dir, 'pgdata'), '-m', 'fast', '-w', 'stop']);
});
test(
  'already running independent worker restores a deleted database snapshot and reopens login',
  { skip: !enabled },
  async () => {
    worker = start();
    await until(() => logs.includes('healthy'));
    sql('DROP DATABASE cloudlib_recovery;');
    await until(
      () =>
        existsSync(join(dir, 'state', 'status.json')) &&
        JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).phase === 'restore'
    );
    const appConnection = run(
      tool('psql'),
      ['-XqAt', '-h', '127.0.0.1', '-p', '17439', '-U', 'fixture_app', '-d', 'postgres'],
      'SELECT 1;'
    );
    assert.notEqual(appConnection.status, 0);
    await until(
      () =>
        existsSync(join(dir, 'state', 'status.json')) &&
        JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).phase === 'open'
    );
    assert.equal(sql('SELECT title FROM book;', 'cloudlib_recovery'), 'Worker snapshot');
    assert.equal(sql("SELECT nextval('book_id_seq');", 'cloudlib_recovery'), '43');
    assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 't');
  }
);

test('a later deletion starts a new bounded incident after successful recovery', { skip: !enabled }, async () => {
  const previous = JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).incidentId;
  sql('DROP DATABASE cloudlib_recovery;');
  await until(() => {
    const s = JSON.parse(readFileSync(join(dir, 'state', 'status.json')));
    return s.phase === 'open' && s.incidentId !== previous;
  });
  assert.equal(sql('SELECT title FROM book;', 'cloudlib_recovery'), 'Worker snapshot');
  assert.equal(JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).attempt, 1);
});
test('existing empty database is never treated as deleted', { skip: !enabled }, async () => {
  worker.kill();
  await new Promise((r) => worker.once('close', r));
  sql('DROP DATABASE cloudlib_recovery; CREATE DATABASE cloudlib_recovery;');
  worker = start();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';", 'cloudlib_recovery'), '0');
});

test('a worker restart refuses an interrupted incident and keeps app login fenced', { skip: !enabled }, async () => {
  worker.kill();
  await new Promise((r) => worker.once('close', r));
  sql('DROP DATABASE cloudlib_recovery;');
  writeFileSync(
    join(dir, 'state', 'status.json'),
    JSON.stringify({
      formatVersion: 1,
      target: 'cloudlib_recovery',
      incidentId: 'interrupted-fixture',
      phase: 'restore',
      attempt: 1
    })
  );
  worker = start();
  await until(() => JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).code === 'INTERRUPTED');
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';"), '0');
  assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 'f');
});

test('state for another pinned target cannot authorize recovery', { skip: !enabled }, async () => {
  worker.kill();
  await new Promise((r) => worker.once('close', r));
  sql('ALTER ROLE fixture_app LOGIN;');
  writeFileSync(
    join(dir, 'state', 'status.json'),
    JSON.stringify({ formatVersion: 1, target: 'capstone', phase: 'healthy', attempt: 0 })
  );
  worker = start();
  await until(() => logs.includes('INVALID_STATE'));
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';"), '0');
  assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 't');
});

async function stopWorker() {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill();
    await new Promise((r) => worker.once('close', r));
  }
}
function resetState() {
  if (existsSync(join(dir, 'state', 'status.json'))) unlinkSync(join(dir, 'state', 'status.json'));
  logs = '';
}
test(
  'unavailable maintenance, failed authentication and wrong server never authorize database creation',
  { skip: !enabled },
  async () => {
    await stopWorker();
    const bp = join(dir, 'backup.json');
    for (const change of [{ port: 17440 }, { user: 'no_such_worker' }, { systemIdentifier: '1' }]) {
      resetState();
      writeFileSync(bp, JSON.stringify({ ...config, recovery: { ...config.recovery, ...change } }));
      worker = start();
      await until(() => logs.includes('failed'));
      await stopWorker();
      assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';"), '0');
      assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 't');
    }
    writeFileSync(bp, JSON.stringify(config));
  }
);
test(
  'two independent workers serialize one recovery and never replay over healthy snapshot',
  { skip: !enabled },
  async () => {
    resetState();
    worker = start();
    const second = start();
    try {
      await until(
        () =>
          existsSync(join(dir, 'state', 'status.json')) &&
          JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).phase === 'open'
      );
      assert.equal(sql('SELECT title FROM book;', 'cloudlib_recovery'), 'Worker snapshot');
      sql("INSERT INTO book(title) VALUES('After recovery');", 'cloudlib_recovery');
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(sql('SELECT count(*) FROM book;', 'cloudlib_recovery'), '2');
      assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery_verify';"), '0');
      assert.equal(JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).attempt, 1);
    } finally {
      second.kill();
      await new Promise((r) => second.once('close', r));
      await stopWorker();
    }
  }
);
test('killing a live recovering worker never opens unknown data after restart', { skip: !enabled }, async () => {
  sql('DROP DATABASE cloudlib_recovery;');
  resetState();
  worker = start();
  await until(
    () =>
      existsSync(join(dir, 'state', 'status.json')) &&
      JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).phase === 'restore'
  );
  worker.kill('SIGKILL');
  await new Promise((r) => worker.once('close', r));
  worker = start();
  await until(() => JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).code === 'INTERRUPTED');
  await new Promise((r) => setTimeout(r, 2500));
  await stopWorker();
  assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 'f');
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';"), '0');
  if (sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery_verify';") === '1')
    sql('DROP DATABASE cloudlib_recovery_verify WITH (FORCE);');
  sql('CREATE DATABASE cloudlib_recovery;');
});
test(
  'stale and corrupt local archives fail closed with app login fenced across restart',
  { skip: !enabled },
  async () => {
    sql('DROP DATABASE cloudlib_recovery;');
    const names = JSON.parse(
      run(process.execPath, ['reliability/backup.mjs', 'list', '--config', join(dir, 'backup.json')]).stdout
    ).backups;
    const meta = join(config.backupDir, names[0].backupId + '.json'),
      bytes = readFileSync(meta);
    for (const bad of ['stale', 'corrupt']) {
      resetState();
      sql('ALTER ROLE fixture_app LOGIN;');
      if (bad === 'stale') {
        const m = JSON.parse(bytes);
        m.snapshotAt = '2020-01-01T00:00:00Z';
        writeFileSync(meta, JSON.stringify(m));
      } else {
        writeFileSync(meta, bytes);
        writeFileSync(join(config.backupDir, names[0].archiveName), 'broken archive');
      }
      worker = start();
      await until(
        () =>
          existsSync(join(dir, 'state', 'status.json')) &&
          JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).requiresOperator === true
      );
      await stopWorker();
      worker = start();
      await new Promise((r) => setTimeout(r, 500));
      await stopWorker();
      assert.equal(
        sql("SELECT count(*) FROM pg_database WHERE datname IN ('cloudlib_recovery','cloudlib_recovery_verify');"),
        '0'
      );
      assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 'f');
      assert.equal(JSON.parse(readFileSync(join(dir, 'state', 'status.json'))).attempt, 1);
    }
  }
);
test('main target configuration is rejected before worker startup', { skip: !enabled }, () => {
  const bad = join(dir, 'bad-worker.json');
  const c = JSON.parse(readFileSync(path));
  c.target = 'capstone';
  writeFileSync(bad, JSON.stringify(c));
  const result = run(process.execPath, ['reliability/worker.mjs', '--config', bad]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).code, 'INVALID_CONFIG');
});

test(
  'maintenance outage preserves the durable interrupted incident across worker restart',
  { skip: !enabled },
  async () => {
    await stopWorker();
    mkdirSync(join(dir, 'state'), { recursive: true });
    const saved = {
      formatVersion: 1,
      target: 'cloudlib_recovery',
      phase: 'restore',
      incidentId: 'outage-fixture',
      attempt: 1
    };
    writeFileSync(join(dir, 'state', 'status.json'), JSON.stringify(saved));
    const bp = join(dir, 'backup.json');
    writeFileSync(bp, JSON.stringify({ ...config, recovery: { ...config.recovery, port: 17440 } }));
    logs = '';
    worker = start();
    await until(() => logs.includes('MAINTENANCE_UNAVAILABLE'));
    await stopWorker();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state', 'status.json'))), saved);
    writeFileSync(bp, JSON.stringify(config));
  }
);
