'use strict';
const {id}=require('./metrics.cjs');
function plainText(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  // Only visible text. Explicitly ignore think/reasoning, system prompts, tool output and attachments.
  return content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
}
function turnId(meta,value){return value===undefined||value===null?null:id(JSON.stringify([meta.source,meta.session,meta.agent,String(value)]));}
function message(record,meta,state,collectContent=true){
  let role,text,key,requestId=null;
  if(record.type==='turn.prompt'){
    role='user';text=plainText(record.input);key=record.promptId||meta.line;
  }else if(record.type==='agent.message.appended'&&record.message?.message?.role==='assistant'){
    role='assistant';text=plainText(record.message.message.content);key=record.message.meta?.messageId||meta.line;requestId=state.request?.id||null;
  }else return null;
  if(!Number.isFinite(record.time)||!text)return null;
  return {id:id(JSON.stringify([meta.source,meta.session,meta.agent,role,key])),source:meta.source,session:id(meta.session),agent:meta.agent,
    turnId:state.turnId,requestId,time:record.time,role,text:collectContent?text:null,chars:text.length,
    associationBasis:role==='user'?'explicit-turn-id':'same-agent-wire-request-order',contentStatus:collectContent?'visible-text':'content-disabled'};
}
module.exports={plainText,turnId,message};
