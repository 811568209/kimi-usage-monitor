'use strict';
// Shared browser/Node paging state. Only page sizes are persisted; analysis always uses all records.
(function(root){
  function createPagination(storage,key='kimi-usage-monitor.pagination.v1'){
    let sizes={};try{const saved=JSON.parse(storage?.getItem(key)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))sizes=saved;}catch{}
    const pages=new Map();
    const valid=n=>Number.isSafeInteger(n)&&n>=5&&n<=100;
    function size(id){return valid(sizes[id])?sizes[id]:10;}
    function setSize(id,value){
      const n=Number(value);if(!Number.isSafeInteger(n))return size(id);
      sizes[id]=Math.max(5,Math.min(100,n));pages.set(id,1);
      try{storage?.setItem(key,JSON.stringify(sizes));}catch{}
      return sizes[id];
    }
    function setPage(id,value){if(Number.isSafeInteger(value)&&value>0)pages.set(id,value);}
    function describe(id,total){
      const perPage=size(id),count=Math.max(1,Math.ceil(total/perPage)),page=Math.min(pages.get(id)||1,count);pages.set(id,page);
      return {page,size:perPage,pages:count,total,start:(page-1)*perPage};
    }
    function slice(id,rows){const p=describe(id,rows.length);return {...p,records:rows.slice(p.start,p.start+p.size)};}
    return {size,setSize,setPage,describe,slice};
  }
  if(typeof module==='object'&&module.exports)module.exports={createPagination};else root.KimiPagination={createPagination};
})(globalThis);
