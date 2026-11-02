const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');

test('discovery rejects HTML and unrelated health responses, accepts existing POS servers', async () => {
  const source = main.slice(main.indexOf('async function isReachable('), main.indexOf('function getUrlHost('));
  for (const [health, expected] of [[{ok:true},true],[{ok:true,service:'badizo-pos'},true],[{ok:true,service:'other-app'},false],[{ok:false},false],[null,false]]) {
    const context = { URL, AbortController, setTimeout, clearTimeout, fetch: async () => ({ok:true,json:async()=>{if(health===null)throw Error('HTML');return health;}}) };
    vm.runInNewContext(source, context);
    assert.equal(await context.isReachable('http://server:5000/api/health'),expected);
  }
});

function clientWindow(recoveredHost) {
  const timers=[]; const loads=[]; const published=[];
  const eventHandlers={}; let heartbeat;
  class Window {
    constructor() { this.webContents={on:(name,handler)=>eventHandlers[name]=handler,setWindowOpenHandler(){},setZoomFactor(){},setVisualZoomLevelLimits:async()=>{}}; }
    once() {} on() {} isDestroyed(){return false;} isVisible(){return true;} maximize(){} show(){}
    async loadURL(url){loads.push(url);}
  }
  const context={mainWindow:null,BrowserWindow:Window,screen:{getPrimaryDisplay:()=>({workAreaSize:{width:1280,height:800}})},path, __dirname:'test',
    resolveResourcePath:()=>'',withLoginParams:(url)=>url, logMessage(){}, shell:{openExternal(){}},publishServerConnection:config=>published.push(config.apiHealthUrl),
    setTimeout:(callback,ms)=>{const timer={callback,ms};timers.push(timer);return timer;},clearTimeout(){},setInterval:callback=>{heartbeat=callback;return 1;},clearInterval(){},
    isReachable:async()=>false,resolveRemoteServer:async(config)=>({...config,appUrl:`http://${recoveredHost}:5000/`,apiHealthUrl:`http://${recoveredHost}:5000/api/health`})};
  const source=main.slice(main.indexOf('function createWindow(config)'),main.indexOf('function clampNumber('));
  vm.runInNewContext(source,context);
  context.createWindow({appUrl:'http://192.168.1.10:5000/',apiHealthUrl:'http://192.168.1.10:5000/api/health',startFrontend:false});
  return {eventHandlers,loads,published,heartbeat:()=>heartbeat(),reconnect:()=>timers.filter(timer=>timer.ms===2000).at(-1).callback()};
}

for(const recoveredHost of ['192.168.1.10','192.168.1.15']) {
  test(`loaded billing page survives reconnect to ${recoveredHost} without navigation or logout`,async()=>{
    const app=clientWindow(recoveredHost);
    app.eventHandlers['did-finish-load']();
    await app.heartbeat();await app.heartbeat();await app.reconnect();
    assert.equal(app.loads.length,1);
    assert.equal(app.published.at(-1),`http://${recoveredHost}:5000/api/health`);
  });
}

test('failed initial navigation retries until server returns',async()=>{
  const app=clientWindow('192.168.1.10');
  app.eventHandlers['did-fail-load']({},-102,'Connection refused','',true);
  await app.reconnect();
  assert.equal(app.loads.length,2);
});

test('HTTP error page is retried instead of being treated as a loaded POS',async()=>{
  const app=clientWindow('192.168.1.10');
  app.eventHandlers['did-navigate']({},'http://server/',503);
  app.eventHandlers['did-finish-load']();
  await app.reconnect();
  assert.equal(app.loads.length,2);
});

