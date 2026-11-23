import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, basename } from 'node:path';

const enabled = Boolean(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN && process.env.CLOUDLIB_BACKUP_TEST_AGE && process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN);
const root = resolve('reliability/.runtime/backup/schedule-tests');
let directory, configPath, config;
let backupId;
const tool = (name) => join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : ''));
function run(command, args, input) {
  return spawnSync(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000, ...(args.includes('start') ? { stdio: 'ignore' } : {}) });
}
function sql(text, database = 'postgres') {
  const result = run(tool('psql'), ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '19439', '-U', 'backup_test_owner', '-d', database], text);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cli(command, ...args) {
  const result = run(process.execPath, ['reliability/backup.mjs', command, '--config', configPath, ...args]);
  return { ...result, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
}
before(() => {
  if (!enabled) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  directory = mkdtempSync(join(root, 'pg17-'));
  const initialized = run(tool('initdb'), ['-D', join(directory, 'pgdata'), '-U', 'backup_test_owner', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const started = run(tool('pg_ctl'), ['-D', join(directory, 'pgdata'), '-l', join(directory, 'postgres.log'), '-o', '-h 127.0.0.1 -p 19439', '-w', 'start']);
  assert.equal(started.status, 0, started.stderr);
  sql('CREATE DATABASE business_fixture; CREATE ROLE fixture_app;');
  sql(`CREATE TABLE tenant(id integer PRIMARY KEY, code text UNIQUE);
    CREATE TABLE book(id serial PRIMARY KEY, tenant_id integer REFERENCES tenant, title text);
    CREATE TABLE loan(id serial PRIMARY KEY, book_id integer REFERENCES book, returned boolean);
    CREATE TABLE flyway_schema_history(installed_rank integer PRIMARY KEY, version text, success boolean);
    CREATE SCHEMA pgdata;
    CREATE TABLE pgdata.audit(id bigserial PRIMARY KEY, note text);
    INSERT INTO pgdata.audit(note) VALUES('Outside public');
    SELECT setval('pgdata.audit_id_seq',73,true);
    INSERT INTO tenant VALUES(1,'north'),(2,'south');
    INSERT INTO book(tenant_id,title) VALUES(1,'Before snapshot'),(2,'Other tenant');
    INSERT INTO loan(book_id,returned) VALUES(1,false);
    INSERT INTO flyway_schema_history VALUES(1,'7',true);
    SELECT setval('book_id_seq',42,true);`, 'business_fixture');
  const key = run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-o', join(directory, 'identity')]);
  assert.equal(key.status, 0, key.stderr);
  const recipient = run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-y', join(directory, 'identity')]).stdout.trim();
  const systemIdentifier = sql('SELECT system_identifier FROM pg_control_system();');
  config = {
    formatVersion: 1, runtimeDir: join(directory, 'work'),
    logicalSource: 'synthetic-business-fixture', app: { image: 'fixture:v7', commit: 'fixture' },
    source: { database: 'business_fixture', user: 'backup_test_owner', host: '127.0.0.1', port: 19439 },
    recovery: { user: 'backup_test_owner', host: '127.0.0.1', port: 19439,
      systemIdentifier, allowedDatabases: ['cloudlib_recovery_verify'], appRole: 'fixture_app' },
    encryption: { recipient, identityFile: join(directory, 'identity') },
    backupDir: join(resolve('backups'), basename(directory)),
    tools: { psql: { command: tool('psql') }, pg_dump: { command: tool('pg_dump') },
      pg_restore: { command: tool('pg_restore') }, age: { command: process.env.CLOUDLIB_BACKUP_TEST_AGE },
      age_keygen: { command: process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN },
      tar: { command: 'tar' } },
  };
  configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
});
after(() => {
  if (!directory) return;
  run(tool('pg_ctl'), ['-D', join(directory, 'pgdata'), '-m', 'fast', '-w', 'stop']);
  // Restricted fixture state is retained for diagnosis; the PG process is stopped.
});

test('daily publishes a verified snapshot and durable fresh status without a second archive implementation', { skip: !enabled }, () => {
  const result = cli('daily');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.status, 'ok');
  const status = JSON.parse(readFileSync(join(config.backupDir, 'backup-status.json')));
  assert.equal(status.lastAttempt.status, 'ok');
  assert.equal(status.rpoMet, true);
  assert.equal(status.lastValid.backupId, result.json.backup.backupId);
  assert.equal(status.lastValid.snapshotAt, result.json.backup.snapshotAt);
  assert.ok(status.ageHours >= 0 && status.ageHours < 1);
});
test('failed daily records failure while preserving the previous verified snapshot and live age', { skip: !enabled }, () => {
  const previous = JSON.parse(readFileSync(join(config.backupDir, 'backup-status.json')));
  config.source.port = 1;
  writeFileSync(configPath, JSON.stringify(config));
  const result = cli('daily');
  assert.notEqual(result.status, 0);
  const status = JSON.parse(readFileSync(join(config.backupDir, 'backup-status.json')));
  assert.equal(status.lastAttempt.status, 'error');
  assert.equal(status.lastAttempt.code, 'SNAPSHOT_FAILED');
  assert.equal(status.lastValid.backupId, previous.lastValid.backupId);
  assert.equal(status.rpoMet, true);
  config.source.port = 19439;
  writeFileSync(configPath, JSON.stringify(config));
});

function agedFixture(hours, mutate = {}) {
  const source = JSON.parse(readFileSync(join(config.backupDir, 'backup-status.json'))).lastValid;
  const scratch = mkdtempSync(join(directory, 'aged-'));
  const checked = (command, args) => { const r = run(command, args); assert.equal(r.status, 0, r.stderr); };
  checked(config.tools.age.command, ['-d', '-i', config.encryption.identityFile, '-o', join(scratch, 'original.tar'), join(config.backupDir, source.archiveName)]);
  checked('tar', ['-xf', join(scratch, 'original.tar'), '-C', scratch]);
  const payload = JSON.parse(readFileSync(join(scratch, 'inventory.json')));
  const backupId = 'cloudlib-2026-01-01T00-00-00-000Z-' + randomUUID();
  const snapshotAt = new Date(Date.now() - hours * 3600000).toISOString();
  Object.assign(payload, { backupId, snapshotAt }, mutate);
  writeFileSync(join(scratch, 'inventory.json'), JSON.stringify(payload));
  checked('tar', ['-cf', join(scratch, 'aged.tar'), '-C', scratch, 'db.dump', 'inventory.json']);
  const archiveName = backupId + '.age';
  checked(config.tools.age.command, ['-r', config.encryption.recipient, '-o', join(config.backupDir, archiveName), join(scratch, 'aged.tar')]);
  const bytes = readFileSync(join(config.backupDir, archiveName));
  const metadata = { ...source, backupId, snapshotAt, archiveName, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...mutate };
  writeFileSync(join(config.backupDir, backupId + '.json'), JSON.stringify(metadata));
  return backupId;
}

test('successful daily removes only authenticated owned snapshots older than seven days', { skip: !enabled }, () => {
  const expired = agedFixture(169);
  const retained = agedFixture(167);
  const wrongSource = agedFixture(170, { logicalSource: 'different-business' });
  const corrupt = agedFixture(171);
  writeFileSync(join(config.backupDir, corrupt + '.age'), 'corrupt');
  writeFileSync(join(config.backupDir, 'unrelated.age'), 'keep');
  writeFileSync(join(config.backupDir, '.cloudlib-incomplete.partial'), 'keep');
  const result = cli('daily');
  assert.equal(result.status, 0, result.stdout);
  const names = readdirSync(config.backupDir);
  assert.equal(names.includes(expired + '.json'), false);
  assert.equal(names.includes(expired + '.age'), false);
  for (const id of [retained, wrongSource, corrupt]) assert.equal(names.includes(id + '.age'), true);
  assert.equal(names.includes('unrelated.age'), true);
  assert.equal(names.includes('.cloudlib-incomplete.partial'), true);
  assert.equal(result.json.retention.deleted.includes(expired), true);
});

test('health reauthenticates stale snapshots and failed daily never deletes the last valid old copy', { skip: !enabled }, () => {
  const originalDir = config.backupDir;
  const old = agedFixture(200);
  const isolated = join(originalDir, 'health');
  mkdirSync(isolated);
  for (const ext of ['.json', '.age']) copyFileSync(join(originalDir, old + ext), join(isolated, old + ext));
  config.backupDir = isolated;
  writeFileSync(configPath, JSON.stringify(config));
  let result = cli('health');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.health.rpoMet, false);
  assert.equal(result.json.health.lastValid.backupId, old);
  assert.ok(result.json.health.ageHours >= 200);
  config.source.port = 1;
  writeFileSync(configPath, JSON.stringify(config));
  result = cli('daily');
  assert.equal(result.status, 1);
  assert.equal(readdirSync(isolated).includes(old + '.age'), true);
  const status = JSON.parse(readFileSync(join(isolated, 'backup-status.json')));
  assert.equal(status.lastAttempt.status, 'error');
  assert.equal(status.lastValid.backupId, old);
  assert.equal(status.rpoMet, false);
  writeFileSync(join(isolated, old + '.age'), 'corrupt');
  result = cli('health');
  assert.equal(result.json.health.lastValid, null);
  assert.equal(result.json.health.rpoMet, false);
  assert.equal(result.json.health.lastAttempt.status, 'error');
  config.source.port = 19439;
  config.backupDir = originalDir;
  writeFileSync(configPath, JSON.stringify(config));
});

test('independent manual create and daily processes cannot overlap', { skip: !enabled }, async () => {
  const launch = (command) => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['reliability/backup.mjs', command, '--config', configPath], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => accept({ code, json: JSON.parse(output) }));
  });
  const first = launch('create');
  const ownerFile = join(config.backupDir, '.cloudlib-backup.lock', 'owner.json');
  const deadline = Date.now() + 1000;
  while (!existsSync(ownerFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  const ownerSeen = existsSync(ownerFile) && JSON.parse(readFileSync(ownerFile));
  const second = launch('daily');
  const results = await Promise.all([first, second]);
  assert.equal(existsSync(join(config.backupDir, '.cloudlib-backup.lock')), false);
  assert.ok(ownerSeen && ownerSeen.pid > 0 && Number.isFinite(Date.parse(ownerSeen.startedAt)), 'active lock must expose nonsecret owner PID and start time');
  assert.deepEqual(results.map(x => x.code).sort(), [0,1]);
  assert.equal(results.find(x => x.code === 1).json.code, 'BACKUP_BUSY');
});

