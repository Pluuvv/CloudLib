import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { appReady } from './recovery-business.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--result','--port','--listen'].includes(args[i])||options[args[i]])throw new Error('USAGE');options[args[i]]=args[i+1];}
const port=Number(options['--port']??19090),host=options['--listen']??'127.0.0.1';
if(!isAbsolute(options['--result']??'')||!Number.isSafeInteger(port)||port<1024||port>65535||!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('INVALID_CONFIG');
const checks=['targetIdentity','isolation','independentWorker','preflight','databaseLoss','applicationImpact','snapshotData','tenantData','migrations','expectedLoss','appReadiness','authenticatedRead','returnLoanA','reservationVisits','crossTenantDenial','podDeleted','replacementReady','durableTransaction'];
createServer(async(req,res)=>{
 try{
  const result=JSON.parse(await readFile(options['--result'],'utf8'));
  if(result.formatVersion!==1||!['cloudlib_recovery','capstone/cloudlib-app'].includes(result.target)||!['database-loss','pod-delete'].includes(result.method)||!['compose','native-sql-fixture','kubernetes'].includes(result.environment))throw new Error('NO_VALID_RESULT');
  if(req.url==='/result'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;}
  if(req.url!=='/metrics'){res.writeHead(404);res.end();return;}
  const labels=`target="${result.target}",method="${result.method}",environment="${result.environment}"`;
  const lines=[];const metric=(name,value,extra='')=>{if(Number.isFinite(value))lines.push(`cloudlib_drill_${name}{${labels}${extra}} ${value}`);};
  metric('complete',result.status==='LULUS'?1:0);
  metric('run_started_seconds',Date.parse(result.startedAt)/1000);metric('injected_seconds',Date.parse(result.injectedAt)/1000);metric('completed_seconds',Date.parse(result.completedAt)/1000);
  for(const [key,name]of Object.entries({rtoSeconds:'rto_seconds',rpoSeconds:'rpo_seconds',sqlRecoverySeconds:'sql_recovery_seconds',detectionSeconds:'stage_seconds',decryptSeconds:'stage_seconds',restoreSeconds:'stage_seconds',snapshotValidationSeconds:'stage_seconds',validationSeconds:'stage_seconds'})){
   const value=result.timings?.[key];if(typeof value==='number')metric(name,value,name==='stage_seconds'?`,stage="${key}"`:'');
  }
  metric('rto_goal_seconds',result.method==='pod-delete'?120:3600);if(result.method==='database-loss')metric('rpo_goal_seconds',86400);
  for(const check of checks){const status=result.checks?.[check]?.status;metric('check',status==='passed'?1:status==='failed'?0:-1,`,check="${check}"`);}
  const origin=result.method==='database-loss'&&result.environment==='compose'?'http://localhost:8089':result.method==='pod-delete'&&result.environment==='kubernetes'?'http://cloudlib.localhost:8088':null;
  if(origin){try{metric('app_ready',await appReady(origin)?1:0);}catch{metric('app_ready',0);}}
  metric('result_readable',1);res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});res.end(lines.join('\n')+'\n');
 }catch{res.writeHead(503,{'Content-Type':'text/plain'});res.end('No validated recovery result available.\n');}
}).listen(port,host,()=>console.log(JSON.stringify({formatVersion:1,status:'listening',host,port})));
