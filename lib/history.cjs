'use strict';
function rangeParams(params,required=false){
  const from=params.get('from'),to=params.get('to');
  if(from===null&&to===null&&!required)return {};
  const start=Number(from),end=Number(to);
  if(from===null||to===null||!from.trim()||!to.trim()||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw Error('请选择有效的起止时间，结束时间须晚于开始时间');
  return {from:start,to:end};
}
function usageHistory(events,params){
  const pageValue=params.get('page')??'1',sizeValue=params.get('size')??'10';
  let page=Number(pageValue);const size=Number(sizeValue);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<5||size>100)throw Error('明细页码或每页数量无效（每页 5–100 条）');
  const source=params.get('source')||'all';if(!['all','code','work'].includes(source))throw Error('请选择有效的产品来源');
  const query=(params.get('q')||'').trim().toLowerCase().slice(0,100),range=rangeParams(params);
  const filtered=events.filter(e=>(source==='all'||e.source===source)&&(!query||[e.model,e.rawModel,e.thinking,e.agent].join(' ').toLowerCase().includes(query))&&
    (range.from===undefined||(e.time>=range.from&&e.time<=range.to))).sort((a,b)=>b.time-a.time||String(a.id).localeCompare(String(b.id)));
  const pages=Math.max(1,Math.ceil(filtered.length/size));page=Math.min(page,pages);
  return {page,size,pages,total:filtered.length,filters:{source,query,...range},records:filtered.slice((page-1)*size,page*size)};
}
module.exports={rangeParams,usageHistory};
