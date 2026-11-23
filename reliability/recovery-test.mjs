import { spawn } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { session, api, checkRecords, businessValidation, tenantInventorySql, appReady, anonymousDenied } from './recovery-business.mjs';
const now = () => new Date().toISOString();
const fail = code => { throw new Error(code); };
let c, b, w;
const result = {formatVersion:1,toolVersion:'task06-1',testRunId:randomUUID(),method:null,target:null,environment:null,status:'GAGAL',startedAt:now(),injectedAt:null,completedAt:null,observations:[],checks:{},timings:{rtoSeconds:null,rpoSeconds:null,decryptSeconds:null,restoreSeconds:null},limits:['Same-drive local backup only; off-host protection deferred.','Stage durations bracket real subprocess calls; SQL-only recovery is not full application RTO.']};
for(const check of ['preflight','databaseLoss','applicationImpact','snapshotData','tenantData','migrations','expectedLoss','appReadiness','authenticatedRead','returnLoanA','reservationVisits','crossTenantDenial'])result.checks[check]={status:'unavailable',reason:'Not observed in this run.'};
async function exec(spec,args,input,env={}) {
 return new Promise((accept,reject)=>{
  const p=spawn(spec.command,[...(spec.args??[]),...args],{windowsHide:true,env:{...process.env,...env},stdio:['pipe','pipe','ignore'],timeout:180000});
  let out='';p.stdout.on('data',d=>{out+=d;if(out.length>4000000)p.kill();});p.on('error',()=>reject(new Error('TOOL_FAILED')));p.on('close',code=>code===0?accept(out.trim()):reject(new Error('TOOL_FAILED')));p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
async function sql(text,db='postgres',readOnly=true) {
 const r=b.recovery,env={PGCONNECT_TIMEOUT:'3',PGOPTIONS:'-c statement_timeout=15000 -c timezone=UTC'+(readOnly?' -c default_transaction_read_only=on':''),PGAPPNAME:'cloudlib-recovery-test'};
 const password=c.injectorPasswordEnv;
 if(password){if(!process.env[password])fail('MISSING_CREDENTIAL');env.PGPASSWORD=process.env[password];}
 return exec(r.tools?.psql??b.tools.psql,['-XqAt','-v','ON_ERROR_STOP=1','-h',r.host??'localhost','-p',String(r.port??5432),'-U',c.injectorUser,'-d',db],text,env);
}
async function backup(command,...args) {
 const out=JSON.parse(await exec({command:process.execPath},[fileURLToPath(new URL('./backup.mjs',import.meta.url)),command,'--config',c.backupConfig,...args]));
 if(out.status!=='ok')fail('BACKUP_FAILED');return out;
}
async function main() {
 const args=process.argv.slice(2);if(args[0]!=='--config'||!isAbsolute(args[1]??'')||args.length>3||(args[2]&&args[2]!=='--dry-run'))fail('USAGE');
 c=JSON.parse(await readFile(args[1],'utf8'));
 Object.assign(result,{method:c.method,target:c.target,environment:c.environment,appOrigin:c.appOrigin??null});
 if(c.method==='pod-delete')return podDrill(args[2]==='--dry-run');
 if(c.formatVersion!==1||c.method!=='database-loss'||c.target!=='cloudlib_recovery'||!['native-sql-fixture','compose'].includes(c.environment)||!['backupConfig','workerConfig','checkpointFile','resultFile'].every(k=>isAbsolute(c[k]??''))||!/^\d+$/.test(c.systemIdentifier??'')||!/^[a-z_][a-z0-9_]*$/.test(c.injectorUser??'')||!Number.isFinite(c.timeoutSeconds)||c.timeoutSeconds<1||c.timeoutSeconds>3600)fail('INVALID_CONFIG');
 b=JSON.parse(await readFile(c.backupConfig,'utf8'));w=JSON.parse(await readFile(c.workerConfig,'utf8'));
 const id=await sql("SELECT system_identifier::text || '|' || (current_setting('server_version_num')::int/10000)::text FROM pg_control_system();");
 if(id!==c.systemIdentifier+'|17'||b.recovery.systemIdentifier!==c.systemIdentifier)fail('WRONG_SERVER');
 result.checks.targetIdentity={status:'passed',systemIdentifier:c.systemIdentifier,pgMajor:17};
 if(c.environment==='native-sql-fixture'){
  const data=resolve(await sql('SHOW data_directory;'));
  if(b.recovery.host!=='127.0.0.1'||b.recovery.port!==20439||data!==resolve(c.nativeDataDirectory??'')||!data.startsWith(resolve('reliability/.runtime/drill/tests')+sep))fail('UNSAFE_NATIVE_TARGET');
  result.limits.push('Native SQL fixture; authentication and CloudLib business acceptance are unavailable.');
 }
 await databaseDrill(args[2]==='--dry-run');
}
try {await main();}catch(e){result.code=/^[A-Z_]+$/.test(e.message)?e.message:'OPERATION_FAILED';}
result.completedAt=now();
if(c?.resultFile&&isAbsolute(c.resultFile)){
 const outputFile=c.resultFile+(process.argv.includes('--dry-run')?'.preflight.json':'');
 try{const tmp=outputFile+'.'+result.testRunId+'.tmp';await writeFile(tmp,JSON.stringify(result),{mode:0o600});await rename(tmp,outputFile);}catch{result.status='GAGAL';result.code='RESULT_WRITE_FAILED';}
}
console.log(JSON.stringify(result));process.exitCode=['LULUS','PREFLIGHT_OK'].includes(result.status)?0:1;

async function state(name) {
 return JSON.parse(c.environment==='compose'?await exec({command:'docker'},['exec','cloudlib-recovery-worker','cat','/var/lib/cloudlib-worker/'+name+'.json']):await readFile(join(w.stateDir,name+'.json'),'utf8'));
}
async function heartbeat() {
 const h=await state('heartbeat');
 const maxAge=w.intervalMs*2+5000;
 if(h.formatVersion!==1||h.target!==c.target||h.systemIdentifier!==c.systemIdentifier||h.logicalSource!==b.logicalSource||h.appImage!==b.app.image||h.appCommit!==b.app.commit||h.intervalMs!==w.intervalMs||h.candidate!==w.candidate||!Number.isFinite(Date.parse(h.observedAt))||!Number.isFinite(Date.parse(h.maintenanceObservedAt))||Date.now()-Date.parse(h.observedAt)>maxAge||Date.now()-Date.parse(h.maintenanceObservedAt)>maxAge||Date.parse(h.observedAt)>Date.now()+1000)fail('WORKER_NOT_READY');
 if(c.environment==='native-sql-fixture')try{process.kill(h.pid,0);}catch{fail('WORKER_NOT_ALIVE');}
 return h;
}
async function composeIdentity() {
 const objects=JSON.parse(await exec({command:'docker'},['inspect','cloudlib-recovery-postgres','cloudlib-recovery-app','cloudlib-recovery-worker']));
 const [pg,app,worker]=objects;
 if(objects.length!==3||objects.some(x=>x.Config?.Labels?.['com.docker.compose.project']!=='cloudlib-recovery'||!x.State?.Running)||pg.Config.Labels['com.docker.compose.service']!=='postgres'||pg.Mounts?.find(x=>x.Destination==='/var/lib/postgresql/data')?.Name!=='cloudlib-recovery-pgdata'||Object.keys(pg.NetworkSettings.Networks).join()!=='cloudlib-recovery-net'||app.Config.Labels['com.docker.compose.service']!=='app'||worker.Config.Labels['com.docker.compose.service']!=='worker')fail('UNSAFE_COMPOSE_TARGET');
 if(!/@sha256:[a-f0-9]{64}$/.test(b.app.image)||app.Config.Image!==b.app.image||!app.Config.Env.includes('DB_URL=jdbc:postgresql://postgres:5432/cloudlib_recovery')||!app.Config.Env.includes('DB_USER='+b.recovery.appRole)||!app.Config.Env.includes('OIDC_AUTH_SERVER_URL=http://host.docker.internal:8081/realms/cloudlib')||app.Config.Env.includes('QUARKUS_OIDC_ENABLED=false')||Object.keys(app.NetworkSettings.Networks).join()!=='cloudlib-recovery-net'||!app.NetworkSettings.Ports['8080/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='8089'))fail('WRONG_APPLICATION');
 const spec=b.recovery.tools?.psql??b.tools.psql;
 if(spec.command!=='docker'||!spec.args?.includes('cloudlib-recovery-postgres'))fail('UNSAFE_COMPOSE_CONNECTION');
 result.checks.isolation={status:'passed',project:'cloudlib-recovery',volume:'cloudlib-recovery-pgdata',network:'cloudlib-recovery-net',appImage:b.app.image};
}
async function databaseDrill(dry) {
 if(c.environment==='compose')await composeIdentity();
 if(w.target!==c.target||(c.environment!=='compose'&&w.backupConfig!==c.backupConfig)||w.formatVersion!==1||!Number.isSafeInteger(w.intervalMs)||w.intervalMs<100||w.intervalMs>30000)fail('WORKER_CONFIG_MISMATCH');
 const cp=JSON.parse(await readFile(c.checkpointFile,'utf8'));
 const selected=(await backup('list')).backups[0];
 if(c.environment==='compose'){
  if(w.backupConfig!=='/run/cloudlib/backup.json')fail('WORKER_CONFIG_MISMATCH');
  const visible=JSON.parse(await exec({command:'docker'},['exec','cloudlib-recovery-worker','node','/opt/cloudlib/reliability/backup.mjs','list','--config','/run/cloudlib/backup.json']));
  if(visible.status!=='ok'||!selected||visible.backups?.[0]?.backupId!==selected.backupId||visible.backups[0].sha256!==selected.sha256)fail('WORKER_SNAPSHOT_MISMATCH');
 }
 if(!selected||selected.backupId!==cp.backupId||selected.snapshotAt!==cp.snapshotAt||selected.appImage!==b.app.image||selected.appCommit!==b.app.commit||cp.appImage!==selected.appImage||cp.appCommit!==selected.appCommit||cp.environment!==c.environment||cp.formatVersion!==1||cp.snapshotVerified?.data!==true||cp.snapshotVerified?.schema!==true||![cp.loanA?.id,cp.loanB?.id,cp.reservationId,cp.visitId].every(Number.isSafeInteger)||cp.loanA.id===cp.loanB.id||!(Date.parse(cp.loanA.createdAt)<Date.parse(selected.snapshotAt)&&Date.parse(selected.snapshotAt)<Date.parse(cp.loanB.createdAt)))fail('INVALID_CHECKPOINT');
 Object.assign(result,{selectedBackupId:selected.backupId,snapshotAt:selected.snapshotAt,expectedLoss:{loanB:true,reason:'Committed after the selected snapshot; not expected to recover.'}});
 const before=await state('status');
 if(!['healthy','open'].includes(before.phase)||before.requiresOperator||before.target!==c.target||before.systemIdentifier!==c.systemIdentifier)fail('WORKER_NOT_READY');
 const h=await heartbeat();await new Promise(r=>setTimeout(r,Math.max(300,w.intervalMs+100)));
 if((await heartbeat()).observedAt===h.observedAt)fail('WORKER_NOT_OBSERVING');
 result.checks.independentWorker={status:'passed',observedAt:h.observedAt};
 const ids=await sql(`SELECT (SELECT count(*) FROM loan WHERE id=${cp.loanA.id})::text || '|' || (SELECT count(*) FROM loan WHERE id=${cp.loanB.id})::text;`,'cloudlib_recovery');
 if(ids!=='1|1')fail('MISSING_BASELINE_TRANSACTIONS');
 await snapshotCheckpoint(cp,selected);
 let auth;
 if(c.environment==='compose'){
  if(c.appOrigin!=='http://localhost:8089')fail('UNSAFE_APP_ORIGIN');
  await anonymousDenied(c.appOrigin);auth=await session(c.appOrigin);await checkRecords(auth,cp);
 }
 result.checks.preflight={status:'passed'};
 if(dry){result.status='PREFLIGHT_OK';return;}
 // Recheck identities and archive selection immediately before the only destructive statement.
 if(c.environment==='compose')await composeIdentity();
 await heartbeat();
 if((await backup('list')).backups[0]?.backupId!==selected.backupId)fail('SNAPSHOT_CHANGED');
 const identity=await sql("SELECT system_identifier::text FROM pg_control_system();");if(identity!==c.systemIdentifier)fail('WRONG_SERVER');
 result.injectedAt=now();result.timings.rpoSeconds=(Date.parse(result.injectedAt)-Date.parse(selected.snapshotAt))/1000;
 const dropped=await sql("DROP DATABASE cloudlib_recovery WITH (FORCE); SELECT count(*) FROM pg_database WHERE datname='cloudlib_recovery';",'postgres',false);
 if(dropped!=='0')fail('LOSS_NOT_OBSERVED');
 result.checks.databaseLoss={status:'passed',observedAt:now(),catalogCount:0};
 if(auth){
  try{await api(auth,'/loans/history','student');fail('APP_IMPACT_NOT_OBSERVED');}catch(e){
   if(!(e.status>=500||['TypeError','TimeoutError'].includes(e.name)))fail('APP_IMPACT_NOT_CONFIRMED');
   result.checks.applicationImpact={status:'passed',observedAt:now(),httpStatus:e.status??null,operation:'GET /loans/history'};
  }
 }
 const end=Date.parse(result.injectedAt)+c.timeoutSeconds*1000;
 let current;
 while(Date.now()<end){
  current=await state('status');
  if(current.incidentId&&current.incidentId!==before.incidentId){
   const last=result.observations.at(-1);if(last?.phase!==current.phase)result.observations.push({phase:current.phase,observedAt:now(),workerUpdatedAt:current.updatedAt,workerIncidentId:current.incidentId});
   if(current.phase==='failed')fail('WORKER_FAILED');
   if(current.phase==='open')break;
  }
  await new Promise(r=>setTimeout(r,100));
 }
 if(current?.phase!=='open'||current.incidentId===before.incidentId)fail('RECOVERY_TIMEOUT');
 if(current.selectedBackupId!==selected.backupId||current.snapshotAt!==selected.snapshotAt||current.systemIdentifier!==c.systemIdentifier)fail('WRONG_RECOVERY_SNAPSHOT');
 result.workerIncidentId=current.incidentId;
 const delta=(a,z)=>Number.isFinite(Date.parse(a))&&Number.isFinite(Date.parse(z))?(Date.parse(z)-Date.parse(a))/1000:null;
 Object.assign(result.timings,{detectionSeconds:delta(result.injectedAt,current.detectedAt),backupSelectionSeconds:delta(current.detectedAt,current.pickBackupAt),decryptRestoreSeconds:delta(current.restoreStartedAt,current.restoreCompletedAt),decryptSeconds:delta(current.stages?.decryptStartedAt,current.stages?.decryptCompletedAt),restoreSeconds:delta(current.stages?.restoreStartedAt,current.stages?.restoreCompletedAt),snapshotValidationSeconds:delta(current.stages?.validationStartedAt,current.stages?.validationCompletedAt)});
 const validated=await backup('verify','--id',selected.backupId,'--target','cloudlib_recovery');
 result.checks.snapshotData={status:'passed',...validated.verified};
 if(c.environment==='compose'){
  const tenants=(await sql(tenantInventorySql,'cloudlib_recovery')).split('\n').filter(Boolean).map(JSON.parse);
  if(JSON.stringify(tenants)!==JSON.stringify(cp.tenantInventory))fail('TENANT_DATA_MISMATCH');
  result.checks.tenantData={status:'passed',tablesAndTenants:tenants.map(({table,tenant,rows})=>({table,tenant,rows}))};
 }
 if(await sql('SELECT count(*) FROM flyway_schema_history WHERE NOT success;','cloudlib_recovery')!=='0')fail('MIGRATION_VALIDATION_FAILED');
 result.checks.migrations={status:'passed',snapshotMatched:true};
 const lost=await sql(`SELECT (SELECT count(*) FROM loan WHERE id=${cp.loanA.id})::text || '|' || (SELECT count(*) FROM loan WHERE id=${cp.loanB.id})::text || '|' || (SELECT count(*) FROM computer_reservation WHERE id=${cp.reservationId})::text || '|' || (SELECT count(*) FROM visitor_log WHERE id=${cp.visitId})::text;`,'cloudlib_recovery');
 if(lost!=='1|0|1|1')fail('CHECKPOINT_MISMATCH');
 result.checks.expectedLoss={status:'passed',loanAPresent:true,loanBAbsent:true,reservationPresent:true,visitPresent:true};
 result.timings.sqlRecoverySeconds=delta(result.injectedAt,now());
 if(!auth){
  for(const name of ['authenticatedRead','returnLoanA','reservationVisits','crossTenantDenial','applicationImpact'])result.checks[name]={status:'unavailable',reason:'Native SQL fixture has no authenticated CloudLib application.'};
  fail('BUSINESS_VALIDATION_INCOMPLETE');
 }
 const validationAt=now();
 let ready=false;
 while(Date.now()<end){try{if(await appReady(c.appOrigin)){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}
 if(!ready)fail('APP_READINESS_TIMEOUT');
 result.checks.appReadiness={status:'passed',observedAt:now()};
 await businessValidation(await session(c.appOrigin),cp);
 for(const name of ['authenticatedRead','returnLoanA','reservationVisits','crossTenantDenial'])result.checks[name]={status:'passed',observedAt:now()};
 result.timings.validationSeconds=delta(validationAt,now());result.timings.rtoSeconds=delta(result.injectedAt,now());
 if(result.timings.rtoSeconds>3600||result.timings.rpoSeconds>86400||Date.now()>end)fail('RECOVERY_GOAL_EXCEEDED');
 result.status='LULUS';
}


async function podDrill(dry) {
 const k=c.kubernetes;
 if(c.environment!=='kubernetes'||c.target!=='capstone/cloudlib-app'||c.appOrigin!=='http://cloudlib.localhost:8088'||!isAbsolute(c.resultFile??'')||!isAbsolute(c.checkpointFile??'')||!k||k.context!=='k3d-capstone'||k.namespace!=='capstone'||k.deployment!=='cloudlib-app'||!/@sha256:[a-f0-9]{64}$/.test(k.expectedImage??'')||!k.namespaceUid||!k.server)fail('INVALID_KUBERNETES_TARGET');
 const kubectl=(...a)=>exec({command:'kubectl'},['--context','k3d-capstone','--request-timeout=10s',...a]);
 if(await exec({command:'kubectl'},['config','current-context'])!=='k3d-capstone')fail('WRONG_CONTEXT');
 const cluster=JSON.parse(await kubectl('config','view','--minify','-o','json'));
 if(cluster.clusters?.[0]?.cluster?.server!==k.server)fail('WRONG_CLUSTER');
 const namespace=JSON.parse(await kubectl('get','namespace','capstone','-o','json'));
 if(namespace.metadata.uid!==k.namespaceUid)fail('WRONG_NAMESPACE');
 const deployment=JSON.parse(await kubectl('-n','capstone','get','deployment','cloudlib-app','-o','json'));
 const app=deployment.spec.template.spec.containers.find(x=>x.name==='cloudlib-app')??deployment.spec.template.spec.containers[0];
 if(app.image!==k.expectedImage||deployment.status.observedGeneration!==deployment.metadata.generation||deployment.status.availableReplicas!==deployment.spec.replicas)fail('WRONG_APPLICATION_BASELINE');
 const environment=Object.fromEntries((app.env??[]).filter(x=>x.value!==undefined).map(x=>[x.name,x.value]));
 for(const from of app.envFrom??[])if(from.configMapRef){const cm=JSON.parse(await kubectl('-n','capstone','get','configmap',from.configMapRef.name,'-o','json'));Object.assign(environment,cm.data);}
 if(!environment.OIDC_AUTH_SERVER_URL||environment.QUARKUS_OIDC_ENABLED==='false')fail('OIDC_BASELINE_DISABLED');
 const cp=JSON.parse(await readFile(c.checkpointFile,'utf8'));
 if(cp.formatVersion!==1||cp.appImage!==k.expectedImage||!Number.isSafeInteger(cp.loanA?.id))fail('INVALID_CHECKPOINT');
 const auth=await session(c.appOrigin);
 await anonymousDenied(c.appOrigin);
 const before=(await api(auth,'/loans/history','staff')).find(x=>x.id===cp.loanA.id);
 if(!before)fail('DURABLE_TRANSACTION_MISSING');
 const podList=()=>kubectl('-n','capstone','get','pods','-l',Object.entries(deployment.spec.selector.matchLabels).map(([a,z])=>a+'='+z).join(','),'-o','json').then(JSON.parse);
 const owned=async()=>{const sets=JSON.parse(await kubectl('-n','capstone','get','replicasets','-o','json'));return new Set(sets.items.filter(x=>x.metadata.ownerReferences?.some(o=>o.uid===deployment.metadata.uid&&o.controller)).map(x=>x.metadata.uid));};
 const sets=await owned(),pods=(await podList()).items.filter(x=>x.metadata.ownerReferences?.some(o=>sets.has(o.uid)&&o.controller)&&x.status.conditions?.some(y=>y.type==='Ready'&&y.status==='True'));
 const old=pods.find(x=>x.spec.containers.some(y=>y.image===k.expectedImage));if(!old)fail('NO_BASELINE_POD');
 result.checks.preflight={status:'passed',context:k.context,namespaceUid:k.namespaceUid,deploymentUid:deployment.metadata.uid,image:k.expectedImage,podUid:old.metadata.uid};
 if(dry){result.status='PREFLIGHT_OK';return;}
 const rechecked=JSON.parse(await kubectl('-n','capstone','get','pod',old.metadata.name,'-o','json'));
 if(rechecked.metadata.uid!==old.metadata.uid||rechecked.metadata.deletionTimestamp)fail('POD_CHANGED');
 result.injectedAt=now();
 // Kubernetes DeleteOptions binds deletion to the observed UID, avoiding a name-reuse race.
 const proxy=JSON.stringify({apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:old.metadata.uid},gracePeriodSeconds:30});
 await exec({command:'kubectl'},['--context','k3d-capstone','--request-timeout=10s','delete','--raw','/api/v1/namespaces/capstone/pods/'+old.metadata.name,'-f','-'],proxy);
 result.checks.podDeleted={status:'passed',podUid:old.metadata.uid,observedAt:now()};
 const deadline=Date.parse(result.injectedAt)+120000;
 let replacement;
 while(Date.now()<deadline){
  replacement=(await podList()).items.find(x=>x.metadata.uid!==old.metadata.uid&&!pods.some(p=>p.metadata.uid===x.metadata.uid)&&x.metadata.ownerReferences?.some(o=>sets.has(o.uid))&&!x.metadata.deletionTimestamp&&x.spec.containers.some(y=>y.image===k.expectedImage)&&x.status.conditions?.some(y=>y.type==='Ready'&&y.status==='True'));
  if(replacement){try{if(await appReady(c.appOrigin)){const after=(await api(await session(c.appOrigin),'/loans/history','staff')).find(x=>x.id===cp.loanA.id);if(JSON.stringify(after)===JSON.stringify(before))break;}}catch{}}
  replacement=null;await new Promise(r=>setTimeout(r,500));
 }
 if(!replacement)fail('POD_RECOVERY_TIMEOUT');
 result.checks.replacementReady={status:'passed',podUid:replacement.metadata.uid,observedAt:now()};result.checks.durableTransaction={status:'passed'};result.checks.appReadiness={status:'passed'};
 result.timings.rtoSeconds=(Date.now()-Date.parse(result.injectedAt))/1000;if(result.timings.rtoSeconds>120)fail('POD_RECOVERY_TIMEOUT');result.status='LULUS';
}

async function snapshotCheckpoint(cp,selected) {
 const inspected=await backup('inspect','--id',selected.backupId);
 const q=s=>'"'+s.replaceAll('"','""')+'"',lit=s=>"'"+s.replaceAll("'","''")+"'";
 const statements=inspected.inventory.tables.map(table=>{
  const name=q(table.schema)+'.'+q(table.table);let from=name;
  if(table.schema==='public'&&table.table==='loan')from='(SELECT * FROM '+name+' WHERE id<>'+cp.loanB.id+')';
  if(c.environment==='compose'&&table.schema==='public'&&table.table==='book_copy')from="(SELECT (jsonb_populate_record(NULL::public.book_copy,to_jsonb(bc)||CASE WHEN bc.id=(SELECT book_copy_id FROM public.loan WHERE id="+cp.loanB.id+") THEN '{\"status\":\"AVAILABLE\"}'::jsonb ELSE '{}'::jsonb END)).* FROM public.book_copy bc)";
  return 'SELECT json_build_object(\'schema\','+lit(table.schema)+',\'table\','+lit(table.table)+',\'rows\',count(*),\'fingerprint\',md5(coalesce(string_agg(to_jsonb(t)::text,E\'\\n\' ORDER BY to_jsonb(t)::text),\'\'))) FROM '+from+' t;';
 });
 const projected=(await sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+statements.join('\n')+'\nCOMMIT;','cloudlib_recovery')).split('\n').filter(Boolean).map(JSON.parse);
 if(JSON.stringify(projected)!==JSON.stringify(inspected.inventory.tables))fail('SNAPSHOT_CHECKPOINT_MISMATCH');
 for(const sequence of inspected.inventory.sequences){
  const actual=JSON.parse(await sql('SELECT json_build_object(\'lastValue\',last_value::text,\'isCalled\',is_called) FROM '+q(sequence.schema)+'.'+q(sequence.sequence)+';','cloudlib_recovery'));
  const expected=c.environment==='compose'&&sequence.schema==='public'&&sequence.sequence==='loan_id_seq'?String(BigInt(sequence.lastValue)+1n):sequence.lastValue;
  if(actual.lastValue!==expected||actual.isCalled!==sequence.isCalled)fail('SEQUENCE_CHECKPOINT_MISMATCH');
 }
 const r=b.recovery,env={PGCONNECT_TIMEOUT:'3',PGOPTIONS:'-c default_transaction_read_only=on -c timezone=UTC'};
 if(c.injectorPasswordEnv)env.PGPASSWORD=process.env[c.injectorPasswordEnv];
 const schema=await exec(r.tools?.pg_dump??b.tools.pg_dump,['-h',r.host??'localhost','-p',String(r.port??5432),'-U',c.injectorUser,'-d','cloudlib_recovery','--schema-only','--no-owner','--no-privileges'],undefined,env);
 const fingerprint=createHash('sha256').update(schema.split(/\r?\n/).filter(line=>!line.startsWith('--')&&!line.startsWith('\\restrict')&&!line.startsWith('\\unrestrict')&&line.trim()).join('\n')).digest('hex');
 if(fingerprint!==inspected.inventory.schemaFingerprint)fail('SCHEMA_CHECKPOINT_MISMATCH');
 if(c.environment==='compose'&&(!Array.isArray(cp.tenantInventory)||cp.tenantInventory.length===0))fail('TENANT_CHECKPOINT_REQUIRED');
 result.checks.snapshotCheckpoint={status:'passed',authenticatedBackupId:inspected.backup.backupId,projectedTables:projected.length};
}
