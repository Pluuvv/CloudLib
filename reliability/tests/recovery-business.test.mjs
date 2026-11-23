import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api } from '../recovery-business.mjs';

test('business requests preserve the original Host and credentials over IPv4', async () => {
 const requests=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({host:req.headers.host,authorization:req.headers.authorization,tenant:req.headers['x-tenant'],method:req.method,body});
  if(req.headers.host!==`localhost:${server.address().port}`){res.writeHead(404);res.end();return;}
  res.writeHead(req.method==='POST'?201:200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin=`http://localhost:${server.address().port}`,session={origin,staff:'fixture-token'};
  assert.deepEqual(await api(session,'/books'),{ok:true});
  assert.deepEqual(await api(session,'/loans','staff',201,{barcode:'fixture'},'upnvj'),{ok:true});
  assert.deepEqual(requests.map(r=>r.host),[new URL(origin).host,new URL(origin).host]);
  assert.equal(requests[1].authorization,'Bearer fixture-token');assert.equal(requests[1].tenant,'upnvj');
  assert.equal(requests[1].method,'POST');assert.deepEqual(JSON.parse(requests[1].body),{barcode:'fixture'});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
