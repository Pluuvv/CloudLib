// External setup only. The injector never imports or starts this preparer.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { session, api, createLoan } from './recovery-business.mjs';
const fail=code=>{throw new Error(code);};
function run(command,args,input,env={}){const r=spawnSync(command,args,{input,encoding:'utf8',windowsHide:true,timeout:180000,env:{...process.env,...env}});if(r.status!==0)fail('SETUP_TOOL_FAILED');return r.stdout.trim();}
try{
 const [phase,flag,path]=process.argv.slice(2);if(!['prepare-a','seal-b'].includes(phase)||flag!=='--config'||!isAbsolute(path??''))fail('USAGE');
 const c=JSON.parse(await readFile(path,'utf8')),b=JSON.parse(await readFile(c.backupConfig,'utf8'));
 if(c.environment!=='compose'||c.appOrigin!=='http://localhost:8089'||c.target!=='cloudlib_recovery'||!isAbsolute(c.checkpointFile??''))fail('UNSAFE_SETUP');
 const [pg,app]=JSON.parse(run('docker',['inspect','cloudlib-recovery-postgres','cloudlib-recovery-app']));
 if([pg,app].some(x=>x.Config.Labels['com.docker.compose.project']!=='cloudlib-recovery'||!x.State.Running)||pg.Mounts.find(x=>x.Destination==='/var/lib/postgresql/data')?.Name!=='cloudlib-recovery-pgdata'||Object.keys(pg.NetworkSettings.Networks).join()!=='cloudlib-recovery-net'||pg.Config.Labels['com.docker.compose.service']!=='postgres'||app.Config.Labels['com.docker.compose.service']!=='app'||Object.keys(app.NetworkSettings.Networks).join()!=='cloudlib-recovery-net'||!app.NetworkSettings.Ports['8080/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='8089')||!app.Config.Env.includes('DB_USER='+b.recovery.appRole)||app.Config.Env.includes('QUARKUS_OIDC_ENABLED=false')||app.Config.Image!==b.app.image||!/@sha256:[a-f0-9]{64}$/.test(b.app.image)||!app.Config.Env.includes('DB_URL=jdbc:postgresql://postgres:5432/cloudlib_recovery')||!app.Config.Env.includes('OIDC_AUTH_SERVER_URL=http://host.docker.internal:8081/realms/cloudlib'))fail('UNSAFE_SETUP');
 const r=b.recovery,spec=r.tools?.psql??b.tools.psql,env={PGCONNECT_TIMEOUT:'3',PGOPTIONS:'-c timezone=UTC -c default_transaction_read_only=on'};
 if(c.injectorPasswordEnv){if(!process.env[c.injectorPasswordEnv])fail('MISSING_CREDENTIAL');env.PGPASSWORD=process.env[c.injectorPasswordEnv];}
 const sql=text=>run(spec.command,[...(spec.args??[]),'-XqAt','-v','ON_ERROR_STOP=1','-h',r.host??'localhost','-p',String(r.port??5432),'-U',c.injectorUser,'-d','cloudlib_recovery'],text,env);
 if(sql("SELECT system_identifier::text || '|' || (current_setting('server_version_num')::int/10000)::text FROM pg_control_system();")!==c.systemIdentifier+'|17'||r.systemIdentifier!==c.systemIdentifier)fail('WRONG_SERVER');
 const auth=await session(c.appOrigin);let cp;
 if(phase==='prepare-a'){
  try{await readFile(c.checkpointFile);fail('CHECKPOINT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  const copies=(await api(auth,'/books/copies')).filter(x=>x.status==='AVAILABLE');if(copies.length<2)fail('TWO_AVAILABLE_COPIES_REQUIRED');
  const loanA=await createLoan(auth,copies[0]);
  const [computer]=await api(auth,'/computers','student');if(!computer)fail('COMPUTER_REQUIRED');
  const reservation=await api(auth,'/computers/reservations','student',201,{computerId:computer.id,slotStart:new Date(Date.now()+86400000).toISOString()});
  const visit=await api(auth,'/attendance/checkin','student',201,{});
  cp={formatVersion:1,environment:'compose',preparedAt:new Date().toISOString(),appImage:b.app.image,appCommit:b.app.commit,loanA,reservationId:reservation.reservationId,visitId:visit.checkInId,loanBCopy:{barcode:copies[1].barcode},producerDatabase:'cloudlib_recovery'};
 }else{
  cp=JSON.parse(await readFile(c.checkpointFile,'utf8'));if(cp.loanB||cp.backupId||cp.environment!=='compose'||cp.appImage!==b.app.image||cp.appCommit!==b.app.commit)fail('INVALID_CHECKPOINT');
  const listed=JSON.parse(run(process.execPath,['reliability/backup.mjs','list','--config',c.backupConfig]));const selected=listed.backups?.[0];if(!selected||!(Date.parse(cp.preparedAt)<Date.parse(selected.snapshotAt)))fail('SNAPSHOT_AFTER_A_REQUIRED');
  const verified=JSON.parse(run(process.execPath,['reliability/backup.mjs','verify','--config',c.backupConfig,'--id',selected.backupId,'--target','cloudlib_recovery']));if(verified.status!=='ok'||!verified.verified.data||!verified.verified.schema)fail('SNAPSHOT_MISMATCH');
  const a=await api(auth,'/loans/active','student'),reservations=await api(auth,'/computers/reservations','student'),visits=await api(auth,'/attendance');
  if(!a.some(x=>x.id===cp.loanA.id)||!reservations.some(x=>x.id===cp.reservationId)||!visits.some(x=>x.id===cp.visitId))fail('CHECKPOINT_DATA_MISSING');
  cp.tenantInventory=sql("SELECT format('SELECT json_build_object(''table'',%L,''tenant'',tenant.code,''rows'',count(record.id),''fingerprint'',md5(coalesce(string_agg(to_jsonb(record)::text,E''\\n'' ORDER BY record.id),''''))) FROM tenant LEFT JOIN %I record ON record.tenant_id=tenant.id GROUP BY tenant.code ORDER BY tenant.code;', tablename,tablename) FROM pg_tables WHERE schemaname='public' AND tablename IN ('book','book_copy','loan','computer','computer_reservation','visitor_log') ORDER BY tablename \\gexec").split('\n').filter(Boolean).map(JSON.parse);
  Object.assign(cp,{backupId:selected.backupId,snapshotAt:selected.snapshotAt,snapshotVerified:verified.verified,snapshotVerifiedAt:verified.checkedAt,loanB:await createLoan(auth,cp.loanBCopy),sealedAt:new Date().toISOString()});delete cp.loanBCopy;
 }
 const temp=c.checkpointFile+'.tmp';await writeFile(temp,JSON.stringify(cp),{mode:0o600,flag:'wx'});await rename(temp,c.checkpointFile);
 console.log(JSON.stringify({formatVersion:1,status:'ok',phase,checkpointFile:c.checkpointFile,backupId:cp.backupId??null}));
}catch(e){console.log(JSON.stringify({formatVersion:1,status:'error',code:/^[A-Z_]+$/.test(e.message)?e.message:'SETUP_FAILED'}));process.exitCode=1;}
