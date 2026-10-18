import {z} from 'zod';
import { CONTRACT, PublicTurnInputSchema, FeedbackInputSchema, ClientDeliveryEventSchema } from './generated/schema.js';

export interface PublisherProxyOptions {
  gatewayOrigin:string;allowedOrigin:string;appCredential:string;providerConnectionId:string;
  model:string;placementId:string;systemInstruction:string|((context:{persona:string|undefined;request:Request})=>string|undefined|null|Promise<string|undefined|null>);sessionSigningSecret:string;
  referenceHmacSecret:string;turnstileSecret:string;runUntil?:string;
}
export interface PublisherProxy {
  session(request:Request):Promise<Response>;chat(request:Request):Promise<Response>;
  status(request:Request,turnId:string):Promise<Response>;cancel(request:Request,turnId:string):Promise<Response>;
  feedback(request:Request):Promise<Response>;clientEvents(request:Request):Promise<Response>;
}
const encoder=new TextEncoder();
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function mac(secret:string,text:string):Promise<string>{
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(text))));
}
const equal=(a:string,b:string)=>{let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;};
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const json=(body:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(body),{status,
  headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const failure=(code:string,status=400)=>json({error:{code,message:code.replaceAll('_',' '),retryable:status===503},request_id:crypto.randomUUID()},status);
async function boundedJson(request:Request|Response):Promise<unknown>{
  const reader=request.body?.getReader();if(!reader)throw new Error('invalid_request');
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;
    if(size>65_536)throw new Error('request_too_large');text+=decoder.decode(item.value,{stream:true});}
    return JSON.parse(text+decoder.decode());
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
export const publisherDeadline=(until:unknown):number=>until===undefined?Infinity:z.string().datetime().safeParse(until).success?Date.parse(until as string):NaN;
export function createPublisherProxy(options:PublisherProxyOptions):PublisherProxy {
  const deadline=publisherDeadline(options.runUntil);
  const valid=()=>{
    if(Number.isNaN(deadline))throw new Error('service_unavailable');
    for(const value of [options.gatewayOrigin,options.allowedOrigin,options.appCredential,options.providerConnectionId,options.model,options.placementId,options.sessionSigningSecret,options.referenceHmacSecret,options.turnstileSecret])
      if(typeof value!=='string'||!value)throw new Error('service_unavailable');
    if(typeof options.systemInstruction!=='function'&&(typeof options.systemInstruction!=='string'||!options.systemInstruction))throw new Error('service_unavailable');
    for(const origin of [options.gatewayOrigin,options.allowedOrigin]){
      const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw new Error('service_unavailable');
    }
    if(options.sessionSigningSecret.length<32 || options.referenceHmacSecret.length<32 ||
      options.turnstileSecret.startsWith('1x0000000000000000000000000000000') ||
      options.turnstileSecret.startsWith('2x0000000000000000000000000000000') ||
      options.turnstileSecret.startsWith('3x0000000000000000000000000000000'))throw new Error('service_unavailable');
  };
  const origin=(request:Request)=>{
    valid();if(new URL(request.url).origin!==options.allowedOrigin || request.headers.get('Origin')!==options.allowedOrigin)
      throw new Error('forbidden');
    const site=request.headers.get('Sec-Fetch-Site');if(site && site!=='same-origin')throw new Error('forbidden');
  };
  const session=async(request:Request)=>{
    valid();if(new URL(request.url).origin!==options.allowedOrigin)throw new Error('forbidden');
    const cookie=request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('__Host-adr_session='))?.slice('__Host-adr_session='.length);
    if(!cookie)throw new Error('session_invalid');
    const [id,issued,signature,extra]=cookie.split('.');const time=Number(issued);
    if(extra || !/^[0-9a-f-]{36}$/.test(id) || !Number.isFinite(time) || time>Date.now() || Date.now()-time>604_800_000 ||
      !signature || !equal(signature,await mac(options.sessionSigningSecret,`${id}.${issued}`)))throw new Error('session_invalid');
    return mac(options.referenceHmacSecret,`${options.allowedOrigin}:session:${id}`);
  };
  const safe=(fn:(request:Request,id?:string)=>Promise<Response>)=>async(request:Request,id?:string)=>{
    try{return await fn(request,id);}catch(error){const code=error instanceof Error?error.message:'service_unavailable';
      const allowed=['invalid_request','request_too_large','forbidden','session_invalid','turnstile_failed','unknown_persona','service_unavailable'];
      return failure(allowed.includes(code)?code:'service_unavailable',code==='request_too_large'?413:code==='forbidden'?403:
        code==='session_invalid'?401:code==='invalid_request'||code==='turnstile_failed'||code==='unknown_persona'?400:503);}
  };
  const relay=async(request:Request,path:string,sessionRef:string,body?:unknown)=>{
    const headers:Record<string,string>={'Authorization':`Bearer ${options.appCredential}`,'X-Publisher-Session-Ref':sessionRef};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(path==='/v3/gateway/turns'){
      const operation=request.headers.get('Idempotency-Key');
      if(!operation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operation))throw new Error('invalid_request');
      headers['Idempotency-Key']=operation;
    }
    const response=await fetch(options.gatewayOrigin+path,{method:request.method,headers,
      body:body===undefined?undefined:JSON.stringify(body),signal:request.signal,redirect:'error'});
    const outgoing=new Headers({'Content-Type':response.headers.get('Content-Type')??'application/json',
      'Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff'});
    const retry=response.headers.get('Retry-After');if(retry)outgoing.set('Retry-After',retry);
    // Never consume successful stream bodies. The platform forwards the ReadableStream.
    return new Response(response.body,{status:response.status,headers:outgoing});
  };
  return {
    session:safe(async request=>{origin(request);if(request.method!=='POST')throw new Error('invalid_request');
      try{await session(request);return json({ready:true});}catch(error){if(!(error instanceof Error)||error.message!=='session_invalid')throw error;}
      const id=crypto.randomUUID(),issued=Date.now(),body=`${id}.${issued}`;
      return json({ready:true},200,{'Set-Cookie':`__Host-adr_session=${body}.${await mac(options.sessionSigningSecret,body)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`});}),
    chat:safe(async request=>{if(Date.now()>=deadline)return failure('operation_expired',410);origin(request);const sessionRef=await session(request);
      const persona=request.headers.get('X-AdRouter-Persona')??undefined;
      if(persona!==undefined&&!/^[a-z][a-z0-9-]{0,63}$/.test(persona))throw new Error('unknown_persona');
      if(typeof options.systemInstruction==='string'&&persona!==undefined)throw new Error('unknown_persona');
      let instruction:string|undefined|null;
      try{instruction=typeof options.systemInstruction==='function'?await options.systemInstruction({persona,request}):options.systemInstruction;}catch{throw new Error('unknown_persona');}
      if(typeof instruction!=='string'||!instruction.trim())throw new Error('unknown_persona');
      const parsed=PublicTurnInputSchema.safeParse(await boundedJson(request));if(!parsed.success)throw new Error('invalid_request');
      const ip=request.headers.get('CF-Connecting-IP');if(!ip || ip.length>64)throw new Error('forbidden');
      const verification=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:options.turnstileSecret,response:parsed.data.turnstile_token,remoteip:ip}),
        signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)])});
      const result=await boundedJson(verification) as {success?:boolean;hostname?:string;action?:string};
      if(result.success!==true || result.hostname!==new URL(options.allowedOrigin).hostname || result.action!=='chat')throw new Error('turnstile_failed');
      if(Date.now()>=deadline)return failure('operation_expired',410);
      const quotaDay=day();
      return relay(request,'/v3/gateway/turns',sessionRef,{contract_version:CONTRACT,
        interaction_id:parsed.data.interaction_id,created_at:parsed.data.created_at,inference_mode:'byok',model:options.model,
        provider_connection_id:options.providerConnectionId,messages:[{role:'system',content:instruction},...parsed.data.messages],
        max_output_tokens:512,thinking_level:'none',sponsorship:{enabled:parsed.data.sponsorship_enabled,placement_id:options.placementId},
        publisher_context:{session_ref:sessionRef,ip_ref:await mac(options.referenceHmacSecret,`${options.allowedOrigin}:${quotaDay}:${ip}`),quota_day:quotaDay}});}),
    status:safe(async(request,id)=>{const ref=await session(request);if(!id || id.length>128)throw new Error('invalid_request');
      return relay(request,`/v3/gateway/turns/${encodeURIComponent(id)}`,ref);}),
    cancel:safe(async(request,id)=>{origin(request);const ref=await session(request);if(!id || id.length>128)throw new Error('invalid_request');
      return relay(request,`/v3/gateway/turns/${encodeURIComponent(id)}/cancel`,ref);}),
    feedback:safe(async request=>{origin(request);const ref=await session(request),body=FeedbackInputSchema.safeParse(await boundedJson(request));
      if(!body.success)throw new Error('invalid_request');return relay(request,'/v3/publisher/feedback',ref,body.data);}),
    clientEvents:safe(async request=>{origin(request);const ref=await session(request),body=ClientDeliveryEventSchema.safeParse(await boundedJson(request));
      if(!body.success)throw new Error('invalid_request');return relay(request,'/v3/publisher/client-events',ref,body.data);}),
  };
}
