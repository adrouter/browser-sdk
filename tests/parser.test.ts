import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents } from '../src/parser.js';
const events=[
  {type:'turn.started',data:{interaction_id:'00000000-0000-4000-8000-000000000001',contract_version:'3.0-mvp.1'}},
  {type:'model.delta',data:{text:'你好 🌏'}},
  {type:'sponsor.none',data:{reason:'opt_out'}},
  {type:'model.completed',data:{finish_reason:'stop'}},
  {type:'usage.final',data:{status:'known',input_tokens:10,output_tokens:5,cache_read_tokens:null,cache_write_tokens:null,estimated_cost_microusd:null,rate_revision:null}},
  {type:'turn.completed',data:{state:'completed'}},
].map((event,i)=>({...event,turn_id:'turn-test',sequence:i+1}));
const stream=(input:unknown[],fragment=true)=>{const bytes=new TextEncoder().encode(input.map(v=>JSON.stringify(v)+'\n').join(''));
  return new ReadableStream<Uint8Array>({start(controller){if(fragment)for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));else controller.enqueue(bytes);controller.close();}});};
test('parser preserves UTF-8 across single-byte chunks',async()=>{
  const result=[];for await(const event of parseEvents(stream(events)))result.push(event);
  assert.equal(result.length,6);assert.deepEqual(result[1].data,{text:'你好 🌏'});
});
test('parser rejects sequence gaps, mixed turns, duplicate terminals and truncated streams',async()=>{
  for(const bad of [events.slice(0,-1),[...events,events[0]],events.map((v,i)=>i===1?{...v,sequence:9}:v),
    events.map((v,i)=>i===1?{...v,turn_id:'other'}:v),events.map((v,i)=>i===4?{...events[3],sequence:5}:v)]){
    await assert.rejects(async()=>{for await(const _ of parseEvents(stream(bad))){};});
  }
});
