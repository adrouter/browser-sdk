import type {PublicMessage} from './generated/wire.js';
export interface HistoryLimits {maxMessages?:number;maxBytes?:number}
export interface HistoryTrimmed {removedMessages:number;retainedMessages:number}
export function trimHistory(messages:PublicMessage[],limits:HistoryLimits={}) {
  const maxMessages=limits.maxMessages??14,maxBytes=limits.maxBytes??12_000;
  if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>15||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>60_000)
    throw new Error('invalid_history_limits');
  if(!messages.length||messages.at(-1)?.role!=='user')throw new Error('invalid_request');
  const result=messages.map(message=>({...message}));let removedMessages=0;
  const size=()=>new TextEncoder().encode(JSON.stringify(result)).length;
  while(result.length>1&&(result.length>maxMessages||size()>maxBytes)){result.shift();removedMessages++;}
  if(size()>maxBytes)throw new Error('latest_message_too_large');
  return {messages:result,removedMessages,retainedMessages:result.length};
}
