export async function get(path,signal){
  const response=await fetch(path,{cache:'no-store',signal}),body=await response.json();
  if(!response.ok)throw Error(body.error||'数据加载失败');return body;
}
export async function post(path,nonce,data={}){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-monitor-token':nonce},body:JSON.stringify(data)}),body=await response.json();
  if(!response.ok)throw Error(body.error||'操作失败');return body;
}
export const fmt=n=>n==null?'未知':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:0});
export const pct=n=>n==null?'—':(n*100).toFixed(2)+'%';
export const date=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'未知';
export const compact=n=>n>=1e8?(n/1e8).toFixed(1)+'亿':n>=1e4?(n/1e4).toFixed(1)+'万':fmt(n);
export const known=e=>e.inputOther+(e.cacheRead??0)+(e.cacheWrite??0)+e.output;
export const product=s=>s==='code'?'Kimi Code':s==='work'?'Kimi Work':s;
export const localInput=time=>{const d=new Date(time);return new Date(time-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export const score=c=>(c?.percent??c?.score??0)+'%';
