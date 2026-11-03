export function shouldRecoverCheckout(error) {
  const status = Number(error?.response?.status);
  const message = String(error?.response?.data?.error || '');
  // The current server returns HTTP 500 for price validation, which happens
  // before an invoice is allocated or committed.
  if (/^Rate updated for .+: current rate Rs\./.test(message)) return false;
  if (status >= 400 && status < 500 && status !== 408) return false;
  return true;
}
