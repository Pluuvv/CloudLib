import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
const enabled = Boolean(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN && process.env.CLOUDLIB_BACKUP_TEST_AGE && process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN);
const tool = n => join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN, n + (process.platform === 'win32' ? '.exe' : ''));
let dir, config, bp, wp, cp, backup, worker;
function run(c,a,input) { return spawnSync(c,a,{ input, encoding:'utf8', windowsHide:true, timeout:90000, ...(a.includes('start') ? {stdio:'ignore'} : {}) }); }
function sql(s, db='postgres') { const r=run(tool('psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','20439','-U','drill_owner','-d',db],s); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }
function cli(command,...args) { const r=run(process.execPath,['reliability/backup.mjs',command,'--config',bp,...args]); return {...r,json:JSON.parse(r.stdout)}; }
before(()=>{
 if(!enabled)return;
 mkdirSync(resolve('reliability/.runtime/drill/tests'),{recursive:true}); dir=mkdtempSync(resolve('reliability/.runtime/drill/tests/pg17-'));
 assert.equal(run(tool('initdb'),['-D',join(dir,'pgdata'),'-U','drill_owner','--auth=trust','--no-locale','--encoding=UTF8']).status,0);
 assert.equal(run(tool('pg_ctl'),['-D',join(dir,'pgdata'),'-l',join(dir,'pg.log'),'-o','-h 127.0.0.1 -p 20439','-w','start']).status,0);
 sql('CREATE ROLE fixture_app LOGIN; CREATE ROLE drill_worker LOGIN CREATEDB CREATEROLE NOSUPERUSER; GRANT fixture_app TO drill_worker WITH ADMIN TRUE; GRANT pg_signal_backend TO drill_worker; GRANT EXECUTE ON FUNCTION pg_control_system() TO drill_worker; CREATE DATABASE business_fixture; CREATE DATABASE cloudlib_recovery;');
 sql("CREATE TABLE tenant(id integer PRIMARY KEY,code text); INSERT INTO tenant VALUES(1,'north'),(2,'south'); CREATE TABLE loan(id integer PRIMARY KEY,tenant_id integer REFERENCES tenant,returned boolean); INSERT INTO loan VALUES(10,1,false); CREATE TABLE computer_reservation(id integer PRIMARY KEY,tenant_id integer); INSERT INTO computer_reservation VALUES(20,1); CREATE TABLE visitor_log(id integer PRIMARY KEY,tenant_id integer); INSERT INTO visitor_log VALUES(30,2); CREATE TABLE flyway_schema_history(installed_rank integer PRIMARY KEY,success boolean); INSERT INTO flyway_schema_history VALUES(1,true);",'business_fixture');
 const identity=join(dir,'identity'); assert.equal(run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN,['-o',identity]).status,0);
 config={formatVersion:1,runtimeDir:join(dir,'work'),backupDir:resolve('backups',basename(dir)),logicalSource:'drill-fixture',app:{image:'fixture:v7',commit:'fixture'},source:{host:'127.0.0.1',port:20439,user:'drill_owner',database:'business_fixture'},recovery:{host:'127.0.0.1',port:20439,user:'drill_worker',systemIdentifier:sql('SELECT system_identifier FROM pg_control_system();'),allowedDatabases:['cloudlib_recovery_verify'],appRole:'fixture_app'},encryption:{identityFile:identity,recipient:run(process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN,['-y',identity]).stdout.trim()},tools:{psql:{command:tool('psql')},pg_dump:{command:tool('pg_dump')},pg_restore:{command:tool('pg_restore')},age:{command:process.env.CLOUDLIB_BACKUP_TEST_AGE},age_keygen:{command:process.env.CLOUDLIB_BACKUP_TEST_AGE_KEYGEN},tar:{command:'tar'}}};
 bp=join(dir,'backup.json'); writeFileSync(bp,JSON.stringify(config)); backup=cli('create').json.backup; assert.ok(backup);
 const dumped=run(tool('pg_dump'),['-h','127.0.0.1','-p','20439','-U','drill_owner','-d','business_fixture','--no-owner','--no-privileges']); assert.equal(dumped.status,0); sql('GRANT ALL ON SCHEMA public TO fixture_app; SET ROLE fixture_app;'+dumped.stdout,'cloudlib_recovery');
 wp=join(dir,'worker.json'); writeFileSync(wp,JSON.stringify({formatVersion:1,backupConfig:bp,stateDir:join(dir,'state'),target:'cloudlib_recovery',candidate:'cloudlib_recovery_verify',intervalMs:200,maxAttempts:1}));
 cp=join(dir,'drill.json');
});
after(async()=>{if(worker){worker.kill();await new Promise(r=>worker.once('close',r));}if(dir)run(tool('pg_ctl'),['-D',join(dir,'pgdata'),'-m','fast','-w','stop']);});
test('read-only verification compares a pinned recovery database with authenticated snapshot', {skip:!enabled},()=>{
 const inspected=cli('inspect','--id',backup.backupId);assert.equal(inspected.status,0,inspected.stdout);assert.equal(inspected.json.inventory.tables.find(x=>x.table==='loan').rows,1);
 const r=cli('verify','--id',backup.backupId,'--target','cloudlib_recovery'); assert.equal(r.status,0,r.stdout); assert.equal(r.json.verified.data,true); assert.equal(r.json.verified.schema,true); assert.equal(r.json.verified.tables,5);
 sql('INSERT INTO loan VALUES(11,1,false);','cloudlib_recovery');
 const changed=cli('verify','--id',backup.backupId,'--target','cloudlib_recovery');assert.notEqual(changed.status,0);assert.equal(changed.json.code,'RESTORED_DATA_MISMATCH');assert.equal(sql('SELECT count(*) FROM loan;','cloudlib_recovery'),'2');
});
function drill(options={}) {
 const r=run('powershell.exe',['-NoProfile','-File','scripts/recovery-test.ps1','-ConfigPath',cp,...(options.dry?['-DryRun']:[])]);
 let json;try{json=JSON.parse(r.stdout.trim());}catch{}return {...r,json};
}
test('public injector refuses wrong server before DROP and emits failed structured result', {skip:!enabled},()=>{
 writeFileSync(cp,JSON.stringify({formatVersion:1,method:'database-loss',target:'cloudlib_recovery',environment:'native-sql-fixture',backupConfig:bp,workerConfig:wp,checkpointFile:join(dir,'checkpoint.json'),resultFile:join(dir,'result.json'),nativeDataDirectory:join(dir,'pgdata'),systemIdentifier:'1',injectorUser:'drill_owner',timeoutSeconds:30}));
 const r=drill();assert.notEqual(r.status,0);assert.equal(r.json?.status,'GAGAL',r.stdout+r.stderr);assert.equal(r.json.code,'WRONG_SERVER');assert.equal(sql('SELECT count(*) FROM loan;','cloudlib_recovery'),'2');
});