test('explicit installation config wins over stale per-user or dedicated counter config',()=>{
  const explicit={appUrl:'http://192.168.1.10:5000?loginMode=counter',apiHealthUrl:'http://192.168.1.10:5000/api/health',loginMode:'counter',loginUser:'',startBackend:false,startFrontend:false};
  const context={process:{resourcesPath:'resources',cwd:()=>'.',env:{BADIZO_CLIENT_CONFIG:'client-settings.json'}},path,__dirname:'app',
    app:{getPath:()=> 'old-user-config'},readJsonIfExists:file=>file==='client-settings.json'?explicit:{forcePackagedConfig:true,loginUser:'admin1',appUrl:'http://stale:5000'},
    DEFAULT_APP_URL:'http://localhost:5000',DEFAULT_API_URL:'http://localhost:5000/api/health',DEFAULT_BACKEND_PORT:5000,DEFAULT_FRONTEND_PORT:5000,DEFAULT_DISCOVERY_TIMEOUT_MS:12000,
    readCachedServerHost:()=>'',getUrlHost:url=>new URL(url).hostname,getLoginParamsFromUrl:()=>({}),isRemoteHost:()=>true,parseServerHosts:()=>[]};
  vm.runInNewContext(main.slice(main.indexOf('function getConfig()'),main.indexOf('function getLoginParamsFromUrl(')),context);
  const config=context.getConfig();
  assert.equal(config.loginUser,'');assert.equal(config.loginMode,'counter');assert.equal(config.appUrl,explicit.appUrl);
  assert.equal(config.startBackend,false);assert.equal(config.startFrontend,false);
});

for(const allowLoopbackServer of [true,false]) {
  test(`server desktop loopback connection is ${allowLoopbackServer?'explicitly allowed':'blocked on remote clients'}`,async()=>{
    let probed=[];
    const context={Date,Set,Number,Promise,DEFAULT_DISCOVERY_TIMEOUT_MS:12000,logMessage(){},saveCachedServerHost(){},
      getUrlHost:url=>new URL(url).hostname,getUrlPort:url=>Number(new URL(url).port),isLoopbackHost:host=>host==='127.0.0.1',
      buildUrl:(host,port,pathname)=>`http://${host}:${port}${pathname}`,findReachableHealthUrl:async urls=>{probed.push(...urls);return urls[0];}};
    vm.runInNewContext(main.slice(main.indexOf('async function resolveRemoteServer('),main.indexOf('async function waitForUrl(')),context);
    await context.resolveRemoteServer({startFrontend:false,startBackend:false,allowLoopbackServer,appUrl:'http://127.0.0.1:5000/',apiHealthUrl:'http://127.0.0.1:5000/api/health',backendPort:5000,serverHosts:['192.168.1.10'],discoveryEnabled:false});
    assert.equal(probed.some(url=>url.includes('127.0.0.1')),allowLoopbackServer);
  });
}

test('API redirects to rediscovered server, retains auth and never retries a sale POST',async()=>{
  const handlers={};let connectionListener;const retried=[];
  const api=Object.assign(async config=>retried.push(config),{defaults:{},interceptors:{request:{use:fn=>handlers.request=fn},response:{use:(_ok,fn)=>handlers.failure=fn}}});
  const window={location:{protocol:'http:',hostname:'192.168.1.10'},sessionStorage:{getItem:()=> 'existing-token'},badizoDesktop:{getServerConnection:async()=>({apiBaseUrl:'http://192.168.1.10:5000/api'}),onServerConnectionChanged:fn=>connectionListener=fn}};
  const context={URL,Promise,window,axios:{create:config=>{api.defaults={...config};return api;}},setTimeout:callback=>callback()};
  let source=fs.readFileSync(path.join(__dirname,'../frontend/src/api/client.js'),'utf8');
  source=source.replace("import axios from 'axios';",'').replace('export default api;','').replace(/export /g,'');
  vm.runInNewContext(source,context);
  await handlers.request({url:'/sales',headers:{}});
  connectionListener({apiBaseUrl:'http://192.168.1.15:5000/api'});
  const request=await handlers.request({url:'/sales',headers:{}});
  assert.equal(request.baseURL,'http://192.168.1.15:5000/api');
  assert.equal(request.headers.Authorization,'Bearer existing-token');
  connectionListener({apiBaseUrl:'file:///api'});
  assert.equal(api.defaults.baseURL,'http://192.168.1.15:5000/api');
  const error={config:{method:'post'},request:{},code:'ECONNRESET'};
  await assert.rejects(handlers.failure(error),value=>value===error);
  assert.equal(retried.length,0);
  await handlers.failure({config:{method:'get'},request:{},code:'ECONNRESET'});
  assert.equal(retried.length,1);
});
