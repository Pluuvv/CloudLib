import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';

const enabled = Boolean(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN && process.env.CLOUDLIB_BACKUP_TEST_AGE && process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN);
const root = resolve('reliability/.runtime/backup/tests');
let directory, configPath, config;
let backupId;
const tool = (name) => join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : ''));
function run(command, args, input) {
  return spawnSync(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000, ...(args.includes('start') ? { stdio: 'ignore' } : {}) });
}
function sql(text, database = 'postgres') {
  const result = run(tool('psql'), ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '16439', '-U', 'backup_test_owner', '-d', database], text);
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
  const started = run(tool('pg_ctl'), ['-D', join(directory, 'pgdata'), '-l', join(directory, 'postgres.log'), '-o', '-h 127.0.0.1 -p 16439', '-w', 'start']);
  assert.equal(started.status, 0, started.stderr);
  sql('CREATE DATABASE business_fixture; CREATE ROLE fixture_app;');
  sql(`CREATE TABLE tenant(id integer PRIMARY KEY, code text UNIQUE);
    CREATE TABLE book(id serial PRIMARY KEY, tenant_id integer REFERENCES tenant, title text);
    CREATE TABLE loan(id serial PRIMARY KEY, book_id integer REFERENCES book, returned boolean);
    CREATE TABLE flyway_schema_history(installed_rank integer PRIMARY KEY, version text, success boolean);
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
    source: { database: 'business_fixture', user: 'backup_test_owner', host: '127.0.0.1', port: 16439 },
    recovery: { user: 'backup_test_owner', host: '127.0.0.1', port: 16439,
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

test('full database encrypted local round-trip preserves both tenants, foreign keys, sequence and migrations', { skip: !enabled }, () => {
  const created = cli('create');
  assert.equal(created.status, 0, created.stderr + created.stdout);
  assert.equal(created.json.status, 'ok');
  assert.ok(created.json.backup.localVerifiedAt);
  assert.equal(created.json.backup.archiveName, created.json.backup.backupId + '.age');
  backupId = created.json.backup.backupId;
  const encrypted = readFileSync(join(config.backupDir, created.json.backup.archiveName));
  assert.ok(encrypted.subarray(0, 80).toString().includes('age-encryption.org/v1'));
  assert.equal(encrypted.includes(Buffer.from('Before snapshot')), false);
  const restored = cli('restore', '--id', created.json.backup.backupId, '--target', 'cloudlib_recovery_verify');
  assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  assert.equal(sql('SELECT count(*) FROM tenant;', 'cloudlib_recovery_verify'), '2');
  assert.equal(sql('SELECT string_agg(title,\'|\' ORDER BY id) FROM book;', 'cloudlib_recovery_verify'), 'Before snapshot|Other tenant');
  assert.equal(sql('SELECT nextval(\'book_id_seq\');', 'cloudlib_recovery_verify'), '43');
  assert.equal(sql('SELECT version FROM flyway_schema_history;', 'cloudlib_recovery_verify'), '7');
  assert.equal(sql('SELECT count(*) FROM loan JOIN book ON book.id=loan.book_id;', 'cloudlib_recovery_verify'), '1');
  assert.equal(sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='book'::regclass;", 'cloudlib_recovery_verify'), 'fixture_app');
  assert.equal(sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='fixture_app';"), 'f');
});

test('restore refuses the primary, source, existing destination and a different server without changing original data', { skip: !enabled }, () => {
  for (const target of ['capstone', 'business_fixture', 'cloudlib_recovery_verify']) {
    const result = cli('restore', '--id', backupId, '--target', target);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.code, target === 'cloudlib_recovery_verify' ? 'TARGET_EXISTS' : 'UNSAFE_TARGET');
  }
  const original = config.recovery.systemIdentifier;
  config.recovery.systemIdentifier = '1';
  writeFileSync(configPath, JSON.stringify(config));
  const wrongServer = cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify');
  assert.equal(wrongServer.json.code, 'WRONG_SERVER');
  config.recovery.systemIdentifier = original;
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(sql('SELECT count(*) FROM book;', 'business_fixture'), '2');
});

test('the published list verifies local bytes and restore rejects authenticated-encryption tampering before database creation', { skip: !enabled }, () => {
  const listed = cli('list');
  assert.equal(listed.status, 0, listed.stdout);
  assert.equal(listed.json.backups.length, 1);
  sql('DROP DATABASE cloudlib_recovery_verify;');
  const encryptedPath = join(config.backupDir, backupId + '.age');
  const metadataPath = join(config.backupDir, backupId + '.json');
  const bytes = readFileSync(encryptedPath);
  const originalMetadata = readFileSync(metadataPath);
  const forgedVersion = JSON.parse(originalMetadata);
  forgedVersion.appCommit = 'wrong-application-version';
  writeFileSync(metadataPath, JSON.stringify(forgedVersion));
  assert.equal(cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify').json.code, 'INVALID_PAYLOAD');
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery_verify';"), '0');
  writeFileSync(metadataPath, originalMetadata);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  writeFileSync(encryptedPath, damaged);
  let result = cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify');
  assert.equal(result.json.code, 'CHECKSUM_MISMATCH');
  // Even somebody who can rewrite unsigned public metadata cannot bypass age authentication.
  const metadata = JSON.parse(originalMetadata);
  metadata.sha256 = createHash('sha256').update(damaged).digest('hex');
  writeFileSync(metadataPath, JSON.stringify(metadata));
  result = cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify');
  assert.equal(result.status, 1);
  assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery_verify';"), '0');
  assert.equal(cli('list').status, 1);
  writeFileSync(encryptedPath, bytes);
  writeFileSync(metadataPath, originalMetadata);
});

test('an incomplete transfer or expired snapshot never becomes a usable backup', { skip: !enabled }, () => {
  const encryptedPath = join(config.backupDir, backupId + '.age');
  const metadataPath = join(config.backupDir, backupId + '.json');
  const bytes = readFileSync(encryptedPath);
  const originalMetadata = readFileSync(metadataPath);
  writeFileSync(encryptedPath, bytes.subarray(0, 100));
  assert.equal(cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify').json.code, 'CHECKSUM_MISMATCH');
  writeFileSync(encryptedPath, bytes);
  const stale = JSON.parse(originalMetadata);
  stale.snapshotAt = '2020-01-01T00:00:00Z';
  writeFileSync(metadataPath, JSON.stringify(stale));
  const expiredList = cli('list');
  assert.equal(expiredList.status, 0);
  assert.deepEqual(expiredList.json.backups, []);
  assert.equal(cli('restore', '--id', backupId, '--target', 'cloudlib_recovery_verify').json.code, 'STALE_BACKUP');
  writeFileSync(metadataPath, originalMetadata);
  assert.equal(sql('SELECT count(*) FROM book;', 'business_fixture'), '2');
  assert.equal(readdirSync(config.runtimeDir).some((name) => name.startsWith('transient-')), false);
});

test('the backup recipient must match the unattended identity before any archive is published', { skip: !enabled }, () => {
  const alienIdentity = join(directory, 'other-identity');
  assert.equal(run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-o', alienIdentity]).status, 0);
  const original = config.encryption.recipient;
  config.encryption.recipient = run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN, ['-y', alienIdentity]).stdout.trim();
  writeFileSync(configPath, JSON.stringify(config));
  const beforeFiles = readdirSync(config.backupDir).length;
  const result = cli('create');
  assert.equal(result.status, 2);
  assert.equal(result.json.code, 'KEY_MISMATCH');
  assert.equal(readdirSync(config.backupDir).length, beforeFiles);
  config.encryption.recipient = original;
  writeFileSync(configPath, JSON.stringify(config));
});
