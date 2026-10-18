import { createElement, useEffect, useRef, useState, type ReactElement } from 'react';
import { createAdRouterClient, renderSponsorCard } from './index.js';
import type { AdRouterClient, ClientOptions, SDKError, TurnHandle, PlacementState } from './types.js';
import type {HistoryTrimmed} from './history.js';
import type { PublicMessage, SponsorOffer, TurnStatus } from './generated/wire.js';
export interface ReactChatState {messages:PublicMessage[];answer:string;offer:SponsorOffer|null;busy:boolean;turn:TurnStatus|null;error:SDKError|null;historyTrimmed:HistoryTrimmed|null}
export interface ReactChatController {client:AdRouterClient;state:ReactChatState;send(text:string,options?:{sponsorshipEnabled?:boolean}):Promise<void>;cancel():Promise<void>}
export function useAdRouterChat(options:ClientOptions):ReactChatController {
  const [state,setState]=useState<ReactChatState>({messages:[],answer:'',offer:null,busy:false,turn:null,error:null,historyTrimmed:null});
  const stateRef=useRef(state);stateRef.current=state;
  const active=useRef<TurnHandle|null>(null),answer=useRef(''),mounted=useRef(true),clientRef=useRef<AdRouterClient|null>(null);
  if(!clientRef.current)clientRef.current=createAdRouterClient({...options,
    onHistoryTrimmed:event=>{if(mounted.current)setState(s=>({...s,historyTrimmed:event}));options.onHistoryTrimmed?.(event);},
    onModelDelta:(text,id)=>{answer.current+=text;if(mounted.current)setState(s=>({...s,answer:answer.current}));options.onModelDelta?.(text,id);},
    onSponsorOffer:(offer,id)=>{if(mounted.current)setState(s=>({...s,offer}));options.onSponsorOffer?.(offer,id);},
    onSponsorNone:(reason,id)=>{if(mounted.current)setState(s=>({...s,offer:null}));options.onSponsorNone?.(reason,id);},
    onError:error=>{if(mounted.current)setState(s=>({...s,error}));options.onError?.(error);}});
  const client=clientRef.current;
  useEffect(()=>{mounted.current=true;return()=>{
    mounted.current=false;void active.current?.cancel().catch(()=>undefined);
    // React's development effect replay reattaches synchronously. Dispose only
    // after a real unmount, without issuing any replacement generation.
    queueMicrotask(()=>{if(!mounted.current)client.dispose();});
  };},[client]);
  return {client,state,async send(text,input){
    if(active.current || !text.trim())return;
    const messages=[...stateRef.current.messages,{role:'user' as const,content:text}];
    answer.current='';setState(s=>({...s,busy:true,offer:null,error:null,turn:null,historyTrimmed:null}));
    const handle=client.sendTurn({messages,sponsorshipEnabled:input?.sponsorshipEnabled});active.current=handle;
    try{const result=await handle.done;
      const deliveryError:SDKError|null=result.delivery==='interrupted'?{code:'transport_interrupted',message:'Response delivery was interrupted. The partial answer is retained.',turnId:result.status.turn_id}:null;
      if(mounted.current)setState(s=>({...s,turn:result.status,error:deliveryError??s.error,
      answer:answer.current || s.answer,messages:result.kind==='new' && result.delivery==='complete' && result.status.model_outcome==='success'
        ? [...messages,{role:'assistant',content:answer.current}]:s.messages}));
      if(deliveryError){try{options.onError?.(deliveryError);}catch{}}
    }catch(error){if(mounted.current)setState(s=>({...s,error:error as SDKError}));}
    finally{active.current=null;if(mounted.current)setState(s=>({...s,busy:false}));}
  },async cancel(){await active.current?.cancel();}};
}
export function SponsoredCard(props:{client:AdRouterClient;offer:SponsorOffer;className?:string;onState?:(state:PlacementState)=>void}):ReactElement|null {
  const root=useRef<HTMLDivElement>(null);
  const callback=useRef(props.onState);callback.current=props.onState;
  useEffect(()=>{if(!root.current)return;const container=root.current;
    try{
      const handle=renderSponsorCard({client:props.client,offer:props.offer,container,
        onState:state=>{try{callback.current?.(state);}catch{}}});
      return()=>{handle.dispose();container.replaceChildren();};
    }catch{container.replaceChildren();return undefined;}
  },[props.client,props.offer]);
  return createElement('div',{ref:root,className:props.className});
}
