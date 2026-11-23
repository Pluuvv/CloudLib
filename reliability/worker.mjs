import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, readdir, lstat, open, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const now = () => new Date().toISOString();
const fail = (code) => {
  throw new Error(code);
};
const ident = /^[a-z_][a-z0-9_]*$/;
const q = (s) => '"' + s.replaceAll('"', '""') + '"';
const lit = (s) => "'" + s.replaceAll("'", "''") + "'";
let activeChild, session;
function execute(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    activeChild = p;
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => reject(new Error('TOOL_FAILED')));
    const timer = setTimeout(() => p.kill(), 180000);
    p.on('close', (code) => {
      clearTimeout(timer);
      activeChild = null;
      code === 0 ? resolve(out) : reject(new Error('TOOL_FAILED'));
    });
  });
}
function openSession(b) {
  const r = b.recovery,
    spec = r.tools?.psql ?? b.tools.psql;
  const env = {
    ...process.env,
    PGCONNECT_TIMEOUT: '3',
    PGAPPNAME: 'cloudlib-recovery-worker',
    PGOPTIONS: '-c statement_timeout=15000'
  };
  if (r.passwordEnv) {
    if (!process.env[r.passwordEnv]) fail('MISSING_CREDENTIAL');
    env.PGPASSWORD = process.env[r.passwordEnv];
  }
  const p = spawn(
    spec.command,
    [
      ...(spec.args ?? []),
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      r.host ?? 'localhost',
      '-p',
      String(r.port ?? 5432),
      '-U',
      r.user,
      '-d',
      'postgres'
    ],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
  );
  let pending = null,
    buffer = '',
    dead = false,
    closing = false;
  p.stdout.on('data', (d) => {
    buffer += d.toString().replaceAll('\r', '');
    if (pending && buffer.includes(pending.marker + '\n')) {
      const i = buffer.indexOf(pending.marker + '\n');
      const result = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + pending.marker.length + 1);
      clearTimeout(pending.timer);
      const cb = pending;
      pending = null;
      cb.resolve(result);
    }
  });
  const died = () => {
    dead = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MAINTENANCE_UNAVAILABLE'));
      pending = null;
    }
    if (!closing) activeChild?.kill();
  };
  p.on('error', died);
  p.on('close', died);
  p.stdin.on('error', died);
  return {
    async sql(text) {
      if (dead) fail('MAINTENANCE_UNAVAILABLE');
      return new Promise((resolve, reject) => {
        const marker = 'done_' + randomUUID();
        const timer = setTimeout(() => {
          p.kill();
          reject(new Error('MAINTENANCE_UNAVAILABLE'));
        }, 20000);
        pending = { resolve, reject, marker, timer };
        p.stdin.write(text + '\n\\echo ' + marker + '\n');
      });
    },
    close() {
      closing = true;
      p.stdin.end();
      p.kill();
    }
  };
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !isAbsolute(process.argv[3]))
    fail('INVALID_CONFIG');
  const c = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (
    c.formatVersion !== 1 ||
    !isAbsolute(c.backupConfig ?? '') ||
    !isAbsolute(c.stateDir ?? '') ||
    c.target !== 'cloudlib_recovery' ||
    !/^cloudlib_recovery_(verify|candidate(?:_[a-z0-9_]+)?)$/.test(c.candidate ?? '') ||
    !Number.isInteger(c.intervalMs) ||
    c.intervalMs < 100 ||
    !Number.isInteger(c.maxAttempts) ||
    c.maxAttempts < 1 ||
    c.maxAttempts > 5
  )
    fail('INVALID_CONFIG');
  if (c.eventLogDir !== undefined && !isAbsolute(c.eventLogDir)) fail('INVALID_CONFIG');
  const b = JSON.parse(await readFile(c.backupConfig, 'utf8'));
  if (
    b.formatVersion !== 1 ||
    !/^\d+$/.test(b.recovery?.systemIdentifier ?? '') ||
    !ident.test(b.recovery?.appRole ?? '') ||
    !ident.test(b.recovery?.user ?? '') ||
    b.recovery.appRole === b.recovery.user ||
    b.source?.database === c.target ||
    !b.recovery.allowedDatabases.includes(c.candidate)
  )
    fail('INVALID_CONFIG');
  await mkdir(c.stateDir, { recursive: true, mode: 0o700 });
  const statusFile = join(c.stateDir, 'status.json');
  let status = {
    formatVersion: 1,
    target: c.target,
    phase: 'starting',
    attempt: 0,
    triggerChannel: 'reconcile'
  };
  async function publish(phase, extra = {}) {
    status = { ...status, ...extra, systemIdentifier: b.recovery.systemIdentifier, phase, updatedAt: now() };
    const tmp = join(c.stateDir, randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify(status), { mode: 0o600 });
    for (let retry = 0; ; retry++) {
      try {
        await rename(tmp, statusFile);
        break;
      } catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || retry >= 20)
          throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    console.log(JSON.stringify(status));
    await metrics(phase === 'open');
  }
  async function metrics(ready) {
    await writeFile(
      join(c.stateDir, 'metrics.prom'),
      'cloudlib_recovery_data_ready ' +
        (ready ? 1 : 0) +
        '\ncloudlib_recovery_attempts ' +
        status.attempt +
        '\n',
      { mode: 0o600 }
    );
  }

  async function load() {
    try {
      const saved = JSON.parse(await readFile(statusFile, 'utf8'));
      if (
        saved.formatVersion !== 1 ||
        saved.target !== c.target ||
        (saved.systemIdentifier && saved.systemIdentifier !== b.recovery.systemIdentifier) ||
        !Number.isInteger(saved.attempt) ||
        saved.attempt < 0
      )
        fail('INVALID_STATE');
      return saved;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      fail('INVALID_STATE');
    }
  }
  async function backup(command, ...args) {
    const output = await execute(process.execPath, [
      fileURLToPath(new URL('./backup.mjs', import.meta.url)),
      command,
      '--config',
      c.backupConfig,
      ...args
    ]);
    let result;
    try {
      result = JSON.parse(output);
    } catch {
      fail('BACKUP_FAILED');
    }
    if (result.status !== 'ok') fail('BACKUP_FAILED');
    return result;
  }
  // Only the dedicated isolated server's read-only log directory is admitted.
  // Log records can request observation; they never authorize mutation.
  let candidate = null,
    wake = null;
  const offsets = new Map();
  let initialized = false,
    logAvailable = null;
  const wait = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  async function readEvents() {
    if (!c.eventLogDir) return;
    try {
      if ((await lstat(c.eventLogDir)).isSymbolicLink() || (await realpath(c.eventLogDir)) !== c.eventLogDir)
        fail('UNSAFE_LOG_DIRECTORY');
      const names = (await readdir(c.eventLogDir))
        .filter((n) => /^[a-zA-Z0-9_.-]+\.json$/.test(n))
        .sort()
        .slice(-64);
      const present = new Set(names);
      for (const name of offsets.keys()) if (!present.has(name)) offsets.delete(name);
      for (const name of names) {
        const path = join(c.eventLogDir, name),
          stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const identity = stat.ino + ':' + stat.birthtimeMs;
        let cursor = offsets.get(name);
        if (!cursor || cursor.identity !== identity || stat.size < cursor.offset)
          cursor = { identity, offset: initialized ? 0 : stat.size, partial: '' };
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(262144, Math.max(0, stat.size - cursor.offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
          cursor.offset += bytesRead;
          const lines = (cursor.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
          cursor.partial = lines.pop();
          if (cursor.partial.length > 65536) cursor.partial = '';
          for (const line of lines) {
            if (line.length > 65536) continue;
            let record;
            try {
              record = JSON.parse(line);
            } catch {
              continue;
            }
            const sourceTime = Date.parse(record.timestamp);
            if (
              record.error_severity !== 'LOG' ||
              !Number.isFinite(sourceTime) ||
              sourceTime < Date.now() - 60000 ||
              sourceTime > Date.now() + 5000 ||
              typeof record.message !== 'string' ||
              !/^statement:\s*DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:cloudlib_recovery|"cloudlib_recovery")(?:\s+WITH\s*\(\s*FORCE\s*\))?\s*;?\s*$/i.test(
                record.message
              )
            )
              continue;
            if (!candidate) {
              candidate = {
                triggerChannel: 'event',
                receivedEventAt: now(),
                sourceEventAt: new Date(sourceTime).toISOString(),
                expires: Date.now() + 30000
              };
              console.log(
                JSON.stringify({
                  phase: 'candidate',
                  triggerChannel: 'event',
                  receivedEventAt: candidate.receivedEventAt,
                  sourceEventAt: candidate.sourceEventAt
                })
              );
              wake?.();
            }
          }
        } finally {
          await handle.close();
        }
        offsets.set(name, cursor);
      }
      initialized = true;
      if (logAvailable !== true) console.log(JSON.stringify({ phase: 'log_stream', available: true }));
      logAvailable = true;
    } catch {
      if (logAvailable !== false)
        console.log(JSON.stringify({ phase: 'log_stream', available: false, code: 'LOG_UNAVAILABLE' }));
      logAvailable = false;
      // Polling reconciliation remains independent of log availability.
    }
  }
  await readEvents();
  let reading = false;
  const reader = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      await readEvents();
    } finally {
      reading = false;
    }
  }, 100);
  reader.unref();
  let nextReconcile = 0;
  for (;;) {
    if (candidate?.expires < Date.now()) candidate = null;
    if (!candidate && Date.now() < nextReconcile) {
      await wait(nextReconcile - Date.now());
      continue;
    }
    const trigger = candidate ? { ...candidate } : { triggerChannel: 'reconcile' };
    if (!candidate) nextReconcile = Date.now() + c.intervalMs;
    session = openSession(b);
    let locked = false;
    try {
      const identity = await session.sql(
        "SELECT system_identifier::text || '|' || (current_setting('server_version_num')::int/10000)::text FROM pg_control_system();"
      );
      if (identity !== b.recovery.systemIdentifier + '|17') fail('WRONG_SERVER');
      if ((await session.sql('SELECT pg_try_advisory_lock(173204, 3);')) !== 't') {
        session.close();
        await wait(candidate ? 200 : Math.max(1, nextReconcile - Date.now()));
        continue;
      }
      locked = true;
      const old = await load();
      if (old) status = old;
      if (old?.incidentId && !['open', 'failed'].includes(old.phase)) {
        await session.sql(
          'ALTER ROLE ' +
            q(b.recovery.appRole) +
            ' NOLOGIN; SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE usename=' +
            lit(b.recovery.appRole) +
            ' AND pid<>pg_backend_pid();'
        );
        await publish('failed', { code: 'INTERRUPTED', failedAt: now(), requiresOperator: true });
      } else if (
        (await session.sql('SELECT count(*) FROM pg_database WHERE datname=' + lit(c.target) + ';')) !== '0'
      ) {
        if (!status.incidentId) await publish('healthy');
        else {
          await metrics(status.phase === 'open' && !status.requiresOperator);
          console.log(
            JSON.stringify({ phase: 'observed', triggerChannel: trigger.triggerChannel, target: c.target })
          );
        }
      } else if (status.requiresOperator || (status.phase !== 'open' && status.attempt >= c.maxAttempts)) {
        if (status.phase !== 'failed')
          await publish('failed', { code: 'ATTEMPTS_EXHAUSTED', failedAt: now() });
      } else {
        status = {
          formatVersion: 1,
          target: c.target,
          phase: 'detected',
          incidentId: randomUUID(),
          attempt: status.phase === 'failed' ? status.attempt + 1 : 1,
          triggerChannel: trigger.triggerChannel,
          ...(trigger.receivedEventAt
            ? { receivedEventAt: trigger.receivedEventAt, sourceEventAt: trigger.sourceEventAt }
            : {}),
          detectedAt: now(),
          lossConfirmedAt: now(),
          recoveryStartedAt: now()
        };
        candidate = null;
        await publish('detected');
        // The app role is exclusive to this isolated target, including Flyway/startup connections.
        const safeRole = await session.sql(
          'SELECT count(*) FROM pg_roles WHERE NOT rolsuper AND rolname <> current_user AND rolname=' +
            lit(b.recovery.appRole) +
            ';'
        );
        if (safeRole !== '1') fail('UNSAFE_APP_ROLE');
        await session.sql(
          'ALTER ROLE ' +
            q(b.recovery.appRole) +
            ' NOLOGIN; SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE usename=' +
            lit(b.recovery.appRole) +
            ' AND pid<>pg_backend_pid();'
        );
        await publish('fenced', { fencedAt: now() });
        if (
          (await session.sql('SELECT count(*) FROM pg_database WHERE datname=' + lit(c.candidate) + ';')) !==
          '0'
        )
          fail('CANDIDATE_EXISTS');
        const selected = (await backup('list')).backups[0];
        if (!selected) fail('NO_USABLE_BACKUP');
        if (selected.appImage !== b.app.image || selected.appCommit !== b.app.commit)
          fail('WRONG_APPLICATION');
        await publish('restore', {
          selectedBackupId: selected.backupId,
          snapshotAt: selected.snapshotAt,
          pickBackupAt: now(),
          decryptStartedAt: now(),
          restoreStartedAt: now()
        });
        const result = await backup('restore', '--id', selected.backupId, '--target', c.candidate);
        if (
          result.target !== c.candidate ||
          result.verified?.data !== true ||
          result.verified?.schema !== true
        )
          fail('UNVERIFIED_RESTORE');
        await publish('validated', { basicValidationAt: now(), restoreCompletedAt: result.restoredAt });
        // Same live lock session: loss of lock prevents promotion/reopening.
        if (
          (await session.sql('SELECT count(*) FROM pg_database WHERE datname=' + lit(c.target) + ';')) !== '0'
        )
          fail('TARGET_EXISTS');
        await session.sql('ALTER DATABASE ' + q(c.candidate) + ' RENAME TO ' + q(c.target) + ';');
        await publish('promoted', { promotedAt: now() });
        await session.sql('ALTER ROLE ' + q(b.recovery.appRole) + ' LOGIN;');
        await publish('open', { openedAt: now(), code: null });
      }
    } catch (e) {
      const code = /^[A-Z_]+$/.test(e.message) ? e.message : 'OPERATION_FAILED';
      if (!locked) {
        console.log(
          JSON.stringify({
            formatVersion: 1,
            target: c.target,
            phase: 'failed',
            code,
            updatedAt: now(),
            triggerChannel: 'reconcile'
          })
        );
        await writeFile(
          join(c.stateDir, 'metrics.prom'),
          'cloudlib_recovery_data_ready 0\ncloudlib_recovery_attempts ' + status.attempt + '\n',
          { mode: 0o600 }
        );
        await wait(candidate ? 200 : Math.max(1, nextReconcile - Date.now()));
        continue;
      }
      await publish('failed', {
        code,
        failedAt: now(),
        requiresOperator: status.incidentId || code === 'INVALID_STATE' ? true : undefined
      });
    } finally {
      session.close();
      session = null;
    }
    await wait(candidate ? 200 : Math.max(1, nextReconcile - Date.now()));
  }
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    activeChild?.kill();
    session?.close();
    process.exit(0);
  });
main().catch(() => {
  console.log(JSON.stringify({ formatVersion: 1, phase: 'failed', code: 'INVALID_CONFIG' }));
  process.exitCode = 2;
});
