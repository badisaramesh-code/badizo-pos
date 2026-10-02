const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'electron/main.js'),'utf8');
const config=JSON.parse(fs.readFileSync(path.join(root,'output/new-store-20260920/app-config.json')));
const tried=[];
const ctx={
path,app:{getPath:()=>'/userdata'},process:{env:{},resourcesPath:'/resources',cwd:()=>'/working'},__dirname:'/app',
readJsonIfExists:()=>config,readCachedServerHost:()=> '192.168.9.99',DEFAULT_APP_URL:'http://localhost:5000',DEFAULT_API_URL:'http://localhost:5000/api/health',DEFAULT_BACKEND_PORT:5000,DEFAULT_FRONTEND_PORT:5000,DEFAULT_DISCOVERY_TIMEOUT_MS:9000,
getLoginParamsFromUrl:()=>({}),getUrlHost:u=>new URL(u).hostname,isRemoteHost:()=>true,parseServerHosts:v=>Array.isArray(v)?v:[v],getUrlPort:(u,f)=>Number(new URL(u).port||f),isLoopbackHost:h=>h==='localhost',buildUrl:(h,p,n)=>'http://'+h+':'+p+n,
findReachableHealthUrl:async urls=>{tried.push(...urls);return urls[0]},saveCachedServerHost:()=>{},logMessage:()=>{},scanSubnetForHealth:()=>{throw Error('LAN scan must not run')},setTimeout,URL
};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function getConfig()'),source.indexOf('function getLoginParamsFromUrl'))+source.slice(source.indexOf('async function resolveRemoteServer'),source.indexOf('async function waitForUrl'))+'; this.read=getConfig; this.resolve=resolveRemoteServer;',ctx);
(async()=>{const c=ctx.read();assert.deepEqual(Array.from(c.serverHosts),['192.168.1.10']);const result=await ctx.resolve(c);assert.equal(result.appUrl,'http://192.168.1.10:5000/');assert.ok(tried.every(u=>new URL(u).hostname==='192.168.1.10'));console.log('PASS: stale cache ignored; only fixed LAN host probed; no discovery scan');})().catch(e=>{console.error(e);process.exitCode=1});
