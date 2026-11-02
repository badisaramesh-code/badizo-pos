const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('electron/main.js','utf8');
const read=vm.runInNewContext(source.slice(source.indexOf('function readJsonIfExists'),source.indexOf('function readCachedServerHost'))+';readJsonIfExists',{fs:{existsSync:()=>true,readFileSync:()=>String.fromCharCode(65279)+'{"loginMode":"counter","loginUser":"counter2"}'}});
const c=read('app-config.json');assert.equal(c.loginUser,'counter2');console.log('PASS: BOM-prefixed Windows role config is readable');
