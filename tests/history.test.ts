import test from 'node:test';
import assert from 'node:assert/strict';
import {trimHistory} from '../src/history.js';
import {createAdRouterClient} from '../src/index.js';
test('history fits UTF-8 bytes and message count while keeping the newest user message intact',()=>{
  const latest={role:'user' as const,content:'The newest message 🦉'};
  const result=trimHistory([...Array.from({length:20},()=>({role:'assistant' as const,content:'é🦉'.repeat(1000)})),latest]);
  assert.ok(result.removedMessages>0);assert.ok(result.messages.length<=14);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.messages)).length<=12_000);
  assert.deepEqual(result.messages.at(-1),latest);
  assert.throws(()=>trimHistory([{...latest,content:'🦉'.repeat(4000)}]));
});
test('oversized newest message never obtains a challenge or starts generation',async()=>{
  let tokens=0,requests=0;
  const client=createAdRouterClient({endpoints:{chat:'/chat',status:id=>'/status/'+id,cancel:id=>'/cancel/'+id,feedback:'/feedback',clientEvents:'/events',measurement:'/measure'},
    getTurnstileToken:async()=>{tokens++;return 'synthetic';},fetch:async()=>{requests++;throw new Error('must not call');}});
  await assert.rejects(client.sendTurn({messages:[{role:'user',content:'🦉'.repeat(4000)}]}).done);
  assert.equal(tokens,0);assert.equal(requests,0);client.dispose();
});
test('trim notice precedes challenge and transport; a missing notice prevents submission',async()=>{
  const messages=[...Array.from({length:18},()=>({role:'assistant' as const,content:'Synthetic earlier text 🦉'})),{role:'user' as const,content:'Latest synthetic message.'}];
  const order:string[]=[];let sent:any;
  const options={endpoints:{chat:'/chat',status:(id:string)=>'/status/'+id,cancel:(id:string)=>'/cancel/'+id,feedback:'/feedback',clientEvents:'/events',measurement:'/measure'},
    getTurnstileToken:async()=>{order.push('challenge');return 'synthetic';},fetch:async(_url:any,init?:RequestInit)=>{order.push('post');sent=JSON.parse(String(init?.body));
      return Response.json({error:{code:'service_unavailable',message:'Synthetic unavailable.',retryable:false},request_id:crypto.randomUUID()},{status:503});}};
  const missing=createAdRouterClient(options);await assert.rejects(missing.sendTurn({messages}).done);assert.deepEqual(order,[]);missing.dispose();
  const client=createAdRouterClient({...options,onHistoryTrimmed:event=>{assert.equal(event.removedMessages,5);order.push('notice');}});
  await assert.rejects(client.sendTurn({messages}).done);
  assert.deepEqual(order,['notice','challenge','post']);assert.equal(sent.messages.length,14);assert.deepEqual(sent.messages.at(-1),messages.at(-1));client.dispose();
});
