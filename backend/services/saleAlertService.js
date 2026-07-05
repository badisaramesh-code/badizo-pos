const db = require('../config/db');
const { logError, logInfo } = require('./logger');
const { sendSms, smsEnabled } = require('./smsService');
const { sendWhatsApp, whatsappEnabled } = require('./whatsappService');

const ALERT_TIME = '09:00';

function pad(value) {
  return String(value).padStart(2, '0');
}

function toSqlDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDisplayDate(date) {
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function previousDate(base = new Date()) {
  const date = new Date(base);
  date.setDate(date.getDate() - 1);
  return date;
}

function previousMonthRange(base = new Date()) {
  const firstOfThisMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  const from = new Date(firstOfThisMonth);
  from.setMonth(from.getMonth() - 1);
  const to = new Date(firstOfThisMonth);
  to.setDate(0);
  return { from, to };
}

async function getAlertPhone() {
  const [rows] = await db.query(
    `SELECT setting_key, setting_value
     FROM app_settings
     WHERE setting_key IN ('login_logout_alert_phone', 'phone')`
  );
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  return String(settings.login_logout_alert_phone || settings.phone || '').trim();
}

async function getSaleSummary(fromDate, toDate) {
  const [rows] = await db.query(
    `SELECT
       COALESCE(NULLIF(billing_counter, ''), 'Counter 1') AS counter_name,
       COUNT(*) AS bill_count,
       COALESCE(SUM(grand_total), 0) AS sale_total,
       COALESCE(SUM(CASE WHEN payment_mode = 'Cash' THEN grand_total ELSE 0 END), 0) AS cash_total,
       COALESCE(SUM(CASE WHEN payment_mode = 'UPI' THEN grand_total ELSE 0 END), 0) AS upi_total,
       COALESCE(SUM(CASE WHEN payment_mode = 'Card' THEN grand_total ELSE 0 END), 0) AS card_total,
       COALESCE(SUM(CASE WHEN payment_mode = 'Mixed' THEN grand_total ELSE 0 END), 0) AS mixed_total
     FROM invoices
     WHERE DATE(created_at) BETWEEN ? AND ?
       AND invoice_status <> 'CANCELLED'
     GROUP BY COALESCE(NULLIF(billing_counter, ''), 'Counter 1')
     ORDER BY counter_name`,
    [fromDate, toDate]
  );

  const counters = rows.map((row) => ({
    counterName: row.counter_name,
    billCount: Number(row.bill_count || 0),
    saleTotal: Number(row.sale_total || 0),
    cashTotal: Number(row.cash_total || 0),
    upiTotal: Number(row.upi_total || 0),
    cardTotal: Number(row.card_total || 0),
    mixedTotal: Number(row.mixed_total || 0)
  }));

  return counters.reduce((summary, counter) => ({
    billCount: summary.billCount + counter.billCount,
    saleTotal: summary.saleTotal + counter.saleTotal,
    cashTotal: summary.cashTotal + counter.cashTotal,
    upiTotal: summary.upiTotal + counter.upiTotal,
    cardTotal: summary.cardTotal + counter.cardTotal,
    mixedTotal: summary.mixedTotal + counter.mixedTotal,
    counters
  }), {
    billCount: 0,
    saleTotal: 0,
    cashTotal: 0,
    upiTotal: 0,
    cardTotal: 0,
    mixedTotal: 0,
    counters
  });
}

function buildSaleAlertMessage({ title, fromDate, toDate, summary }) {
  const rangeText = fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;
  const counterText = summary.counters.length
    ? summary.counters.map((counter) => `${counter.counterName}: Rs.${money(counter.saleTotal)} (${counter.billCount})`).join('; ')
    : 'No counter sales';

  return [
    `Badizo POS ${title}`,
    rangeText,
    `All counters sale: Rs.${money(summary.saleTotal)}`,
    `Bills: ${summary.billCount}`,
    `Cash Rs.${money(summary.cashTotal)}, UPI Rs.${money(summary.upiTotal)}, Card Rs.${money(summary.cardTotal)}, Mixed Rs.${money(summary.mixedTotal)}`,
    counterText
  ].join(' | ');
}

async function sendStoreSaleAlert({ title, fromDate, toDate }) {
  const phone = await getAlertPhone();
  if (!phone) {
    logInfo('Store sale alert skipped', { reason: 'Store alert phone missing', title, fromDate, toDate });
    return { sent: false, skipped: true, reason: 'Store alert phone missing' };
  }

  const summary = await getSaleSummary(fromDate, toDate);
  const message = buildSaleAlertMessage({ title, fromDate, toDate, summary });
  const smsResult = smsEnabled()
    ? await sendSms({ phone, message })
    : { sent: false, skipped: true, reason: 'SMS disabled' };
  const whatsappResult = whatsappEnabled()
    ? await sendWhatsApp({ phone, message })
    : { sent: false, skipped: true, reason: 'WhatsApp disabled' };

  logInfo('Store sale alert processed', {
    title,
    fromDate,
    toDate,
    billCount: summary.billCount,
    saleTotal: summary.saleTotal,
    sms: smsResult,
    whatsapp: whatsappResult
  });

  return { sms: smsResult, whatsapp: whatsappResult, summary };
}

async function sendYesterdaySaleAlert(base = new Date()) {
  const date = previousDate(base);
  const sqlDate = toSqlDate(date);
  return sendStoreSaleAlert({
    title: 'Yesterday Sale Alert',
    fromDate: sqlDate,
    toDate: sqlDate
  });
}

async function sendPreviousMonthSaleAlert(base = new Date()) {
  const { from, to } = previousMonthRange(base);
  return sendStoreSaleAlert({
    title: 'Monthly Sale Alert',
    fromDate: toSqlDate(from),
    toDate: toSqlDate(to)
  });
}

function scheduleDailySaleAlerts() {
  const scheduleNext = () => {
    const [hourText, minuteText] = ALERT_TIME.split(':');
    const hour = Number.parseInt(hourText, 10);
    const minute = Number.parseInt(minuteText, 10);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      const runDate = new Date();
      try {
        await sendYesterdaySaleAlert(runDate);
        if (runDate.getDate() === 1) {
          await sendPreviousMonthSaleAlert(runDate);
        }
      } catch (err) {
        logError('Store sale alert failed', err);
      } finally {
        scheduleNext();
      }
    }, delay);

    logInfo('Store sale alerts scheduled', {
      time: ALERT_TIME,
      nextRun: `${toDisplayDate(next)} ${ALERT_TIME}`
    });
    console.log(`Store sale alerts scheduled at ${ALERT_TIME}.`);
  };

  scheduleNext();
}

module.exports = {
  buildSaleAlertMessage,
  getSaleSummary,
  scheduleDailySaleAlerts,
  sendPreviousMonthSaleAlert,
  sendStoreSaleAlert,
  sendYesterdaySaleAlert
};