test('canonical backup folder rejects a junction before publishing or deleting through it', { skip: !enabled }, () => {
  const originalDir = config.backupDir;
  const outside = join(directory, 'outside');
  const alias = join(directory, 'alias');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'untouched');
  symlinkSync(outside, alias, 'junction');
  config.backupDir = alias;
  writeFileSync(configPath, JSON.stringify(config));
  const result = cli('daily');
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'UNSAFE_BACKUP_DIR');
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  config.backupDir = originalDir;
  writeFileSync(configPath, JSON.stringify(config));
});

test('native Task Scheduler executes the verified daily entrypoint and propagates database failure', { skip: !enabled || process.platform !== 'win32' }, () => {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'reliability/tests/schedule-native.ps1', '-ConfigPath', configPath]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PASS scheduler success=0 failure=1/);
  process.stdout.write(result.stdout);
});

test('retention leaves incomplete markers and linked archive directories untouched', { skip: !enabled }, () => {
  const id = 'cloudlib-2026-01-01T00-00-00-000Z-' + randomUUID();
  const linked = 'cloudlib-2026-01-01T00-00-00-000Z-' + randomUUID();
  writeFileSync(join(config.backupDir, id + '.json'), '{}');
  const outside = join(directory, 'linked-archive-target');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'untouched');
  symlinkSync(outside, join(config.backupDir, linked + '.age'), 'junction');
  writeFileSync(join(config.backupDir, linked + '.json'), '{}');
  const result = cli('daily');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(existsSync(join(config.backupDir, id + '.json')), true);
  assert.equal(existsSync(join(config.backupDir, linked + '.age')), true);
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  const health = cli('health').json.health;
  assert.equal(health.rejected.includes(id), true);
  assert.equal(health.rejected.includes(linked), true);
});