async function until(check,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,100));}assert.fail('worker deadline');}
test('injector observes already-running automatic recovery but SQL-only fixture cannot claim business PASS', {skip:!enabled},async()=>{
 const consumer={...config,recovery:{...config.recovery,user:'drill_worker'}};writeFileSync(bp,JSON.stringify(consumer));
 const checkpoint={formatVersion:1,environment:'native-sql-fixture',backupId:backup.backupId,snapshotAt:backup.snapshotAt,appImage:backup.appImage,appCommit:backup.appCommit,loanA:{id:10,createdAt:new Date(Date.parse(backup.snapshotAt)-1000).toISOString()},loanB:{id:11,createdAt:new Date().toISOString()},reservationId:20,visitId:30,snapshotVerified:{data:true,schema:true}};
 writeFileSync(join(dir,'checkpoint.json'),JSON.stringify(checkpoint));
 worker=spawn(process.execPath,['reliability/worker.mjs','--config',wp],{windowsHide:true,stdio:'ignore'});
 await until(()=>existsSync(join(dir,'state','status.json'))&&JSON.parse(readFileSync(join(dir,'state','status.json'))).phase==='healthy');
 const current=JSON.parse(readFileSync(cp));current.systemIdentifier=config.recovery.systemIdentifier;current.latestResultFile=join(dir,'latest.json');writeFileSync(cp,JSON.stringify(current));
 const r=drill();assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(r.json.status,'GAGAL');assert.equal(r.json.code,'BUSINESS_VALIDATION_INCOMPLETE');
 assert.equal(r.json.checks.snapshotData.status,'passed');assert.equal(r.json.checks.expectedLoss.status,'passed');assert.equal(r.json.checks.authenticatedRead.status,'unavailable');
 assert.ok(r.json.workerIncidentId);assert.notEqual(r.json.workerIncidentId,r.json.testRunId);assert.ok(r.json.timings.decryptSeconds>0);assert.ok(r.json.timings.restoreSeconds>0);assert.ok(r.json.timings.snapshotValidationSeconds>0);assert.ok(r.json.timings.sqlRecoverySeconds>0);assert.equal(r.json.timings.rtoSeconds,null);assert.ok(r.json.timings.rpoSeconds>=0);
 assert.equal(sql('SELECT count(*) FROM loan;','cloudlib_recovery'),'1');assert.equal(sql('SELECT count(*) FROM loan WHERE id=11;','cloudlib_recovery'),'0');
 assert.equal(JSON.parse(readFileSync(join(dir,'result.json'))).testRunId,r.json.testRunId);
 assert.equal(JSON.parse(readFileSync(join(dir,'latest.json'))).testRunId,r.json.testRunId);
});

test('metrics bridge serves actual failed fixture identity and never invents application RTO', {skip:!enabled},async()=>{
 const bridge=spawn(process.execPath,['reliability/recovery-observer.mjs','--result',join(dir,'result.json'),'--port','20440'],{windowsHide:true,stdio:'ignore'});
 try{
  await until(()=>bridge.exitCode!==null||bridge.signalCode!==null,300).catch(()=>{});
  assert.equal(bridge.exitCode,null,'observer must remain available');
  const response=await fetch('http://127.0.0.1:20440/metrics');assert.equal(response.status,200);const metrics=await response.text();
  assert.match(metrics,/cloudlib_drill_complete\{target="cloudlib_recovery",method="database-loss",environment="native-sql-fixture"\} 0/);assert.doesNotMatch(metrics,/cloudlib_drill_rto_seconds\{/);assert.match(metrics,/cloudlib_drill_sql_recovery_seconds\{/);
  const published=await (await fetch('http://127.0.0.1:20440/result')).json();assert.equal(published.testRunId,JSON.parse(readFileSync(join(dir,'result.json'))).testRunId);assert.equal(published.status,'GAGAL');
 }finally{bridge.kill();if(bridge.exitCode===null&&bridge.signalCode===null)await new Promise(r=>bridge.once('close',r));}
});
