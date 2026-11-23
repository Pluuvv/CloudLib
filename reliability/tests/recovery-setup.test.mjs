import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const enabled=Boolean(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN);
const tool=n=>join(process.env.CLOUDLIB_BACKUP_TEST_PG_BIN,n+(process.platform==='win32'?'.exe':''));
let dir, server, requests=0, identity;
const run=(command,args,input)=>spawnSync(command,args,{input,encoding:'utf8',windowsHide:true,timeout:90000,...(args.includes('start')?{stdio:'ignore'}:{})});
before(async()=>{
 if(!enabled)return;
 mkdirSync(resolve('reliability/.runtime/drill/tests'),{recursive:true});dir=mkdtempSync(resolve('reliability/.runtime/drill/tests/setup-'));
 assert.equal(run(tool('initdb'),['-D',join(dir,'pgdata'),'-U','setup_owner','--auth=trust','--no-locale','--encoding=UTF8']).status,0);
 assert.equal(run(tool('pg_ctl'),['-D',join(dir,'pgdata'),'-l',join(dir,'pg.log'),'-o','-h 127.0.0.1 -p 20449','-w','start']).status,0);
 const sql=run(tool('psql'),['-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','20449','-U','setup_owner','-d','postgres'],'CREATE DATABASE cloudlib_recovery; SELECT system_identifier FROM pg_control_system();');assert.equal(sql.status,0);identity=sql.stdout.trim();
 server=createServer((req,res)=>{requests++;res.writeHead(503);res.end();});await new Promise((accept,reject)=>{server.once('error',reject);server.listen(8089,'127.0.0.1',accept);});
 // Stub only Docker inspection at its external process boundary; SQL uses real PG17.
 writeFileSync(join(dir,'inspect-preload.mjs'),`import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {readFileSync} from 'node:fs'; const original=cp.spawnSync; cp.spawnSync=(command,args,options)=>command==='docker'&&args.join(' ')==='inspect cloudlib-recovery-postgres cloudlib-recovery-app'?{status:0,stdout:readFileSync(process.env.CLOUDLIB_SETUP_INSPECT,'utf8')}:original(command,args,options); syncBuiltinESMExports();`);
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(dir){run(tool('pg_ctl'),['-D',join(dir,'pgdata'),'-m','fast','-w','stop']);rmSync(dir,{recursive:true,force:true});}});
function inspected(){
 const config=service=>({'com.docker.compose.project':'cloudlib-recovery','com.docker.compose.service':service});
 return [{Config:{Labels:config('postgres')},State:{Running:true},Mounts:[{Destination:'/var/lib/postgresql/data',Name:'cloudlib-recovery-pgdata'}],NetworkSettings:{Networks:{'cloudlib-recovery-net':{}}}}, {Config:{Labels:config('app'),Image:'registry.example/cloudlib@sha256:'+'a'.repeat(64),Env:['DB_URL=jdbc:postgresql://postgres:5432/cloudlib_recovery','DB_USER=fixture_app','OIDC_AUTH_SERVER_URL=http://host.docker.internal:8081/realms/cloudlib']},State:{Running:true},NetworkSettings:{Networks:{'cloudlib-recovery-net':{}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'8089'}]}}}];
}
async function preparer(phase,objects){
 const bp=join(dir,'backup.json'),path=join(dir,'config.json');
 writeFileSync(bp,JSON.stringify({app:{image:objects[1].Config.Image,commit:'fixture'},recovery:{host:'127.0.0.1',port:20449,appRole:'fixture_app',systemIdentifier:identity},tools:{psql:{command:tool('psql')}}}));
 writeFileSync(path,JSON.stringify({environment:'compose',appOrigin:'http://localhost:8089',target:'cloudlib_recovery',backupConfig:bp,checkpointFile:join(dir,'checkpoint.json'),injectorUser:'setup_owner',systemIdentifier:identity}));
 const inspection=join(dir,'inspection.json');writeFileSync(inspection,JSON.stringify(objects));
 const env={...process.env,CLOUDLIB_SETUP_INSPECT:inspection};delete env.CLOUDLIB_PETUGAS_PASSWORD;delete env.CLOUDLIB_MAHASISWA_PASSWORD;
 return new Promise((accept,reject)=>{const p=spawn(process.execPath,['--import',pathToFileURL(join(dir,'inspect-preload.mjs')).href,'reliability/recovery-checkpoint.mjs',phase,'--config',path],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>accept({code,json:JSON.parse(out),err}));});
}
const cases={
 'wrong app network':app=>{app.NetworkSettings.Networks={'another-network':{}};},
 'missing port publication':app=>{app.NetworkSettings.Ports={};},
 'wrong host port':app=>{app.NetworkSettings.Ports['8080/tcp'][0].HostPort='8090';},
 'unverified IPv6 binding':app=>{app.NetworkSettings.Ports['8080/tcp'][0].HostIp='::1';},
 'wrong app service':app=>{app.Config.Labels['com.docker.compose.service']='another-app';},
 'wrong database user':app=>{app.Config.Env[1]='DB_USER=another_user';},
 'disabled OIDC':app=>{app.Config.Env.push('QUARKUS_OIDC_ENABLED=false');}
};
for(const phase of ['prepare-a','seal-b'])for(const [name,mutate]of Object.entries(cases))test(`${phase} rejects ${name} before authentication or HTTP writes`,{skip:!enabled},async()=>{
 const objects=inspected();mutate(objects[1]);const r=await preparer(phase,objects);assert.notEqual(r.code,0);assert.equal(r.json.code,'UNSAFE_SETUP');assert.equal(requests,0);assert.equal(r.err,'');
});
