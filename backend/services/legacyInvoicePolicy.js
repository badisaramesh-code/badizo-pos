'use strict';
const { isCloudNode } = require('./runtimePolicy');

// Explicit compatibility mode for existing local shops. Recovery and cloud
// billing always retain their distinct namespaces from runtimePolicy.
function legacyInvoicePolicy(env = process.env) {
  if (!env.BADIZO_LEGACY_INVOICE_PREFIX || isCloudNode(env) || env.BADIZO_RECOVERY_INVOICE_EPOCH) return null;
  const prefix = String(env.BADIZO_LEGACY_INVOICE_PREFIX);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/.test(prefix)) throw Error('Invalid legacy invoice prefix.');
  const startYear = env.BADIZO_LEGACY_INVOICE_START_YEAR || '';
  const startNumber = Number(env.BADIZO_LEGACY_INVOICE_START_NUMBER || 1);
  if ((startYear && !/^\d{2}-\d{2}$/.test(startYear)) || !Number.isSafeInteger(startNumber) || startNumber < 1 || startNumber > 999999999) throw Error('Invalid legacy invoice starting sequence.');
  if (startNumber !== 1 && !startYear) throw Error('Legacy invoice starting sequence requires a financial year.');
  return { prefix, startYear, startNumber };
}
module.exports = { legacyInvoicePolicy };
