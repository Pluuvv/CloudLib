import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
test('PowerShell emits structured failure when Node cannot load its private env file', () => {
 const r=spawnSync('powershell.exe',['-NoProfile','-File','scripts/recovery-test.ps1','-ConfigPath',resolve('reliability/.runtime/does-not-exist.json'),'-EnvFile',resolve('reliability/.runtime/absent-env-file')],{encoding:'utf8',windowsHide:true});
 assert.notEqual(r.status,0);let json;try{json=JSON.parse(r.stdout.trim());}catch{}
 assert.equal(json?.status,'GAGAL',r.stdout);assert.equal(json.code,'HOST_ENTRY_FAILED');assert.equal(r.stderr,'');
});
test('unverified Kubernetes baseline is rejected before any cluster operation', () => {
 mkdirSync(resolve('reliability/.runtime/drill/tests'),{recursive:true});
 const dir=mkdtempSync(resolve('reliability/.runtime/drill/tests/host-'));
 try{
  const path=resolve(dir,'config.json');writeFileSync(path,JSON.stringify({formatVersion:1,method:'pod-delete',target:'capstone/cloudlib-app',environment:'kubernetes',appOrigin:'http://cloudlib.localhost:8088',resultFile:resolve(dir,'result.json'),checkpointFile:resolve(dir,'checkpoint.json'),kubernetes:{context:'k3d-capstone',namespace:'capstone',deployment:'cloudlib-app',expectedImage:'unverified-config-image-id'}}));
  const r=spawnSync('powershell.exe',['-NoProfile','-File','scripts/recovery-test.ps1','-ConfigPath',path,'-DryRun'],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,1);const json=JSON.parse(r.stdout);assert.equal(json.status,'GAGAL');assert.equal(json.code,'INVALID_KUBERNETES_TARGET');assert.equal(json.injectedAt,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
