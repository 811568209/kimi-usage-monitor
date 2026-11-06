'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPagination}=require('../pagination.js');
test('所有列表默认十条；任意整数条数、独立记忆与重开恢复',()=>{
  let saved;const storage={getItem:()=>saved,setItem:(key,value)=>{saved=value;}},p=createPagination(storage),rows=Array.from({length:23},(_,i)=>i);
  assert.equal(p.slice('history',rows).records.length,10);assert.equal(p.slice('history',rows).pages,3);
  assert.equal(p.setSize('history',7),7);p.setPage('history',3);assert.deepEqual(p.slice('history',rows).records,[14,15,16,17,18,19,20]);
  assert.equal(p.size('models'),10);const reopened=createPagination(storage);assert.equal(reopened.size('history'),7);assert.equal(reopened.slice('history',rows).page,1);assert.equal(reopened.size('models'),10);
});
test('最少五条、最多一百条；更改条数回到第一页，缩小结果和空列表页码安全',()=>{
  const p=createPagination(),rows=Array.from({length:30},(_,i)=>i);p.setPage('x',3);assert.equal(p.setSize('x',2),5);assert.equal(p.slice('x',rows).page,1);
  p.setPage('x',6);assert.equal(p.slice('x',[1,2]).page,1);assert.equal(p.slice('x',[]).pages,1);assert.deepEqual(p.slice('x',[]).records,[]);
  assert.equal(p.setSize('x',200),100);assert.equal(p.setSize('x','NaN'),100);assert.equal(p.setSize('x',5.5),100);
});
test('损坏或不可用的浏览器存储不影响分页，非法历史设置恢复默认值',()=>{
  for(const value of ['{broken','null','[]','{"x":2}','{"x":1000}','{"x":"10"}'])assert.equal(createPagination({getItem:()=>value}).size('x'),10);
  const p=createPagination({getItem(){throw Error('denied');},setItem(){throw Error('full');}});assert.equal(p.setSize('x',9),9);assert.equal(p.size('x'),9);
});
