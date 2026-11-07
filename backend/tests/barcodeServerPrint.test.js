const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const child = require('node:child_process');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

test('label preview leaves stock alone and server printing uses the configured queue', async t => {
  const template = 'tsc-244-1-33x25-single.prn';
  const share = '\\\\localhost\\QA & Labels';
  const queries = [];
  require.cache[require.resolve('../config/db')] = { exports: { async query(sql) {
    queries.push(sql);
    return [[{setting_value: JSON.stringify({[template]: {printer:'Labels', shares:[share]}})}]];
  } } };
  const execute = promisify(child.execFile);
  const original = child.execFile;
  const send = t.mock.fn((_name,_args,_opts,done) => done(null, '', ''));
  child.execFile = send;
  t.after(() => { child.execFile = original; });
  const app = express();
  app.use(express.json(), require('../routes/barcode'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (route, body) => fetch('http://127.0.0.1:' + server.address().port + route, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+jwt.sign({role:'ADMIN'},JWT_SECRET)}, body:JSON.stringify(body)
  });
  const result = await call('/preview',{template_name:template, barcode:'12345', product_name:'Test label'});
  assert.equal(result.status,200);
  assert.match((await result.json()).prn,/12345/);
  assert.equal(queries.length,0);
  assert.equal(send.mock.callCount(),0);

  assert.equal((await call('/print',{output_name:'test&something.prn'})).status,400);
  const outputName = 'QA_123.prn';
  t.mock.method(fs,'access',async target => assert.equal(path.basename(target),outputName));
  assert.equal((await call('/print',{output_name:outputName,template_name:template})).status,200);
  const [cmd,args,options] = send.mock.calls[0].arguments;
  assert.equal(options.env.BADIZO_PRN_SHARE,share);
  assert.deepEqual(args.slice(0,3),['/d','/v:off','/c']);
  if (process.platform === 'win32') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'QA labels & '));
    const source = path.join(dir,'batch %PATH%.prn'), output = path.join(dir,'queue & labels');
    try {
      await fs.writeFile(source,'PRINT 1,1');
      await execute(cmd,args,{...options,env:{...options.env,BADIZO_PRN_SOURCE:source,BADIZO_PRN_SHARE:output}});
      assert.equal(await fs.readFile(output,'utf8'),'PRINT 1,1');
    } finally {
      await fs.rm(source,{force:true}); await fs.rm(output,{force:true}); await fs.rmdir(dir);
    }
  }
});
