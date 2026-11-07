const express = require('express');
const fs = require('node:fs/promises');
const {randomUUID} = require('node:crypto');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();
const requestFile = '/var/lib/badizo-cloud-update/inbox/request';
const stateFile = '/var/lib/badizo-cloud-update/state.json';
let cached, expires = 0;

function latest() {
  if (cached && Date.now() < expires) return cached;
  expires = Date.now() + 120000;
  cached = (async () => {
    const response = await fetch('https://api.github.com/repos/badisaramesh-code/badizo-pos/releases/latest', {
      redirect:'error', signal:AbortSignal.timeout(6000)
    });
    if (!response.ok) throw Error('Release lookup failed');
    const release = await response.json();
    if (!/^pos-[a-f0-9]{40}$/.test(release.tag_name) || release.draft || release.prerelease ||
        !release.assets?.some(asset => asset.name === 'badizo-pos-cloud.zip' && /^sha256:[a-f0-9]{64}$/.test(asset.digest))) return null;
    return {commit:release.tag_name.slice(4),name:release.name};
  })();
  return cached;
}

router.use(authenticate, authorize('ADMIN','SERVER'));
function standby() {
  return process.env.BADIZO_NODE_ROLE === 'cloud-standby' && !process.env.BADIZO_RUNTIME_BINDING &&
    !process.env.BADIZO_SYNC_ENROLLMENT_CONFIG && !process.env.BADIZO_RECOVERY_CONTROL_CONFIG && process.env.BADIZO_DB_BOOTSTRAP !== 'true';
}
router.get('/',async (_req,res) => {
  try {
    const state = JSON.parse(await fs.readFile(stateFile,'utf8'));
    const release = await latest().catch(()=>undefined);
    res.set('Cache-Control','no-store').json({state,release,lookupFailed:release===undefined,standby:standby(),running:process.env.BADIZO_RELEASE_COMMIT});
  } catch {res.status(503).json({error:'Cloud software updater needs setup.'});}
});
router.post('/',async (req,res) => {
  if (!standby()) return res.status(409).json({error:'Updates require idle cloud standby.'});
  try {
    const release = await latest();
    if (!release || release.commit!==req.body?.commit || release.commit===process.env.BADIZO_RELEASE_COMMIT)
      return res.status(409).json({error:'Refresh the available release.'});
    const staged=requestFile+'-'+randomUUID();
    await fs.writeFile(staged,release.commit,{flag:'wx',mode:0o640});
    try {await fs.link(staged,requestFile);} finally {await fs.unlink(staged);}
    res.status(202).json({queued:true});
  } catch(error) {res.status(error.code==='EEXIST'?409:503).json({error:error.code==='EEXIST'?'An update is already queued.':'Could not request the cloud update.'});}
});
module.exports = router;
