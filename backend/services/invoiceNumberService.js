const db = require('../config/db');
const { normalizeCounterNo } = require('../utils/formatters');

async function getCounterCount(connection = db) {
  const [rows] = await connection.query(
    `SELECT setting_value FROM app_settings WHERE setting_key = 'counter_count' LIMIT 1`
  );
  const counterCount = Number.parseInt(rows[0]?.setting_value, 10) || 6;
  return Math.min(Math.max(counterCount, 1), 99);
}

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
}

function formatInvoiceNo(financialYear, counterNo, sequenceNo) {
  return `BZ/${financialYear}/C${String(counterNo).padStart(2, '0')}/${String(sequenceNo).padStart(6, '0')}`;
}

async function getExistingMaxSequence(connection, financialYear) {
  const [sequenceRows] = await connection.query(
    `SELECT MAX(next_number) AS next_number
     FROM invoice_sequences
     WHERE financial_year = ?`,
    [financialYear]
  );
  const [invoiceRows] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED)) AS sequence_no
     FROM invoices
     WHERE invoice_no LIKE ?`,
    [`BZ/${financialYear}/C%/%`]
  );
  const sequenceNext = Number(sequenceRows[0]?.next_number || 1);
  const invoiceNext = Number(invoiceRows[0]?.sequence_no || 0) + 1;
  return Math.max(sequenceNext, invoiceNext, 1);
}

async function ensureSequenceRow(connection, financialYear, counterNo = 0) {
  if (Number(counterNo) === 0) {
    const nextNumber = await getExistingMaxSequence(connection, financialYear);
    await connection.query(
      `INSERT INTO invoice_sequences (financial_year, counter_no, next_number)
       VALUES (?, 0, ?)
       ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number))`,
      [financialYear, nextNumber]
    );
    return;
  }

  await connection.query(
    `INSERT IGNORE INTO invoice_sequences (financial_year, counter_no, next_number)
     VALUES (?, ?, 1)`,
    [financialYear, counterNo]
  );
}

async function allocateInvoiceNo(connection, counterNo) {
  const financialYear = getFinancialYear();
  await ensureSequenceRow(connection, financialYear, 0);

  const [rows] = await connection.query(
    `SELECT next_number
     FROM invoice_sequences
     WHERE financial_year = ? AND counter_no = 0
     FOR UPDATE`,
    [financialYear]
  );

  const sequenceNo = Number(rows[0]?.next_number || 1);
  await connection.query(
    `UPDATE invoice_sequences
     SET next_number = next_number + 1
     WHERE financial_year = ? AND counter_no = 0`,
    [financialYear]
  );

  return {
    invoiceNo: formatInvoiceNo(financialYear, counterNo, sequenceNo),
    financialYear,
    sequenceNo
  };
}

module.exports = {
  allocateInvoiceNo,
  ensureSequenceRow,
  formatInvoiceNo,
  getCounterCount,
  getFinancialYear,
  normalizeCounterNo
};
