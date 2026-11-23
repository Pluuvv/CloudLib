import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, copyFile, readdir, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

// stdout is a single versioned JSON result; subprocess output never reaches logs.
const identifier = /^[a-z_][a-z0-9_]*$/;
const backupPattern = /^cloudlib-[0-9TZ-]+-[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const digest = (data) => createHash('sha256').update(data).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function quote(value) { return '"' + value.replaceAll('"', '""') + '"'; }
function literal(value) { return "'" + value.replaceAll("'", "''") + "'"; }

async function execute(spec, args, { input, inputFile, outputFile, env = {} } = {}) {
  const child = spawn(spec.command, [...(spec.args ?? []), ...args], {
    env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let output = '';
  if (!outputFile) child.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('TOOL_FAILED')));
    child.once('close', (code) => code === 0 ? accept() : reject(new Error('TOOL_FAILED')));
  });
  const timeout = setTimeout(() => child.kill(), 180000);
  try {
    const streams = [];
    if (outputFile) streams.push(pipeline(child.stdout, createWriteStream(outputFile, { mode: 0o600, flags: 'wx' })));
    if (inputFile) streams.push(pipeline(createReadStream(inputFile), child.stdin));
    else child.stdin.end(input);
    await Promise.all([exited, ...streams]);
    return output.trim();
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
}

function connection(database, name = database.database) {
  return ['-h', database.host ?? 'localhost', '-p', String(database.port ?? 5432), '-U', database.user, '-d', name];
}
function pgEnvironment(database, readOnly = false) {
  const env = { PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'cloudlib-backup', PGOPTIONS: '-c timezone=UTC' + (readOnly ? ' -c default_transaction_read_only=on' : '') };
  if (database.passwordEnv) {
    if (!process.env[database.passwordEnv]) fail('MISSING_CREDENTIAL');
    env.PGPASSWORD = process.env[database.passwordEnv];
  }
  return env;
}
function sql(config, database, text, name, readOnly = true) {
  return execute(database.tools?.psql ?? config.tools.psql, ['-XqAt', '-v', 'ON_ERROR_STOP=1', ...connection(database, name)], {
    input: text + '\n', env: pgEnvironment(database, readOnly),
  });
}

async function openSnapshot(config) {
  const source = config.source;
  const spec = source.tools?.psql ?? config.tools.psql;
  const child = spawn(spec.command, [...(spec.args ?? []), '-XqAt', '-v', 'ON_ERROR_STOP=1', ...connection(source)], {
    env: { ...process.env, ...pgEnvironment(source, true) }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('SNAPSHOT_FAILED')));
    child.once('close', (code) => code === 0 ? accept() : reject(new Error('SNAPSHOT_FAILED')));
  });
  // Attach immediately, including while waiting for the first snapshot line.
  exited.catch(() => {});
  let timeout;
  const opened = new Promise((accept, reject) => {
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('\n')) {
        try { accept(JSON.parse(output.slice(0, output.indexOf('\n')))); }
        catch { reject(new Error('SNAPSHOT_FAILED')); }
      }
    });
    child.once('error', () => reject(new Error('SNAPSHOT_FAILED')));
    child.once('close', () => reject(new Error('SNAPSHOT_FAILED')));
    timeout = setTimeout(() => { child.kill(); reject(new Error('SNAPSHOT_FAILED')); }, 15000);
  });
  child.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object('id',pg_export_snapshot(),'at',clock_timestamp(),'major',current_setting('server_version_num')::int/10000);\n");
  try {
    const snapshot = await opened;
    if (snapshot.major !== 17) fail('POSTGRES_VERSION');
    return { ...snapshot, close: async () => { child.stdin.end('ROLLBACK;\n'); await exited; } };
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timeout); }
}

const tableInventory = `SELECT format(
  'SELECT json_build_object(''schema'',%L,''table'',%L,''rows'',count(*),''fingerprint'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM %I.%I t;',
  n.nspname,c.relname,n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema'
  ORDER BY n.nspname,c.relname \\gexec`;
const sequenceInventory = `SELECT format('SELECT json_build_object(''schema'',%L,''sequence'',%L,''lastValue'',last_value::text,''isCalled'',is_called) FROM %I.%I;',
  schemaname,sequencename,schemaname,sequencename) FROM pg_sequences
  WHERE left(schemaname,3) <> 'pg_' AND schemaname <> 'information_schema' ORDER BY schemaname,sequencename \\gexec`;
