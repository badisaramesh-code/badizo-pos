'use strict';

// Only restored, epoch-bound runtimes opt in. Ordinary installations keep their
// existing sessions and checkout behavior.
function currentRecoveryActivation(env = process.env) {
  if (!env.BADIZO_RECOVERY_INVOICE_EPOCH) return null;
  const binding = require('./recoveryRuntimeBinding').read(env);
  if (!binding || binding.invoiceEpoch !== env.BADIZO_RECOVERY_INVOICE_EPOCH) throw Error('Recovery authority changed; restart verification is required.');
  return binding.activationId;
}
function checkCheckoutScope(body, env = process.env) {
  const activation = currentRecoveryActivation(env);
  if (!activation || body?.recovery_activation_id === activation) return;
  const error = Error('This pending bill belongs to the database before recovery. Keep it for owner review; do not automatically replay or replace it.');
  error.status = 409; error.code = 'RECOVERY_CHECKOUT_REVIEW_REQUIRED'; throw error;
}
module.exports = { currentRecoveryActivation, checkCheckoutScope };
