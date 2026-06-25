const { normalizePhone } = require('../utils/formatters');
const { logError, logInfo } = require('./logger');

function whatsappEnabled() {
  return String(process.env.BADIZO_WHATSAPP_ENABLED || '').toLowerCase() === 'true';
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function replacePlaceholders(template, values) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])
  ));
}

function buildBillWhatsAppMessage({
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

  const template = process.env.BADIZO_WHATSAPP_BILL_TEMPLATE
    || 'Thank you {customerName}. Bill {invoiceNo}: Rs.{grandTotal} paid by {paymentMode}. Loyalty earned {pointsEarned}, balance {pointsBalance}. - Badizo';
  return replacePlaceholders(template, values).replace(/\s+/g, ' ').trim();
}

function buildMetaTemplatePayload({ to, details }) {
  const templateName = String(process.env.BADIZO_WHATSAPP_TEMPLATE_NAME || '').trim();
  if (!templateName) return null;

  const languageCode = String(process.env.BADIZO_WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim();
  const values = [
    details.customerName || 'Customer',
    details.invoiceNo || '',
    formatMoney(details.grandTotal),
    details.paymentMode || 'Cash',
    String(Number(details.loyalty?.points || 0)),
    String(Number(details.loyalty?.balance || 0))
  ];

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [{
        type: 'body',
        parameters: values.map((text) => ({ type: 'text', text }))
      }]
    }
  };
}

async function sendMetaWhatsApp({ to, message, details, timeoutMs }) {
  const phoneNumberId = String(process.env.BADIZO_WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const token = String(process.env.BADIZO_WHATSAPP_TOKEN || '').trim();
  if (!phoneNumberId || !token) {
    return { sent: false, skipped: true, reason: 'WhatsApp Meta credentials missing' };
  }

  const payload = buildMetaTemplatePayload({ to, details }) || {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: message }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`WhatsApp API returned ${response.status}: ${responseText.slice(0, 200)}`);
    }
    return { sent: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendGenericWhatsApp({ to, message, timeoutMs }) {
  const apiUrl = String(process.env.BADIZO_WHATSAPP_API_URL || '').trim();
  if (!apiUrl) return { sent: false, skipped: true, reason: 'WhatsApp API URL missing' };

  const method = String(process.env.BADIZO_WHATSAPP_METHOD || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const toParam = process.env.BADIZO_WHATSAPP_TO_PARAM || 'to';
  const messageParam = process.env.BADIZO_WHATSAPP_MESSAGE_PARAM || 'message';
  const headers = {};
  if (process.env.BADIZO_WHATSAPP_AUTH_TOKEN) {
    headers[process.env.BADIZO_WHATSAPP_AUTH_HEADER || 'Authorization'] = process.env.BADIZO_WHATSAPP_AUTH_TOKEN;
  }

  const payload = { [toParam]: to, [messageParam]: message };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
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
    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`WhatsApp gateway returned ${response.status}: ${responseText.slice(0, 200)}`);
    }
    return { sent: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendBillWhatsApp(details) {
  const to = `91${normalizePhone(details.phone)}`;
  if (!whatsappEnabled()) return { sent: false, skipped: true, reason: 'WhatsApp disabled' };
  if (!to || to.length !== 12) return { sent: false, skipped: true, reason: 'Invalid WhatsApp number' };

  const message = buildBillWhatsAppMessage(details);
  const timeoutMs = Math.max(Number(process.env.BADIZO_WHATSAPP_TIMEOUT_MS || 5000), 1000);
  const provider = String(process.env.BADIZO_WHATSAPP_PROVIDER || 'meta').toLowerCase();

  try {
    const result = provider === 'generic'
      ? await sendGenericWhatsApp({ to, message, timeoutMs })
      : await sendMetaWhatsApp({ to, message, details, timeoutMs });
    if (result.sent) logInfo('Bill WhatsApp sent', { phone: to, provider });
    return result;
  } catch (err) {
    logError('Bill WhatsApp failed', err, { phone: to, provider });
    return { sent: false, error: err.message };
  }
}

module.exports = {
  buildBillWhatsAppMessage,
  sendBillWhatsApp,
  whatsappEnabled
};
