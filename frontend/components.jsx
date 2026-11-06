import React,{useEffect,useState} from 'react';
import {createPagination} from '../pagination.js';
import {fmt,score} from './api';
let storage;try{storage=localStorage;}catch{}
const pagination=createPagination(storage);
export function usePageSize(id){
  const [size,update]=useState(()=>pagination.size(id));
  return [size,value=>{const next=pagination.setSize(id,value);update(next);return next;}];
}
export function Pager({id,label,total,page,size,onPage,onSize}){
  const pages=Math.max(1,Math.ceil(total/size)),[draft,setDraft]=useState(String(size));
  useEffect(()=>setDraft(String(size)),[size]);
  const commit=value=>{const n=Number(value);if(Number.isSafeInteger(n)){const next=Math.max(5,Math.min(100,n));setDraft(String(next));onSize(next);onPage(1);}else setDraft(String(size));};
  return <div className="toolbar pagination" id={id+'Pager'}>
    <span className="small">共 {fmt(total)} 条 · 第 {page} / {pages} 页</span>
    <div className="actions"><label className="page-size-label">每页 <input type="number" min="5" max="100" step="1" aria-label={label+'每页条数'} value={draft}
      onChange={e=>{const value=e.target.value;setDraft(value);const n=Number(value);if(value&&Number.isSafeInteger(n)&&n>=5&&n<=100)commit(value);}}
      onBlur={e=>commit(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/> 条</label>
      <button disabled={page<=1} onClick={()=>onPage(page-1)} aria-label={label+'上一页'}>上一页</button>
      <button disabled={page>=pages} onClick={()=>onPage(page+1)} aria-label={label+'下一页'}>下一页</button></div>
  </div>;
}
export function Paged({id,label,rows=[],columns,render,empty='此范围暂无记录'}){
  const [size,setSize]=usePageSize(id),[requested,setPage]=useState(1),page=Math.min(requested,Math.max(1,Math.ceil(rows.length/size))),visible=rows.slice((page-1)*size,page*size);
  useEffect(()=>{if(requested!==page)setPage(page);},[requested,page]);
  return <><div className={columns?'scroll':'list-content'}>{columns?<table><thead><tr>{columns.map(x=><th key={x}>{x}</th>)}</tr></thead><tbody id={id}>{visible.length?visible.map((row,i)=><React.Fragment key={row.id??row.key??(page-1)*size+i}>{render(row,i)}</React.Fragment>):<tr><td colSpan={columns.length} className="empty">{empty}</td></tr>}</tbody></table>:<div id={id}>{visible.length?visible.map((row,i)=><React.Fragment key={row.id??row.key??(page-1)*size+i}>{render(row,i)}</React.Fragment>):<p className="empty">{empty}</p>}</div>}</div>
    <Pager id={id} label={label} total={rows.length} page={page} size={size} onPage={setPage} onSize={setSize}/></>;
}
export function Panel({title,actions,children,id}){return <section className="panel" id={id}><div className="toolbar"><h2>{title}</h2>{actions&&<div className="actions">{actions}</div>}</div>{children}</section>;}
export function Export({name,children}){return <a className="btn" href={'/export/'+name}>{children}</a>;}
export function Quality({confidence}){return <span className={'quality quality-'+(confidence?.level==='高'?'high':confidence?.level==='中'?'medium':'low')}>可信度 {score(confidence)}{confidence?.level?' · '+confidence.level:''}</span>;}
export function Selection({value}){return value?<p className="small">本次采用：{value.label}；纳入 {value.usedWindows} 个区间，筛除 {value.excludedWindows} 个区间（高 {value.highWindows} / 中 {value.mediumWindows} / 低 {value.lowWindows}）。高 ≥70%，中 40%–69%，否则全量回退。原始数据始终保留。</p>:null;}
export class FeatureBoundary extends React.Component{
  state={error:null};static getDerivedStateFromError(error){return {error};}
  render(){return this.state.error?<div className="note warning" role="alert">此模块暂时无法显示：{this.state.error.message} <button onClick={()=>this.setState({error:null})}>重试</button></div>:this.props.children;}
}
