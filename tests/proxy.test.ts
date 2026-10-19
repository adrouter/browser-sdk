import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublisherProxy} from '../src/server.js';
const options={runUntil:new Date(Date.now()+3600_000).toISOString(),gatewayOrigin:'https://gateway.example',allowedOrigin:'https://publisher.example',appCredential:'synthetic-app',
  providerConnectionId:'connection-unit',model:'deepseek-v4-flash',placementId:'placement-unit',systemInstruction:'Synthetic system instruction.',
  sessionSigningSecret:'synthetic-session-secret-thirty-two-characters',referenceHmacSecret:'synthetic-reference-secret-thirty-two-characters',turnstileSecret:'synthetic-test-secret'};
const request=(path:string,body?:unknown,cookie?:string,origin=options.allowedOrigin)=>new Request(options.allowedOrigin+path,{method:'POST',
  headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','Idempotency-Key':'00000000-0000-4000-8000-000000000001',...(cookie?{Cookie:cookie}:{})},
  body:body===undefined?undefined:JSON.stringify(body)});
test('session is signed, retained on refresh, and rejects cross-origin or forged cookies',async()=>{
  const proxy=createPublisherProxy(options),issued=await proxy.session(request('/api/session'));
  assert.equal(issued.status,200);const cookie=issued.headers.get('Set-Cookie')!.split(';')[0];
  assert.match(issued.headers.get('Set-Cookie')!,/HttpOnly; Secure; SameSite=Lax/);
  const repeated=await proxy.session(request('/api/session',undefined,cookie));assert.equal(repeated.status,200);assert.equal(repeated.headers.has('Set-Cookie'),false);
  assert.equal((await proxy.session(request('/api/session',undefined,undefined,'https://attacker.example'))).status,403);
  assert.equal((await proxy.chat(request('/api/chat',{},cookie+'forged'))).status,401);
});
test('proxy owns authority and forwards stream without waiting for completion',async()=>{
  const proxy=createPublisherProxy(options),issued=await proxy.session(request('/api/session'));
  const cookie=issued.headers.get('Set-Cookie')!.split(';')[0],original=globalThis.fetch;
  let captured:Record<string,unknown>|undefined,controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('siteverify'))return Response.json({success:true,hostname:'publisher.example',action:'chat'});
    captured=JSON.parse(String(init?.body));assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-app');
    return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('first\n'));}}),{headers:{'Content-Type':'application/x-ndjson'}});
  };
  try{
    const response=await proxy.chat(request('/api/chat',{contract_version:'3.0-mvp.1',interaction_id:'00000000-0000-4000-8000-000000000002',
      created_at:new Date().toISOString(),messages:[{role:'user',content:'Synthetic prompt.'}],sponsorship_enabled:false,turnstile_token:'unit-token'},cookie));
    assert.equal(response.status,200);const reader=response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'first\n');
    assert.equal(captured?.provider_connection_id,options.providerConnectionId);
    assert.deepEqual(captured?.messages,[{role:'system',content:options.systemInstruction},{role:'user',content:'Synthetic prompt.'}]);
    assert.equal(JSON.stringify(captured).includes('192.0.2.1'),false);controller!.close();await reader.cancel();
  }finally{globalThis.fetch=original;}
});
test('fixed deadline blocks new paid work at and after expiry without reaching the gateway',async()=>{
  const original=Date.now,fetcher=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('No network expected');};
  try{for(const time of ['2026-10-11T22:20:17Z','2026-10-12T00:00:00Z']){
    Date.now=()=>Date.parse(time);const proxy=createPublisherProxy({...options,runUntil:'2026-10-11T22:20:17Z'});
    assert.equal((await proxy.chat(request('/api/chat',{}))).status,410);
  }assert.equal(calls,0);}finally{Date.now=original;globalThis.fetch=fetcher;}
});
test('Turnstile hostname, action, consumed tokens and test secrets fail closed before gateway work',async()=>{
  const fetcher=globalThis.fetch;let gateway=0;
  try{for(const result of [{success:true,hostname:'foreign.example',action:'chat'},{success:true,hostname:'publisher.example',action:'foreign'},{success:false,'error-codes':['timeout-or-duplicate']}]){
    const proxy=createPublisherProxy(options),issued=await proxy.session(request('/api/session')),cookie=issued.headers.get('Set-Cookie')!.split(';')[0];
    globalThis.fetch=async url=>{if(String(url).includes('siteverify'))return Response.json(result);gateway++;return new Response('unexpected');};
    const response=await proxy.chat(request('/api/chat',{contract_version:'3.0-mvp.1',interaction_id:'00000000-0000-4000-8000-000000000002',created_at:new Date().toISOString(),messages:[{role:'user',content:'Synthetic validation fixture.'}],sponsorship_enabled:false,turnstile_token:'synthetic'},cookie));
    assert.equal(response.status,400);
  }
  assert.equal((await createPublisherProxy({...options,turnstileSecret:'1x0000000000000000000000000000000AA'}).session(request('/api/session'))).status,503);
  assert.equal(gateway,0);}finally{globalThis.fetch=fetcher;}
});

