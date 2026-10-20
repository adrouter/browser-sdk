import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Runs the publisher proxy in workerd, the Cloudflare Workers runtime, which rejects some fetch
// options that Node accepts (SDK 0.1.0 failed this way). Every outbound fetch is intercepted.
const ORIGIN='https://publisher.example',GATEWAY='https://gateway.example';
const entry=`import {createPublisherProxy} from ${JSON.stringify(new URL('../src/server.ts',import.meta.url).pathname)};
export default {async fetch(request,env){
  const proxy=createPublisherProxy({gatewayOrigin:env.GATEWAY,allowedOrigin:env.ORIGIN,appCredential:'synthetic-app-credential',
    providerConnectionId:'synthetic-connection',model:'deepseek-v4-flash',placementId:'synthetic-placement',
    systemInstruction:'Synthetic system instruction.',sessionSigningSecret:env.SESSION,referenceHmacSecret:env.REFERENCE,
    turnstileSecret:'synthetic-server-challenge'});
  const path=new URL(request.url).pathname,id=path.split('/')[3];
  if(path==='/api/session')return proxy.session(request);
  if(path==='/api/chat')return proxy.chat(request);
  if(path.endsWith('/cancel'))return proxy.cancel(request,id);
  if(path.startsWith('/api/turns/'))return proxy.status(request,id);
  if(path==='/api/feedback')return proxy.feedback(request);
  if(path==='/api/client-events')return proxy.clientEvents(request);
  return new Response('Not found',{status:404});
}};`;
const script=(await build({stdin:{contents:entry,resolveDir:new URL('.',import.meta.url).pathname,loader:'js'},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
const headers={Origin:ORIGIN,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':'192.0.2.1'};
const STREAM='{"type":"turn.started"}\n{"type":"turn.completed"}\n';

async function start(gateway:(url:URL)=>Response){
  const calls:string[]=[];
  const mf=new Miniflare(convertV4MiniflareOptions({name:'sdk-proxy',modules:true,script,compatibilityDate:'2026-10-01',
    bindings:{ORIGIN,GATEWAY,SESSION:randomBytes(32).toString('hex'),REFERENCE:randomBytes(32).toString('hex')},
    outboundService:async(request:Request)=>{
      const url=new URL(request.url);calls.push(`${request.method} ${url.origin}${url.pathname}`);await request.text();
      if(url.origin==='https://challenges.cloudflare.com')return Response.json({success:true,hostname:'publisher.example',action:'chat'});
      if(url.origin===GATEWAY)return gateway(url);
      return new Response('Unexpected outbound request',{status:599});
    }}));
  const session=await mf.dispatchFetch(ORIGIN+'/api/session',{method:'POST',headers});
  assert.equal(session.status,200);
  return {mf,calls,cookie:session.headers.get('Set-Cookie')!.split(';')[0]};
}
const chat=(mf:Miniflare,cookie:string)=>mf.dispatchFetch(ORIGIN+'/api/chat',{method:'POST',
  headers:{...headers,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},
  body:JSON.stringify({contract_version:'3.0-mvp.1',interaction_id:crypto.randomUUID(),created_at:new Date().toISOString(),
    messages:[{role:'user',content:'A synthetic test.'}],sponsorship_enabled:true,turnstile_token:'synthetic-one-use-token'})});

test('workerd: chat and every relay reach the gateway',async()=>{
  const {mf,calls,cookie}=await start(url=>url.pathname==='/v3/gateway/turns'
    ?new Response(STREAM,{headers:{'Content-Type':'application/x-ndjson'}}):Response.json({}));
  try{
    const reply=await chat(mf,cookie);
    assert.equal(reply.status,200);assert.equal(await reply.text(),STREAM);
    const post=(path:string,body?:unknown)=>mf.dispatchFetch(ORIGIN+path,{method:'POST',
      headers:{...headers,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const statuses=[
      (await mf.dispatchFetch(ORIGIN+'/api/turns/synthetic-turn',{headers:{...headers,Cookie:cookie}})).status,
      (await post('/api/turns/synthetic-turn/cancel')).status,
      (await post('/api/feedback',{contract_version:'3.0-mvp.1',feedback_id:crypto.randomUUID(),turn_id:'synthetic-turn',answer:'helpful'})).status,
      (await post('/api/client-events',{contract_version:'3.0-mvp.1',event_id:crypto.randomUUID(),turn_id:'synthetic-turn',
        type:'stream_completed',occurred_at:new Date().toISOString(),sdk_version:'0.2.0'})).status];
    assert.deepEqual(statuses,[200,200,200,200]);
    assert.deepEqual(calls,['POST https://challenges.cloudflare.com/turnstile/v0/siteverify',`POST ${GATEWAY}/v3/gateway/turns`,
      `GET ${GATEWAY}/v3/gateway/turns/synthetic-turn`,`POST ${GATEWAY}/v3/gateway/turns/synthetic-turn/cancel`,
      `POST ${GATEWAY}/v3/publisher/feedback`,`POST ${GATEWAY}/v3/publisher/client-events`]);
  }finally{await mf.dispose();}
});

test('workerd: a gateway redirect is refused, not followed or forwarded',async()=>{
  const {mf,calls,cookie}=await start(()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.example/'}}));
  try{
    const reply=await chat(mf,cookie);
    assert.equal(reply.status,503);assert.equal(((await reply.json()) as any).error.code,'service_unavailable');
    assert.equal(reply.headers.has('Location'),false);
    assert.deepEqual(calls,['POST https://challenges.cloudflare.com/turnstile/v0/siteverify',`POST ${GATEWAY}/v3/gateway/turns`]);
  }finally{await mf.dispose();}
});
