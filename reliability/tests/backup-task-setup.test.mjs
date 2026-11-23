import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

function fixture(run) {
 const root=resolve('reliability/.runtime/backup/task setup tests');mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(join(root,'setup-'));
 const config=join(dir,'backup.json'),env=join(dir,'private.env');
 writeFileSync(config,JSON.stringify({formatVersion:1,source:{passwordEnv:'CLOUDLIB_FIXTURE_PASSWORD'}}));
 writeFileSync(env,'CLOUDLIB_FIXTURE_PASSWORD=unused-test-password\n');
 const install=(...args)=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File','scripts/Install-CloudLibBackupTask.ps1','-ConfigPath',config,'-DefinitionOnly',...args],{encoding:'utf8',windowsHide:true,timeout:15000});
 try{run({dir,config,env,install});}finally{rmSync(dir,{recursive:true,force:true});}
}

test('backup task setup chooses a private XML path and stores only the env-file reference',()=>fixture(({dir,config,env,install})=>{
 const result=install('-EnvFile',env);assert.equal(result.status,0,result.stdout+result.stderr);
 const xml=readFileSync(join(dir,'backup-task.xml'),'utf16le');
 assert.ok(xml.includes(config));assert.ok(xml.includes('-EnvFile'));
 assert.ok(xml.includes(env));assert.ok(!xml.includes('unused-test-password'));
 assert.ok(xml.includes('2026-01-01T13:00:00Z'));assert.ok(xml.includes('<LogonType>InteractiveToken</LogonType>'));
}));

test('backup task setup refuses a password reference without a persistent env file',()=>fixture(({dir,install})=>{
 const xml=join(dir,'task.xml'),result=install('-XmlPath',xml);
 assert.notEqual(result.status,0);assert.match(result.stderr,/EnvFile/);assert.ok(!existsSync(xml));
}));

test('backup task setup refuses an env file missing the required credential',()=>fixture(({dir,env,install})=>{
 writeFileSync(env,'UNRELATED_FIXTURE=unused\n');
 const xml=join(dir,'task.xml'),result=install('-XmlPath',xml,'-EnvFile',env);
 assert.notEqual(result.status,0);assert.match(result.stderr,/CLOUDLIB_FIXTURE_PASSWORD/);assert.ok(!existsSync(xml));
}));
