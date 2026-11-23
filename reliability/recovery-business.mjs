import { loginAs, fixtureMemberRef } from './test/keycloak-login.mjs';
const fail = code => { throw new Error(code); };
export const tenantInventorySql = "SELECT format('SELECT json_build_object(''table'',%L,''tenant'',tenant.code,''rows'',count(record.id),''fingerprint'',md5(coalesce(string_agg(to_jsonb(record)::text,E''\\n'' ORDER BY record.id),''''))) FROM tenant LEFT JOIN %I record ON record.tenant_id=tenant.id GROUP BY tenant.code ORDER BY tenant.code;', tablename,tablename) FROM pg_tables WHERE schemaname='public' AND tablename IN ('book','book_copy','loan','computer','computer_reservation','visitor_log') ORDER BY tablename \\gexec";
export async function session(origin) {
 if (!['http://localhost:8089','http://cloudlib.localhost:8088'].includes(origin)) fail('UNSAFE_APP_ORIGIN');
 return {origin,staff:await loginAs('petugas',origin+'/'),student:await loginAs('mahasiswa',origin+'/')};
}
export async function api(s,path,role='staff',expected=200,body,tenant) {
 const address=new URL(s.origin+path);if(['localhost','cloudlib.localhost'].includes(address.hostname))address.hostname='127.0.0.1';
 const response=await fetch(address,{method:body===undefined?'GET':'POST',headers:{Host:new URL(s.origin).host,Authorization:'Bearer '+s[role],...(body===undefined?{}:{'Content-Type':'application/json'}),...(tenant?{'X-Tenant':tenant}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 if(response.status!==expected){const error=new Error('BUSINESS_HTTP_FAILED');error.status=response.status;throw error;}
 return expected<300?response.json():null;
}
export async function appReady(origin){
 if(!['http://localhost:8089','http://cloudlib.localhost:8088'].includes(origin))fail('UNSAFE_APP_ORIGIN');
 const address=new URL(origin+'/q/health/ready');if(['localhost','cloudlib.localhost'].includes(address.hostname))address.hostname='127.0.0.1';
 return (await fetch(address,{headers:{Host:new URL(origin).host},signal:AbortSignal.timeout(2000)})).ok;
}
export async function anonymousDenied(origin){
 const address=new URL(origin+'/books');if(['localhost','cloudlib.localhost'].includes(address.hostname))address.hostname='127.0.0.1';
 if((await fetch(address,{headers:{Host:new URL(origin).host},signal:AbortSignal.timeout(5000)})).status!==401)fail('OIDC_NOT_ENFORCED');
}
export async function checkRecords(s,cp,postRestore=false) {
 const history=await api(s,'/loans/history','student');
 if(!history.some(x=>x.id===cp.loanA.id&&x.memberRef===fixtureMemberRef&&!x.returnedAt)||history.some(x=>x.id===cp.loanB.id)!==!postRestore)fail('LOAN_CHECKPOINT_MISMATCH');
 const reservations=await api(s,'/computers/reservations','student'),visits=await api(s,'/attendance');
 if(!reservations.some(x=>x.id===cp.reservationId&&x.memberRef===fixtureMemberRef)||!visits.some(x=>x.id===cp.visitId&&x.memberRef===fixtureMemberRef))fail('RESERVATION_VISIT_MISMATCH');
}
export async function businessValidation(s,cp,{returnLoan=true}={}) {
 await checkRecords(s,cp,true);
 for(const path of ['/loans/history','/computers/reservations','/attendance'])await api(s,path,'staff',403,undefined,'poltek');
 await api(s,'/loans','staff',404,{barcode:'POL-K8-001',memberRef:fixtureMemberRef});
 if(returnLoan){
  const returned=await api(s,'/loans/return','staff',200,{barcode:cp.loanA.barcode});
  const copies=await api(s,'/books/copies'),history=await api(s,'/loans/history','student');
  if(returned.loanId!==cp.loanA.id||returned.status!=='AVAILABLE'||!copies.some(x=>x.barcode===cp.loanA.barcode&&x.status==='AVAILABLE')||!history.some(x=>x.id===cp.loanA.id&&x.returnedAt))fail('RETURN_COPY_INCONSISTENT');
 }
}
export async function createLoan(s,copy) {
 const loan=await api(s,'/loans','staff',201,{barcode:copy.barcode,memberRef:fixtureMemberRef});
 return {id:loan.loanId,barcode:copy.barcode,createdAt:loan.borrowedAt};
}