test('invalid explicit deadlines fail closed without network',async()=>{
 for(const runUntil of ['','bad','2026-02-31T00:00:00Z']){
  const proxy=createPublisherProxy({...options,runUntil} as any);assert.equal((await proxy.chat(request('/api/chat',{}))).status,503);
  assert.equal((await proxy.session(request('/api/session'))).status,503);
 }
});

test('optional deadlines permit sessions and unknown personas reject before Turnstile',async()=>{
  const original=globalThis.fetch;let calls=0;
  const proxy=createPublisherProxy({...options,runUntil:undefined,systemInstruction:({persona})=>persona==='rowan'?'Synthetic Rowan prompt.':undefined});
  const issued=await proxy.session(request('/api/session'));assert.equal(issued.status,200);
  const cookie=issued.headers.get('Set-Cookie')!.split(';')[0];
  globalThis.fetch=async(url,init)=>{calls++;if(String(url).includes('siteverify'))return Response.json({success:true,hostname:'publisher.example',action:'chat'});
    assert.equal(JSON.parse(String(init?.body)).messages[0].content,'Synthetic Rowan prompt.');return new Response('stream',{headers:{'Content-Type':'application/x-ndjson'}});};
  try{
    const body={contract_version:'3.0-mvp.1',interaction_id:'00000000-0000-4000-8000-000000000002',created_at:new Date().toISOString(),messages:[{role:'user',content:'Synthetic persona test.'}],sponsorship_enabled:false,turnstile_token:'synthetic'};
    const unknown=request('/api/chat',body,cookie);unknown.headers.set('X-AdRouter-Persona','unknown');
    assert.equal((await proxy.chat(unknown)).status,400);assert.equal(calls,0);
    const known=request('/api/chat',body,cookie);known.headers.set('X-AdRouter-Persona','rowan');
    assert.equal((await proxy.chat(known)).status,200);assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});

// Mirrors the Cloudflare Workers runtime, which rejects these RequestInit values with a TypeError.
const workersFetch=(respond:(url:string)=>Response,calls:string[])=>async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.redirect!==undefined&&init.redirect!=='follow'&&init.redirect!=='manual')throw new TypeError('Invalid redirect value, must be one of "follow" or "manual".');
  for(const field of ['cache','credentials','mode'] as const)if(init?.[field]!==undefined)throw new TypeError(`The '${field}' field on 'RequestInitializerDict' is not implemented.`);
  calls.push(new URL(String(url)).pathname);return respond(String(url));
};
const turnBody={contract_version:'3.0-mvp.1',interaction_id:'00000000-0000-4000-8000-000000000002',created_at:new Date().toISOString(),
  messages:[{role:'user',content:'Synthetic Workers fixture.'}],sponsorship_enabled:true,turnstile_token:'synthetic'};
test('every relayed route uses only Workers-supported fetch options',async()=>{
  const proxy=createPublisherProxy(options),issued=await proxy.session(request('/api/session'));
  const cookie=issued.headers.get('Set-Cookie')!.split(';')[0],original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=workersFetch(url=>url.includes('siteverify')?Response.json({success:true,hostname:'publisher.example',action:'chat'}):
    new Response('{}',{headers:{'Content-Type':'application/json'}}),calls);
  try{
    const status=new Request(options.allowedOrigin+'/api/turns/turn-unit',{headers:{Cookie:cookie}});
    const responses=[await proxy.chat(request('/api/chat',turnBody,cookie)),await proxy.status(status,'turn-unit'),
      await proxy.cancel(request('/api/turns/turn-unit/cancel',undefined,cookie),'turn-unit'),
      await proxy.feedback(request('/api/feedback',{contract_version:'3.0-mvp.1',feedback_id:'00000000-0000-4000-8000-000000000003',turn_id:'turn-unit',answer:'helpful'},cookie)),
      await proxy.clientEvents(request('/api/client-events',{contract_version:'3.0-mvp.1',event_id:'00000000-0000-4000-8000-000000000004',turn_id:'turn-unit',
        type:'stream_completed',occurred_at:new Date().toISOString(),sdk_version:'0.1.1'},cookie))];
    assert.deepEqual(responses.map(response=>response.status),[200,200,200,200,200]);
    assert.deepEqual(calls,['/turnstile/v0/siteverify','/v3/gateway/turns','/v3/gateway/turns/turn-unit','/v3/gateway/turns/turn-unit/cancel',
      '/v3/publisher/feedback','/v3/publisher/client-events']);
  }finally{globalThis.fetch=original;}
});
test('a gateway redirect is refused, never followed or forwarded',async()=>{
  const proxy=createPublisherProxy(options),issued=await proxy.session(request('/api/session'));
  const cookie=issued.headers.get('Set-Cookie')!.split(';')[0],original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=workersFetch(url=>url.includes('siteverify')?Response.json({success:true,hostname:'publisher.example',action:'chat'}):
    new Response(null,{status:302,headers:{Location:'https://elsewhere.example/'}}),calls);
  try{
    const response=await proxy.chat(request('/api/chat',turnBody,cookie));
    assert.equal(response.status,503);assert.equal(((await response.json()) as {error:{code:string}}).error.code,'service_unavailable');
    assert.equal(response.headers.has('Location'),false);assert.deepEqual(calls,['/turnstile/v0/siteverify','/v3/gateway/turns']);
  }finally{globalThis.fetch=original;}
});
