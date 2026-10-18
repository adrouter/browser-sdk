import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAdRouterClient} from '../src/index.js';
const endpoints={chat:'/api/chat',status:(id:string)=>'/api/turns/'+id,cancel:(id:string)=>'/api/turns/'+id+'/cancel',feedback:'/api/feedback',clientEvents:'/api/client-events',measurement:'/v3/sponsor/events'};
test('feedback retries keep their ID; changed ratings append a new ID',async()=>{
  const requests:any[]=[];
  const client=createAdRouterClient({endpoints,getTurnstileToken:async()=>'synthetic-token',fetch:async(_url,init)=>{
    requests.push(JSON.parse(String(init?.body)));
    if(requests.length===1)throw new Error('synthetic lost acknowledgement');
    return Response.json({accepted:true,duplicate:false});
  }});
  try{
    await assert.rejects(()=>client.submitFeedback({turn_id:'test',answer:'helpful'}));
    await client.submitFeedback({turn_id:'test',answer:'helpful'});
    await client.submitFeedback({turn_id:'test',answer:'unhelpful'});
    await client.submitFeedback({turn_id:'test',answer:'helpful'});
    assert.equal(requests[0].feedback_id,requests[1].feedback_id);
    assert.notEqual(requests[1].feedback_id,requests[2].feedback_id);
    assert.notEqual(requests[2].feedback_id,requests[3].feedback_id);
    assert.notEqual(requests[0].feedback_id,requests[3].feedback_id);
  }finally{client.dispose();}
});
test('an uncertain chat POST is never repeated automatically',async()=>{
  let attempts=0;
  const client=createAdRouterClient({endpoints,getTurnstileToken:async()=>'synthetic-token',fetch:async()=>{attempts++;throw new Error('synthetic network interruption');}});
  try{await assert.rejects(client.sendTurn({messages:[{role:'user',content:'Synthetic prompt.'}]}).done);assert.equal(attempts,1);}
  finally{client.dispose();}
});
test('metadata recovery rejects a response for a different turn',async()=>{
  const client=createAdRouterClient({endpoints,getTurnstileToken:async()=>'synthetic-token',fetch:async()=>Response.json({
    contract_version:'3.0-mvp.1',turn_id:'other-turn',interaction_id:'00000000-0000-4000-8000-000000000001',
    state:'running',model_outcome:'pending',sponsor_outcome:'pending',offer_id:null,usage:null,
    created_at:new Date().toISOString(),finished_at:null,safe_error_code:null})});
  try{await assert.rejects(()=>client.getTurnStatus('requested-turn'),(error:any)=>error.code==='stream_protocol_error');}
  finally{client.dispose();}
});
