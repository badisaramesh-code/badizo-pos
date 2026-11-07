const fs = require('node:fs/promises');
const path = require('node:path');
const allowed = new Set(['dashboard','billing','closing','cashLedger','gatePass','inventory','importHistory','reports','books','system','orders','inward','localAccounts','staffPayroll','barcode','priceList','inventoryDashboard']);
const file = process.env.BADIZO_USAGE_PATH;
let day, counts, dirty = false, writing = false;
const today = () => new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
const ready = file && path.isAbsolute(file);
const initialized = ready ? fs.readFile(file,'utf8').then(JSON.parse).then(previous=>{
  if (previous.day === today()) { day=previous.day; counts=previous.counts; }
}).catch(()=>{}) : Promise.resolve();
async function record(area) {
  if (!ready || !allowed.has(area)) return;
  await initialized;
  if (day !== today() || !counts) { day=today(); counts={}; }
  counts[area]=(counts[area]||0)+1;
  dirty=true;
}
if (ready) setInterval(async ()=>{
  if (!dirty || writing) return;
  writing=true;dirty=false;
  try {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temporary=file+'.'+process.pid+'.tmp';
    await fs.writeFile(temporary,JSON.stringify({day,counts}));
    await fs.rename(temporary,file);
  } catch { dirty=true; } finally { writing=false; }
},30000).unref();
module.exports = { record, enabled:Boolean(ready) };
