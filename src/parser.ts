import { TurnEventSchema } from './generated/schema.js';
import type { TurnEvent } from './generated/wire.js';

export async function* parseEvents(body:ReadableStream<Uint8Array>,signal?:AbortSignal):AsyncGenerator<TurnEvent> {
  const reader=body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
  let pending='',sequence=0,turn='',started=false,model=false,sponsor=false,usage=false,completed=false;
  try {
    for(;;) {
      if(signal?.aborted) throw new Error('transport_interrupted');
      const {value,done}=await reader.read();
      pending+=decoder.decode(value,{stream:!done});
      if(new TextEncoder().encode(pending).byteLength>327_680) throw new Error('stream_protocol_error');
      let newline:number;
      while((newline=pending.indexOf('\n'))!==-1) {
        const line=pending.slice(0,newline); pending=pending.slice(newline+1);
        if(new TextEncoder().encode(line).byteLength>65_536 || completed) throw new Error('stream_protocol_error');
        const event=TurnEventSchema.parse(JSON.parse(line));
        if(event.sequence!==++sequence || (turn && event.turn_id!==turn)) throw new Error('stream_protocol_error');
        turn=event.turn_id;
        if(!started && event.type!=='turn.started') throw new Error('stream_protocol_error');
        if(event.type==='turn.started') {if(started) throw new Error('stream_protocol_error');started=true;}
        if(event.type==='model.delta' && model) throw new Error('stream_protocol_error');
        if(event.type==='model.completed' || event.type==='model.error') {if(model) throw new Error('stream_protocol_error');model=true;}
        if(event.type.startsWith('sponsor.')) {if(sponsor) throw new Error('stream_protocol_error');sponsor=true;}
        if(event.type==='usage.final') {if(usage || !model || !sponsor) throw new Error('stream_protocol_error');usage=true;}
        if(event.type==='turn.completed') {if(!model || !sponsor || !usage) throw new Error('stream_protocol_error');completed=true;}
        yield event as TurnEvent;
      }
      if(new TextEncoder().encode(pending).byteLength>65_536) throw new Error('stream_protocol_error');
      if(done) break;
    }
    if(pending || !completed) throw new Error('transport_interrupted');
  } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
