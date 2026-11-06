'use strict';
const path=require('node:path'),fs=require('node:fs'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..');
esbuild.buildSync({entryPoints:[path.join(root,'frontend/app.jsx')],bundle:true,minify:true,jsx:'automatic',target:['es2022'],outfile:path.join(root,'public/app.js'),define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
console.log('React 看板已构建到 public/app.js 和 public/app.css。');
