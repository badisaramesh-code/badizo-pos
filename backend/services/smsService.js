const { normalizePhone } = require('../utils/formatters');
const { logError, logInfo } = require('./logger');

function smsEnabled() {
  return String(process.env.BADIZO_SMS_ENABLED || '').toLowerCase() === 'true';
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function replacePlaceholders(template, values) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])
  ));
}

function buildBillSmsMessage({
  invoiceNo,
  customerName,
  grandTotal,
  paymentMode,
  itemCount,
  loyalty
}) {
  const values = {
    invoiceNo,
    customerName: customerName || 'Customer',
    grandTotal: formatMoney(grandTotal),
    paymentMode: paymentMode || 'Cash',
    itemCount: Number(itemCount || 0),
    pointsEarned: Number(loyalty?.points || 0),
    pointsBalance: Number(loyalty?.balance || 0)
  };

  const template = process.env.BADIZO_SMS_BILL_TEMPLATE
    || 'Thank you {customerName}. Bill {invoiceNo}: Rs.{grandTotal} paid by {paymentMode}. Loyalty earned {pointsEarned}, balance {pointsBalance}. - Badizo';
  return replacePlaceholders(template, values).replace(/\s+/g, ' ').trim();
}

async function sendSms({ phone, message }) {
  const to = normalizePhone(phone);
  if (!smsEnabled()) return { sent: false, skipped: true, reason: 'SMS disabled' };
  if (!to || to.length !== 10) return { sent: false, skipped: true, reason: 'Invalid phone number' };

  const apiUrl = String(process.env.BADIZO_SMS_API_URL || '').trim();
  if (!apiUrl) return { sent: false, skipped: true, reason: 'SMS API URL missing' };

  const method = String(process.env.BADIZO_SMS_METHOD || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const toParam = process.env.BADIZO_SMS_TO_PARAM || 'to';
  const messageParam = process.env.BADIZO_SMS_MESSAGE_PARAM || 'message';
  const senderParam = process.env.BADIZO_SMS_SENDER_PARAM || 'sender';
  const senderId = String(process.env.BADIZO_SMS_SENDER_ID || '').trim();
  const timeoutMs = Math.max(Number(process.env.BADIZO_SMS_TIMEOUT_MS || 5000), 1000);
  const headers = {};

  if (process.env.BADIZO_SMS_AUTH_TOKEN) {
    headers[process.env.BADIZO_SMS_AUTH_HEADER || 'Authorization'] = process.env.BADIZO_SMS_AUTH_TOKEN;
  }

  const payload = {
    [toParam]: to,
    [messageParam]: message
  };
  if (senderId && senderParam) payload[senderParam] = senderId;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      if (method === 'GET') {
        const url = new URL(apiUrl);
        Object.entries(payload).forEach(([key, value]) => url.searchParams.set(key, value));
        response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      } else {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`SMS API returned ${response.status}: ${responseText.slice(0, 200)}`);
    }

    logInfo('Bill SMS sent', { phone: to, status: response.status });
    return { sent: true, status: response.status };
  } catch (err) {
    logError('Bill SMS failed', err, { phone: to });
    return { sent: false, error: err.message };
  }
}

async function sendBillSms(details) {
  const message = buildBillSmsMessage(details);
  return sendSms({ phone: details.phone, message });
}

module.exports = {
  buildBillSmsMessage,
  sendBillSms,
  sendSms,
  smsEnabled
};
