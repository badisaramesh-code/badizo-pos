const fs = require('node:fs');
const path = require('node:path');
let boot = null;
let activeWrites = 0;
function validate(value, shopId) {
  if (!value || value.schemaVersion !== 1 || value.shopId !== shopId || !/^[a-f0-9-]{36}$/.test(value.activationId || '') || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !['active','validating'].includes(value.phase) || !['active','standby'].includes(value.billingMode)
    || !value.database || !['localhost','127.0.0.1','::1'].includes(value.database.host)
    || !/^[a-zA-Z0-9_]{1,64}$/.test(value.database.database || '') || typeof value.database.user !== 'string' || typeof value.database.password !== 'string') throw Error('Invalid recovery runtime binding.');
  return value;
}
function read(env = process.env) {
  const file = env.BADIZO_RUNTIME_BINDING;
  if (!file) return null;
  if (!path.isAbsolute(file)) throw Error('Recovery runtime binding must be an absolute protected path.');
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')), env.BADIZO_SHOP_ID);
}
function load(env = process.env) {
  const value = read(env);
  if (!value) return null;
  boot = value;
  env.DB_HOST = value.database.host; env.DB_USER = value.database.user;
  env.DB_PASSWORD = value.database.password; env.DB_NAME = value.database.database;
  // Restore activation never bootstraps or modifies a recovered schema.
  env.BADIZO_DB_BOOTSTRAP = 'false';
  return value;
}
function status() {
  const current = read();
  if (!current) return null;
  return { activationId: boot?.activationId || null, generation:current.generation, phase:current.phase, billingMode:current.billingMode, activeWrites, reconciliationRequired:!!current.reconciliationRequired };
}
function middleware(req,res,next) {
  if (!process.env.BADIZO_RUNTIME_BINDING || ['GET','HEAD','OPTIONS'].includes(req.method)
    || /^\/(auth\/(login|logout|logout-beacon)|recovery-control(?:\/|$)|recovery-baseline(?:\/|$)|recovery-preparation(?:\/|$))/.test(req.path)) return next();
  try {
    const current = read();
    const recoveryWork = /^\/(recovery-review|recovery-cases|staged-restore)(?:\/|$)/.test(req.path) || (!!process.env.BADIZO_SYNC_ENROLLMENT_CONFIG && /^\/sync\/(events|feed\/ack|handoff(?:\/flush)?)$/.test(req.path));
    if(current.handoffId&&/^\/(recovery-review|recovery-cases|staged-restore)(?:\/|$)/.test(req.path))return res.status(409).json({error:'A coordinated billing switch is holding writes. Finish or cancel that operation first.'});
    if (!boot || current.activationId !== boot.activationId || current.phase !== 'active' || (current.billingMode !== 'active' && !recoveryWork)) return res.status(409).json({error:'Billing is paused for recovery. Use the owner recovery controls.'});
  } catch { return res.status(503).json({error:'Recovery state requires inspection. No new writes were accepted.'}); }
  activeWrites++;
  let finished = false;
  // Background imports outlive the HTTP 202 response. Reserve their lease
  // while this already-admitted request is still active, even if a supervisor
  // has meanwhile started draining it.
  req.retainRecoveryWrite = () => {
    if (finished) throw Error('Cannot start recovery work after the request finished.');
    activeWrites++;
    let released = false;
    return () => { if (!released) { released = true; activeWrites--; } };
  };
  // An aborted response is not proof its database work finished. Keep the
  // gate busy in that case; activation times out instead of killing work.
  const complete=()=>{if(!finished){finished=true;activeWrites--;}};
  // A disconnected response does not release the lease. A handler which
  // owns its full transaction may release it in finally after commit/rollback.
  req.completeRecoveryWrite=complete;
  res.once('finish',complete);
  next();
}
async function withWriteLease(operation){
  const current=read();
  if(current&&(!boot||current.activationId!==boot.activationId||current.phase!=='active'))throw Error('Recovery is pausing database writes.');
  activeWrites++;
  try{return await operation();}finally{activeWrites--;}
}
function retainRequestWrite(req) {
  if (!process.env.BADIZO_RUNTIME_BINDING) return () => {};
  if (typeof req.retainRecoveryWrite !== 'function') throw Error('Background write was not admitted by the recovery gate.');
  return req.retainRecoveryWrite();
}
module.exports={validate,read,load,status,middleware,withWriteLease,retainRequestWrite};