async function inventory(config, database, name, snapshot) {
  const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + (snapshot ? 'SET TRANSACTION SNAPSHOT ' + literal(snapshot) + ';\n' : '');
  const tables = await sql(config, database, begin + tableInventory + '\nCOMMIT;', name);
  const sequences = await sql(config, database, sequenceInventory, name);
  return { tables: tables ? tables.split('\n').map(JSON.parse) : [], sequences: sequences ? sequences.split('\n').map(JSON.parse) : [] };
}
async function schemaFingerprint(config, database, name, snapshot) {
  const schema = await execute(database.tools?.pg_dump ?? config.tools.pg_dump, [...connection(database, name), '--schema-only', '--no-owner', '--no-privileges', ...(snapshot ? ['--snapshot=' + snapshot] : [])], { env: pgEnvironment(database, true) });
  return digest(schema.split(/\r?\n/).filter((line) => !line.startsWith('--') && !line.startsWith('\\restrict') && !line.startsWith('\\unrestrict') && line.trim()).join('\n'));
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
async function decrypt(config, encrypted, directory) {
  const tar = join(directory, 'payload.tar');
  await execute(config.tools.age, ['--decrypt', '--identity', config.encryption.identityFile, '--output', tar, encrypted]);
  const members = await execute(config.tools.tar, ['-tf', tar]);
  if (members.replaceAll('\r', '') !== 'db.dump\ninventory.json') fail('INVALID_PAYLOAD');
  // Extract bytes to our own files: archive links can never create/follow filesystem links.
  await execute(config.tools.tar, ['-xOf', tar, 'db.dump'], { outputFile: join(directory, 'db.dump') });
  await execute(config.tools.tar, ['-xOf', tar, 'inventory.json'], { outputFile: join(directory, 'inventory.json') });
  const payload = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8'));
  if (payload.formatVersion !== 1 || !backupPattern.test(payload.backupId) ||
      payload.dumpSha256 !== await hashFile(join(directory, 'db.dump'))) fail('INVALID_PAYLOAD');
  await execute(config.tools.pg_restore, ['--list'], { inputFile: join(directory, 'db.dump') });
  return payload;
}
function validateMetadata(config, metadata, id) {
  if (metadata.formatVersion !== 1 || metadata.backupId !== id || metadata.logicalSource !== config.logicalSource ||
      metadata.archiveName !== id + '.age' || metadata.pgMajor !== 17 || !Number.isFinite(Date.parse(metadata.localVerifiedAt)) ||
      !Number.isFinite(Date.parse(metadata.localPublishedAt)) || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0) fail('INVALID_METADATA');
  const age = Date.now() - Date.parse(metadata.snapshotAt);
  if (!Number.isFinite(age) || age < -60000 || age > config.maxAgeHours * 3600000) fail('STALE_BACKUP');
}
async function readBackup(config, id, directory) {
  const metadataFile = join(directory, 'metadata.json');
  await copyFile(join(config.backupDir, id + '.json'), metadataFile, constants.COPYFILE_EXCL);
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  validateMetadata(config, metadata, id);
  const encrypted = join(directory, 'readback.age');
  await copyFile(join(config.backupDir, metadata.archiveName), encrypted, constants.COPYFILE_EXCL);
  if ((await stat(encrypted)).size !== metadata.sizeBytes || await hashFile(encrypted) !== metadata.sha256) fail('CHECKSUM_MISMATCH');
  const payload = await decrypt(config, encrypted, directory);
  if (payload.backupId !== id || payload.logicalSource !== metadata.logicalSource || payload.snapshotAt !== metadata.snapshotAt ||
      payload.schemaFingerprint !== metadata.schemaFingerprint || payload.appImage !== metadata.appImage ||
      payload.appCommit !== metadata.appCommit || payload.pgMajor !== metadata.pgMajor) fail('INVALID_PAYLOAD');
  return { metadata, payload };
}

async function create(config, directory) {
  const recipient = await execute(config.tools.age_keygen, ['-y', config.encryption.identityFile]);
  if (recipient !== config.encryption.recipient) fail('KEY_MISMATCH');
  const startedAt = now();
  const backupId = 'cloudlib-' + startedAt.replace(/[:.]/g, '-') + '-' + randomUUID();
  const snapshot = await openSnapshot(config);
  let contents, schema;
  try {
    contents = await inventory(config, config.source, undefined, snapshot.id);
    schema = await schemaFingerprint(config, config.source, undefined, snapshot.id);
    await execute(config.source.tools?.pg_dump ?? config.tools.pg_dump, [...connection(config.source), '--format=custom', '--snapshot=' + snapshot.id], {
      env: pgEnvironment(config.source, true), outputFile: join(directory, 'db.dump'),
    });
    const after = await inventory(config, config.source, undefined, snapshot.id);
    if (JSON.stringify(after.sequences) !== JSON.stringify(contents.sequences)) fail('SEQUENCE_DRIFT');
  } finally { await snapshot.close(); }
  const payload = { formatVersion: 1, backupId, logicalSource: config.logicalSource, snapshotAt: snapshot.at,
    pgMajor: 17, appImage: config.app.image, appCommit: config.app.commit,
    schemaFingerprint: schema, ...contents, dumpSha256: await hashFile(join(directory, 'db.dump')) };
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(payload), { mode: 0o600 });
  const tar = join(directory, 'source.tar');
  await execute(config.tools.tar, ['-cf', tar, '-C', directory, 'db.dump', 'inventory.json']);
  const encrypted = join(directory, backupId + '.age');
  await execute(config.tools.age, ['--encrypt', '--recipient', config.encryption.recipient, '--output', encrypted, tar]);
  const metadata = { formatVersion: 1, backupId, logicalSource: config.logicalSource, snapshotAt: snapshot.at,
    startedAt, endedAt: now(), pgMajor: 17, appImage: config.app.image, appCommit: config.app.commit,
    schemaFingerprint: schema, sizeBytes: (await stat(encrypted)).size, sha256: await hashFile(encrypted),
    archiveName: backupId + '.age', localPublishedAt: null, localVerifiedAt: null };
  await mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  const partialArchive = join(config.backupDir, '.' + backupId + '.age.partial');
  const partialMetadata = join(config.backupDir, '.' + backupId + '.json.partial');
  await copyFile(encrypted, partialArchive, constants.COPYFILE_EXCL);
  await chmod(partialArchive, 0o600);
  const verify = await mkdtemp(join(directory, 'verify-'));
  if ((await stat(partialArchive)).size !== metadata.sizeBytes || await hashFile(partialArchive) !== metadata.sha256) fail('CHECKSUM_MISMATCH');
  const checked = await decrypt(config, partialArchive, verify);
  if (JSON.stringify(checked) !== JSON.stringify(payload)) fail('INVALID_PAYLOAD');
  metadata.localVerifiedAt = now();
  await rename(partialArchive, join(config.backupDir, metadata.archiveName));
  metadata.localPublishedAt = now();
  await writeFile(partialMetadata, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
  // A final JSON marker is the atomic publication point; orphan/partial archives are unusable.
  await rename(partialMetadata, join(config.backupDir, backupId + '.json'));
  if ((await readFile(join(config.backupDir, backupId + '.json'), 'utf8')) !== JSON.stringify(metadata)) fail('METADATA_VERIFY_FAILED');
  return { backup: metadata };
}

async function restore(config, id, target, directory) {
  if (!config.recovery.allowedDatabases.includes(target) || !identifier.test(target) ||
      target === 'capstone' || target === config.source.database) fail('UNSAFE_TARGET');
  // Authenticate the entire local payload before any recovery database mutation.
  const { metadata, payload } = await readBackup(config, id, directory);
  const recovery = config.recovery;
  const identity = await sql(config, recovery, "SELECT system_identifier::text || '|' || (current_setting('server_version_num')::int/10000)::text FROM pg_control_system();", 'postgres');
  if (identity !== recovery.systemIdentifier + '|17') fail('WRONG_SERVER');
  const exists = await sql(config, recovery, 'SELECT count(*) FROM pg_database WHERE datname=' + literal(target) + ';', 'postgres');
  if (exists !== '0') fail('TARGET_EXISTS');
  const roleExists = await sql(config, recovery, 'SELECT count(*) FROM pg_roles WHERE NOT rolsuper AND rolname <> current_user AND rolname=' + literal(recovery.appRole) + ';', 'postgres');
  if (roleExists !== '1') fail('MISSING_APP_ROLE');
  // CREATE DATABASE is atomic; a concurrent restore loses here rather than overwriting.
  await sql(config, recovery, 'CREATE DATABASE ' + quote(target) + ' OWNER ' + quote(recovery.user) + ' TEMPLATE template0 ALLOW_CONNECTIONS false;\nREVOKE CONNECT ON DATABASE ' + quote(target) + ' FROM PUBLIC;\nALTER DATABASE ' + quote(target) + ' ALLOW_CONNECTIONS true;', 'postgres', false);
  await sql(config, recovery, 'GRANT CREATE ON DATABASE ' + quote(target) + ' TO ' + quote(recovery.appRole) + ';\nGRANT CREATE ON SCHEMA public TO ' + quote(recovery.appRole) + ';', target, false);
  await execute(recovery.tools?.pg_restore ?? config.tools.pg_restore, [...connection(recovery, target), '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--role=' + recovery.appRole], {
    inputFile: join(directory, 'db.dump'), env: pgEnvironment(recovery),
  });
  const actual = await inventory(config, recovery, target);
  if (JSON.stringify(actual.tables) !== JSON.stringify(payload.tables) || JSON.stringify(actual.sequences) !== JSON.stringify(payload.sequences) ||
      await schemaFingerprint(config, recovery, target) !== payload.schemaFingerprint) fail('RESTORED_DATA_MISMATCH');
  await sql(config, recovery, 'GRANT CONNECT ON DATABASE ' + quote(target) + ' TO ' + quote(recovery.appRole) + ';', 'postgres', false);
  return { backup: metadata, target, verified: { tables: actual.tables.length, sequences: actual.sequences.length, data: true, schema: true }, restoredAt: now() };
}

async function list(config, directory) {
  const files = await readdir(config.backupDir);
  const backups = [];
  for (const file of files) {
    const id = file.endsWith('.json') ? file.slice(0, -5) : '';
    if (!backupPattern.test(id)) continue;
    const temporary = await mkdtemp(join(directory, 'listed-'));
    try {
      const { metadata } = await readBackup(config, id, temporary);
      backups.push(metadata);
    } catch (error) {
      if (error.message !== 'STALE_BACKUP') throw error;
    }
  }
  backups.sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt));
  return { backups };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['create', 'restore', 'list'].includes(command) || args.length % 2) fail('USAGE');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--id', '--target'].includes(args[i]) || options[args[i]]) fail('USAGE');
    options[args[i]] = args[i + 1];
  }
  if (!isAbsolute(options['--config'] ?? '') || (command === 'restore' ? !backupPattern.test(options['--id'] ?? '') || !options['--target'] : options['--id'] || options['--target'])) fail('USAGE');
  const config = JSON.parse(await readFile(options['--config'], 'utf8'));
  if (config.formatVersion !== 1 || !isAbsolute(config.runtimeDir ?? '') || !config.logicalSource || !config.app?.image || !config.app?.commit ||
      !isAbsolute(config.backupDir ?? '') || !config.encryption?.recipient || !isAbsolute(config.encryption?.identityFile ?? '') ||
      !identifier.test(config.source?.database ?? '') || !identifier.test(config.source?.user ?? '') || !identifier.test(config.recovery?.appRole ?? '') ||
      !/^\d+$/.test(config.recovery?.systemIdentifier ?? '') || !identifier.test(config.recovery?.user ?? '') || !Array.isArray(config.recovery?.allowedDatabases) ||
      !config.recovery.allowedDatabases.every((name) => /^cloudlib_recovery_(?:verify|candidate(?:_[a-z0-9_]+)?)$/.test(name)) ||
      !['psql', 'pg_dump', 'pg_restore', 'age', 'tar'].every((tool) => config.tools?.[tool]?.command)) fail('INVALID_CONFIG');
  config.maxAgeHours ??= 24;
  config.tools.age_keygen ??= { command: 'age-keygen' };
  if (!Number.isFinite(config.maxAgeHours) || config.maxAgeHours <= 0 || config.maxAgeHours > 24) fail('INVALID_CONFIG');
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(config.runtimeDir, 'transient-'));
  try {
    const result = command === 'create' ? await create(config, directory) : command === 'restore' ? await restore(config, options['--id'], options['--target'], directory) : await list(config, directory);
    return { formatVersion: 1, status: 'ok', command, ...result };
  } finally {
    // Only this invocation's private plaintext working directory is removed.
    await rm(directory, { recursive: true, force: true });
  }
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED';
  console.log(JSON.stringify({ formatVersion: 1, status: 'error', code }));
  process.exitCode = ['USAGE', 'INVALID_CONFIG', 'UNSAFE_TARGET', 'KEY_MISMATCH'].includes(code) ? 2 : 1;
}
