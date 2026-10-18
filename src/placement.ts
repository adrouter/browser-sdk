import {SDK_VERSION,DEMO_DISCLOSURE} from './version.js';
import type { AdRouterClient, PlacementBindings, PlacementHandle, PlacementState } from './types.js';
import type { SponsorOffer, SponsorEvent, RenderFailure } from './generated/wire.js';
const transports=new WeakMap<AdRouterClient,{endpoint:string;fetcher:typeof fetch}>();
export function bindPlacementTransport(client:AdRouterClient,transport:{endpoint:string;fetcher:typeof fetch}):void{transports.set(client,transport);}
const memories=new Map<string,{rendered:boolean;visible:boolean;expires:number;events:Map<string,{body:unknown;attempts:number;next:number}>}>();
export function registerPlacement(options:{offer:SponsorOffer;bindings:PlacementBindings;
  endpoint:string;fetcher:typeof fetch;onState?:(state:PlacementState)=>void}):PlacementHandle {
  const {offer,bindings:b}=options;
  const fetcher=options.fetcher;
  const reportingAbort=new AbortController();
  for(const [id,value]of memories)if(value.expires<Date.now())memories.delete(id);
  const memory=memories.get(offer.offer_id)??{rendered:false,visible:false,expires:Date.parse(offer.expires_at),events:new Map()};
  memories.set(offer.offer_id,memory);
  let disposed=false,since:number|undefined,ratio=0,minimumRatio=0,renderPending=false,visibilityPending=false,failed:RenderFailure|undefined;
  const state:PlacementState={rendered:memory.rendered,measurable:false,visibilityReported:memory.visible,qualification:'unknown',failure:null};
  const notify=()=>{if(disposed)return;try{options.onState?.({...state});}catch{}};
  const report=async(event:Omit<SponsorEvent,'event_id'|'offer_id'|'creative_revision_id'|'occurred_at'|'sdk_version'> & {signals?:unknown;failure?:RenderFailure})=>{
    const key=event.type+(event.failure??'');
    let saved=memory.events.get(key);
    if(!saved && Date.now()>=memory.expires)throw new Error('receipt_expired');
    if(!saved){saved={body:{...event,event_id:crypto.randomUUID(),offer_id:offer.offer_id,
      creative_revision_id:offer.creative_revision_id,occurred_at:new Date().toISOString(),sdk_version:SDK_VERSION},attempts:0,next:0};memory.events.set(key,saved);}
    if(saved.attempts>=3 || saved.next>Date.now())throw new Error('measurement_retry_bound');
    saved.attempts++;saved.next=Date.now()+1000*2**saved.attempts;
    const response=await fetcher(options.endpoint,{method:'POST',credentials:'omit',cache:'no-store',
      headers:{'Content-Type':'application/json','Authorization':`Offer ${offer.reporting_receipt}`},
      signal:AbortSignal.any([reportingAbort.signal,AbortSignal.timeout(5000)]),body:JSON.stringify({contract_version:'3.0-mvp.1',events:[saved.body]})});
    if(!response.ok)throw new Error('measurement_unavailable');
    const text=await response.text();if(text.length>65_536)throw new Error('invalid_acknowledgement');
    const result=JSON.parse(text)?.results?.[0];
    if(!result || result.event_id!==(saved.body as SponsorEvent).event_id || !['accepted','duplicate'].includes(result.result) || !['unknown','not_qualified','qualified_test_view'].includes(result.qualification))throw new Error('measurement_rejected');
    if(result.qualification==='qualified_test_view')state.qualification='qualified_test_view';
  };
  const visible=(el:HTMLElement)=>{
    const css=getComputedStyle(el),rect=el.getBoundingClientRect();
    let opacity=1;for(let parent:HTMLElement|null=el;parent;parent=parent.parentElement){const style=getComputedStyle(parent);opacity*=Number(style.opacity);if(style.display==='none'||style.visibility!=='visible'||opacity<0.9||style.clipPath!=='none'||style.clip!=='auto')return false;}
    return el.isConnected && css.display!=='none' && css.visibility==='visible' && Number(css.opacity)>=0.9 &&
      rect.width>0 && rect.height>0 && parseFloat(css.fontSize)>=12;
  };
  const readable=(el:HTMLElement)=>{
    const rgb=(value:string)=>{const match=/^rgba?\(([^)]+)\)$/.exec(value);if(!match)return null;
      const parts=match[1].split(/[ ,/]+/).map(Number);return parts.length>=3 && parts.every(Number.isFinite)?parts:null;};
    const foreground=rgb(getComputedStyle(el).color);if(!foreground || (foreground[3]??1)<0.95)return false;
    let background:number[]|null=null;
    for(let current:HTMLElement|null=el;current;current=current.parentElement){const color=rgb(getComputedStyle(current).backgroundColor);
      if(color && (color[3]??1)>=0.95){background=color;break;}}
    if(!background)return false;
    const luminance=(rgb:number[])=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
      .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    const a=luminance(foreground),c=luminance(background);return (Math.max(a,c)+0.05)/(Math.min(a,c)+0.05)>=4.5;
  };
  const validate=():RenderFailure|null=>{
    if(!b.root.isConnected || ![b.disclosure,b.advertiser,b.content,b.destination].every(el=>b.root.contains(el)))return 'missing_element';
    if(b.disclosure.textContent?.trim()!==offer.disclosure)return 'missing_disclosure';
    if(offer.synthetic&&(!b.demoDisclosure||!b.root.contains(b.demoDisclosure)||b.demoDisclosure.textContent?.trim()!==DEMO_DISCLOSURE||!visible(b.demoDisclosure)||!readable(b.demoDisclosure)))return 'missing_disclosure';
    if(b.advertiser.textContent?.trim()!==offer.creative.advertiser_name)return 'missing_advertiser';
    if(!b.content.textContent?.includes(offer.creative.title) || !b.content.textContent.includes(offer.creative.body))return 'missing_content';
    if(b.destination.href!==new URL(offer.creative.destination_url).href)return 'invalid_destination';
    if(![b.root,b.disclosure,b.advertiser,b.content,b.destination].every(visible))return 'hidden';
    if(![b.disclosure,b.advertiser,b.content,b.destination].every(readable))return 'unreadable';
    for(let el:HTMLElement|null=b.root;el;el=el.parentElement){const s=getComputedStyle(el);
      if(Number(s.opacity)<0.9 || s.filter!=='none' || s.visibility!=='visible' || s.display==='none')return 'unreadable';}
    if(typeof IntersectionObserver==='undefined' || typeof document.elementFromPoint!=='function')return 'measurement_unsupported';
    // Hit testing ignores pointer-events:none overlays even when they obscure the
    // card. Conservatively reject overlapping painted layers in the controlled page.
    const elements=document.querySelectorAll('body *');if(elements.length>2000)return 'measurement_unsupported';
    const card=b.root.getBoundingClientRect();
    for(const element of elements){
      if(b.root.contains(element)||element.contains(b.root))continue;
      const css=getComputedStyle(element);
      if(css.pointerEvents!=='none'||css.display==='none'||css.visibility!=='visible'||Number(css.opacity)<0.05||
        (css.position==='static'&&css.transform==='none'))continue;
      const rect=element.getBoundingClientRect();
      if(rect.right<=card.left||rect.left>=card.right||rect.bottom<=card.top||rect.top>=card.bottom)continue;
      const painted=css.backgroundColor!=='rgba(0, 0, 0, 0)'&&css.backgroundColor!=='transparent';
      if(painted||css.backgroundImage!=='none'||['IMG','VIDEO','CANVAS','IFRAME','svg'].includes(element.tagName)||element.textContent?.trim())return 'covered';
    }
    for(const el of [b.disclosure,b.advertiser,b.content,b.destination,...(offer.synthetic&&b.demoDisclosure?[b.demoDisclosure]:[])]){
      const r=el.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
      if(x<0 || x>innerWidth || y<0 || y>innerHeight)return 'hidden';
      const top=document.elementFromPoint(x,y);if(!top || !(el.contains(top)||top.contains(el)))return 'covered';
    }
    return null;
  };
  const check=():PlacementState=>{
    if(disposed)return {...state};
    if(Date.now()>=memory.expires){state.measurable=false;notify();dispose();return {...state};}
    try{state.failure=validate();}catch{state.failure='render_exception';}
    state.measurable=!state.failure && Date.now()<memory.expires;
    if(state.failure){since=undefined;if(failed!==state.failure){failed=state.failure;void report({type:'render_failed',failure:state.failure}).catch(()=>undefined);}}
    if(state.measurable && !memory.rendered && !renderPending){renderPending=true;
      void report({type:'rendered'}).then(()=>{memory.rendered=true;state.rendered=true;notify();}).catch(()=>undefined).finally(()=>{renderPending=false;});}
    const eligible=state.measurable && memory.rendered && document.visibilityState==='visible' && document.hasFocus() && ratio>=0.5;
    if(!eligible)since=undefined;
    else if(since===undefined){since=performance.now();minimumRatio=ratio;}
    else if(performance.now()-since>=1000 && !memory.visible && !visibilityPending){visibilityPending=true;
      minimumRatio=Math.min(minimumRatio,ratio);
      void report({type:'visibility',signals:{minimum_intersection_ratio:minimumRatio,continuous_visible_ms:Math.floor(performance.now()-since),
        document_visible:true,window_focused:true,disclosure_visible:true,readable:true}}).then(()=>{
        memory.visible=true;state.visibilityReported=true;notify();}).catch(()=>undefined).finally(()=>{visibilityPending=false;});}
    if(eligible&&since!==undefined)minimumRatio=Math.min(minimumRatio,ratio);
    notify();return {...state};
  };
  const reset=()=>{since=undefined;check();};
  const observer=typeof IntersectionObserver==='undefined'?undefined:new IntersectionObserver(entries=>{
    const next=entries[0]?.intersectionRatio??0;if(next<0.5)since=undefined;ratio=next;check();},{threshold:[0,0.5,1]});
  observer?.observe(b.root);
  const mutations=new MutationObserver(reset);mutations.observe(b.root,{attributes:true,childList:true,subtree:true,characterData:true});
  const timer=setInterval(check,100);
  document.addEventListener('visibilitychange',reset);window.addEventListener('blur',reset);window.addEventListener('focus',reset);
  window.addEventListener('resize',reset);window.addEventListener('scroll',reset,true);
  const click=()=>{void report({type:'clicked'}).catch(()=>undefined);};b.destination.addEventListener('click',click);
  const dispose=()=>{if(disposed)return;disposed=true;reportingAbort.abort();clearInterval(timer);observer?.disconnect();mutations.disconnect();
    document.removeEventListener('visibilitychange',reset);window.removeEventListener('blur',reset);window.removeEventListener('focus',reset);
    window.removeEventListener('resize',reset);window.removeEventListener('scroll',reset,true);b.destination.removeEventListener('click',click);};
  check();return {get state(){return {...state};},check,dispose,dismiss(){void report({type:'dismissed'}).catch(()=>undefined);dispose();b.root.remove();}};
}
function renderCard(options:{client:AdRouterClient;offer:SponsorOffer;container:HTMLElement;onState?:(state:PlacementState)=>void}):PlacementHandle {
  const {offer}=options,root=document.createElement('aside'),disclosure=document.createElement('strong'),advertiser=document.createElement('div'),
    demoDisclosure=document.createElement('p'),content=document.createElement('div'),title=document.createElement('h3'),body=document.createElement('p'),destination=document.createElement('a');
  root.setAttribute('aria-label','Sponsored placement · demo campaign');root.className='adrouter-sponsor-card';
  disclosure.textContent=offer.disclosure;advertiser.textContent=offer.creative.advertiser_name;
  title.textContent=offer.creative.title;body.textContent=offer.creative.body;content.append(title,body);
  destination.textContent='Visit sponsor';destination.href=offer.creative.destination_url;destination.target='_blank';destination.rel='sponsored noopener noreferrer';
  demoDisclosure.textContent=DEMO_DISCLOSURE;demoDisclosure.className='adrouter-demo-disclosure';
  root.append(disclosure,advertiser,content,...(offer.synthetic?[demoDisclosure]:[]),destination);options.container.append(root);
  return options.client.registerPlacement({offer,bindings:{root,disclosure,advertiser,content,destination,demoDisclosure},onState:options.onState});
}
export function renderSponsorCard(options:{client:AdRouterClient;offer:SponsorOffer;container:HTMLElement;onState?:(state:PlacementState)=>void}):PlacementHandle {
  try{return renderCard(options);}catch{
    const state:PlacementState={rendered:false,measurable:false,visibilityReported:false,qualification:'unknown',failure:'render_exception'};
    const transport=transports.get(options.client);
    if(transport && Date.now()<Date.parse(options.offer.expires_at)){
      const {fetcher,endpoint}=transport;
      void fetcher(endpoint,{method:'POST',credentials:'omit',signal:AbortSignal.timeout(5000),
        headers:{'Content-Type':'application/json',Authorization:`Offer ${options.offer.reporting_receipt}`},
        body:JSON.stringify({contract_version:'3.0-mvp.1',events:[{event_id:crypto.randomUUID(),offer_id:options.offer.offer_id,
          creative_revision_id:options.offer.creative_revision_id,occurred_at:new Date().toISOString(),sdk_version:SDK_VERSION,
          type:'render_failed',failure:'render_exception'}]})}).catch(()=>undefined);
    }
    try{options.onState?.({...state});}catch{}
    return {get state(){return {...state};},check:()=>({...state}),dispose(){},dismiss(){}};
  }
}
