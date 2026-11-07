const {hasCaptureGap, recordCaptureGap} = require('./captureGap');
const { DEFAULT_CONFIG } = require('./cloudSyncSettingsService');
const runtimeBinding = require('./recoveryRuntimeBinding');
const { disableCapture } = require('./enrolledSyncRuntime');

const reason = 'capture-gap-requires-baseline';
const message = 'Local billing is available. Cloud updates are paused. Prepare and verify a new recovery baseline before switching servers.';

function degradedRuntime() {
  const status = async () => ({ready:false, reason});
  const unavailable = async () => { throw Object.assign(Error(message), {status:409}); };
  return {
    captureGap:true, status, start() {}, stop() {},
    mount(router) { router.use((_req, res) => res.status(503).json({ready:false, reason})); },
    settings: {
      state: async () => ({config:{...DEFAULT_CONFIG}, nodeRole:'local-server', editable:false,
        service:{ready:false, state:'paused'}, lastSuccessAt:null, nextRunAt:null, message}),
      save:unavailable, requestNow:unavailable
    }
  };
}

async function protectedEnrollment({create, pool, env = process.env, bindingService = runtimeBinding, onFailure = () => {}}) {
  const binding = bindingService.read(env);
  if (!binding) return create();

  const alreadyMarked = await hasCaptureGap(env.BADIZO_RUNTIME_BINDING, binding);
  let failure = Error('Previous local billing requires a new recovery baseline.');
  if (!alreadyMarked) {
    try {
      const runtime = await create();
      // A restored active local database must record the gap before serving
      // sales. Candidate validation itself can still start with writes fenced.
      if (!runtime.requiresEnrollment) {
        if (!await hasCaptureGap(env.BADIZO_RUNTIME_BINDING,binding)) return runtime;
      } else if (env.BADIZO_NODE_ROLE !== 'local-server') {
        return runtime;
      } else if (binding.phase !== 'active' || binding.billingMode !== 'active' || binding.handoffId) {
        // The supervisor can release a staged database without restarting its
        // process. It will then bill with capture disabled until rebuilt.
        await recordCaptureGap(env.BADIZO_RUNTIME_BINDING,binding);
        return runtime;
      }
    } catch (error) { failure = error; }
  }

  function verifyAuthority() {
    const current = bindingService.read(env);
    if (env.BADIZO_NODE_ROLE !== 'local-server' || !env.BADIZO_SHOP_ID || bindingService.status()?.activationId !== binding.activationId ||
        current?.activationId !== binding.activationId || current.shopId !== env.BADIZO_SHOP_ID ||
        current.generation !== binding.generation || current.phase !== 'active' || current.billingMode !== 'active' ||
        current.handoffId || current.database.database !== env.DB_NAME || current.database.host !== env.DB_HOST) throw failure;
  }
  verifyAuthority();
  if (env.BADIZO_RECOVERY_CONTROL_CONFIG) {
    const control = require('./recoveryControl').createRecoveryControl({configPath:env.BADIZO_RECOVERY_CONTROL_CONFIG, shopId:env.BADIZO_SHOP_ID});
    const state = await control.status();
    if (state.nodeRole !== 'local-server' || state.phase !== 'active' || state.billingMode !== 'active' ||
        state.generation !== binding.generation || state.baseline?.held ||
        state.baseline?.state === 'configuration-needs-inspection' || state.preparation?.state === 'configuration-needs-inspection' ||
        state.handoffId || (state.operation && !['failed','complete','rolled-back'].includes(state.operation.state))) throw failure;
  }
  const [[database]] = await pool.query('SELECT DATABASE() AS name');
  if (database.name !== binding.database.database) throw failure;
  await recordCaptureGap(env.BADIZO_RUNTIME_BINDING, binding);
  verifyAuthority();
  disableCapture(env);
  onFailure(failure);
  return degradedRuntime();
}

module.exports = {protectedEnrollment};
