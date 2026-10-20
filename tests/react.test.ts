import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {useAdRouterChat} from '../src/react.js';
const endpoints={chat:'/api/chat',status:(id:string)=>'/api/turns/'+id,cancel:(id:string)=>'/api/turns/'+id+'/cancel',feedback:'/api/feedback',clientEvents:'/api/client-events',measurement:'/v3/sponsor/events'};
test('useAdRouterChat starts from stored history and drops invalid entries',()=>{
  let seen:unknown;
  function Probe(){const chat=useAdRouterChat({endpoints,getTurnstileToken:async()=>'synthetic-token',fetch:async()=>Response.json({})},
    {initialMessages:[{role:'user',content:'Synthetic stored question.'},{role:'assistant',content:'Synthetic stored answer.'},
      {role:'system',content:'Not a public message.'} as any,{role:'user',content:''}]});
    seen=chat.state.messages;chat.client.dispose();return null;}
  renderToString(createElement(Probe));
  assert.deepEqual(seen,[{role:'user',content:'Synthetic stored question.'},{role:'assistant',content:'Synthetic stored answer.'}]);
});
