import {SDK_VERSION} from './version.js';
import {trimHistory} from './history.js';
export {SDK_VERSION,DEMO_DISCLOSURE} from './version.js';
export {trimHistory} from './history.js';
export type {HistoryLimits,HistoryTrimmed} from './history.js';
import { CONTRACT, ExistingTurnSchema, TurnStatusSchema, SafeErrorSchema } from './generated/schema.js';
import type { AdRouterClient, ClientOptions, SDKError, TurnHandle, TurnResult } from './types.js';
import type { ClientDeliveryEvent, TurnStatus } from './generated/wire.js';
import { parseEvents } from './parser.js';
import { registerPlacement, renderSponsorCard, bindPlacementTransport } from './placement.js';
export {renderSponsorCard};
export type * from './types.js';
export type * from './generated/wire.js';

const fail=(code:SDKError['code'],message:string,turnId?:string):SDKError=>({code,message,turnId});
export function createAdRouterClient(options:ClientOptions):AdRouterClient {
  const fetcher=options.fetch ?? fetch; let disposed=false;
  const active=new Set<AbortController>(), placements=new Set<ReturnType<typeof registerPlacement>>();
  const feedbackIds=new Map<string,{payload:string;id:string}>();
  const notify=(callback:((value:any,...args:any[])=>void)|undefined,...args:any[])=>{
    try{callback?.(args[0],...args.slice(1));}catch{try{options.onError?.(fail('invalid_event','A display callback failed.'));}catch{}}
  };
  const read=async(response:Response):Promise<unknown>=>{
    const reader=response.body?.getReader(); if(!reader) throw fail('transport_interrupted','Empty response.');
    let size=0,text='';const decoder=new TextDecoder();
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
      if(size>65_536)throw fail('stream_protocol_error','Response exceeds the limit.');text+=decoder.decode(next.value,{stream:true});}
      text+=decoder.decode();return JSON.parse(text);
    }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  };
  const request=async(url:string,init?:RequestInit)=>{
    const signal=init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(75_000)]):AbortSignal.timeout(10_000);
    const response=await fetcher(url,{credentials:'same-origin',cache:'no-store',...init,signal});
    if(!response.ok){const body=await read(response);
      if(body&&typeof body==='object'&&'error' in body&&(body as any).error?.code==='unknown_persona')throw fail('unknown_persona','The selected persona is unavailable.');
      const safe=SafeErrorSchema.safeParse(body);
      throw safe.success?fail(safe.data.error.code,safe.data.error.message,safe.data.turn_id):fail('service_unavailable','Request unavailable.');}
    return response;
  };
  const report=(turn:string,type:ClientDeliveryEvent['type'])=>{
    const body:ClientDeliveryEvent={contract_version:CONTRACT,event_id:crypto.randomUUID(),turn_id:turn,
      type,occurred_at:new Date().toISOString(),sdk_version:SDK_VERSION};
    void request(options.endpoints.clientEvents,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>undefined);
  };
  const client:AdRouterClient={
    async getTurnStatus(turnId){const status=TurnStatusSchema.parse(await read(await request(options.endpoints.status(turnId))));
      if(status.turn_id!==turnId)throw fail('stream_protocol_error','Turn metadata does not match the requested operation.',turnId);return status;},
    sendTurn(input):TurnHandle {
      if(disposed)throw fail('service_unavailable','Client is disposed.');
      const operationId=crypto.randomUUID(),interactionId=crypto.randomUUID(),abort=new AbortController();
      let turnId:string|undefined,firstDelta=false;active.add(abort);
      const done=(async():Promise<TurnResult>=>{
        let delivery:'complete'|'interrupted'='complete';
        try{
          let trimmed:ReturnType<typeof trimHistory>;
          try{trimmed=trimHistory(input.messages,options.history);}catch{throw fail('input_limit','The latest message or history limits are too large.');}
          if(trimmed.removedMessages){
            if(!options.onHistoryTrimmed)throw fail('input_limit','History trimming requires a visible publisher notice.');
            try{options.onHistoryTrimmed({removedMessages:trimmed.removedMessages,retainedMessages:trimmed.retainedMessages});}
            catch{throw fail('invalid_request','The history notice could not be displayed.');}
          }
          const token=await options.getTurnstileToken();
          if(abort.signal.aborted)throw fail('turn_cancelled','Turn cancelled before submission.');
          const response=await request(options.endpoints.chat,{method:'POST',signal:abort.signal,
            headers:{'Content-Type':'application/json','Idempotency-Key':operationId,...(options.persona?{'X-AdRouter-Persona':options.persona}:{})},
            body:JSON.stringify({contract_version:CONTRACT,interaction_id:interactionId,created_at:new Date().toISOString(),
              messages:trimmed.messages,sponsorship_enabled:input.sponsorshipEnabled!==false,turnstile_token:token})});
          if(response.headers.get('content-type')?.includes('application/json')){
            const existing=ExistingTurnSchema.parse(await read(response));
            if(existing.turn.interaction_id!==interactionId)throw fail('stream_protocol_error','Existing operation does not match this interaction.');
            turnId=existing.turn.turn_id;
            notify(options.onCompleted,existing.turn);return {kind:'existing',delivery:'interrupted',status:existing.turn};
          }
          if(!response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body)
            throw fail('stream_protocol_error','Unexpected response format.');
          try{
            for await(const event of parseEvents(response.body,abort.signal)){
              if(event.type==='turn.started'){
                if(event.data.interaction_id!==interactionId)throw fail('stream_protocol_error','Interaction mismatch.');
                turnId=event.turn_id;notify(options.onStarted,turnId);
              }
              notify(options.onEvent,event);
              if(event.type==='model.delta'){
                if(!firstDelta){firstDelta=true;report(event.turn_id,'model_first_delta');}
                notify(options.onModelDelta,event.data.text,event.turn_id);
              }
              if(event.type==='model.error')notify(options.onError,fail(event.data.code,'Model response ended.',event.turn_id));
              if(event.type==='sponsor.offer')notify(options.onSponsorOffer,event.data,event.turn_id);
              if(event.type==='sponsor.none')notify(options.onSponsorNone,event.data.reason,event.turn_id);
              if(event.type==='usage.final')notify(options.onUsage,event.data,event.turn_id);
            }
          }catch{delivery='interrupted';}
          if(!turnId)throw fail('transport_interrupted','Delivery is uncertain; no generation was retried.');
          report(turnId,delivery==='complete'?'stream_completed':'stream_interrupted');
          const status:TurnStatus=await client.getTurnStatus(turnId);notify(options.onCompleted,status);
          return {kind:'new',delivery,status};
        }catch(error){const safe=error && typeof error==='object' && 'code' in error?error as SDKError:
          fail('transport_interrupted','Response metadata is unavailable. The local answer is retained.',turnId);
          notify(options.onError,safe);throw safe;
        }finally{active.delete(abort);}
      })();
      return {operationId,interactionId,get turnId(){return turnId;},done,
        async cancel(){abort.abort();if(turnId)await request(options.endpoints.cancel(turnId),{method:'POST'});}};
    },
    async submitFeedback(input){
      const payload=JSON.stringify({turn_id:input.turn_id,offer_id:input.offer_id,answer:input.answer,sponsorship:input.sponsorship});
      const previous=feedbackIds.get(input.turn_id),id=previous?.payload===payload?previous.id:crypto.randomUUID();
      feedbackIds.set(input.turn_id,{payload,id});
      const response=await read(await request(options.endpoints.feedback,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,contract_version:CONTRACT,feedback_id:id})}));
      if(!response || typeof response!=='object' || !('accepted' in response) || response.accepted!==true ||
        !('duplicate' in response) || typeof response.duplicate!=='boolean')throw fail('stream_protocol_error','Invalid acknowledgement.');
      return {accepted:true,duplicate:response.duplicate};},
    registerPlacement(input){const handle=registerPlacement({...input,endpoint:options.endpoints.measurement,fetcher});placements.add(handle);return handle;},
    dispose(){disposed=true;for(const abort of active)abort.abort();for(const handle of placements)handle.dispose();placements.clear();feedbackIds.clear();
      if(typeof window!=='undefined')window.removeEventListener('pagehide',onPageHide);}
  };
  // A page kept in the back/forward cache can be restored: stop active work and measurement there,
  // but keep the client usable. Any other page hide disposes it.
  const onPageHide=(event:Event)=>{
    if(!(event as Event&{persisted?:boolean}).persisted){client.dispose();return;}
    for(const abort of active)abort.abort();for(const handle of placements)handle.dispose();placements.clear();
  };
  bindPlacementTransport(client,{endpoint:options.endpoints.measurement,fetcher});
  if(typeof window!=='undefined')window.addEventListener('pagehide',onPageHide);
  return client;
}
