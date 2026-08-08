const { getFinancialYear } = require('./financialYearService');

function formatInwardNo(financialYear, sequenceNo) {
  return `INW/${financialYear}/${String(sequenceNo).padStart(6, '0')}`;
}

async function getExistingMaxSequence(connection, financialYear) {
  const [sequenceRows] = await connection.query(
    `SELECT MAX(next_number) AS next_number
     FROM inward_sequences
     WHERE financial_year = ?`,
    [financialYear]
  );
  const [inwardRows] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(inward_no, '/', -1) AS UNSIGNED)) AS sequence_no
     FROM inward_entries
     WHERE inward_no LIKE ?`,
    [`INW/${financialYear}/%`]
  );
  const sequenceNext = Number(sequenceRows[0]?.next_number || 1);
  const inwardNext = Number(inwardRows[0]?.sequence_no || 0) + 1;
  return Math.max(sequenceNext, inwardNext, 1);
}

async function ensureInwardSequenceRow(connection, financialYear) {
  const nextNumber = await getExistingMaxSequence(connection, financialYear);
  await connection.query(
    `INSERT INTO inward_sequences (financial_year, next_number)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number))`,
    [financialYear, nextNumber]
  );
}

async function allocateInwardNo(connection, date = new Date()) {
  const financialYear = getFinancialYear(date);
  await ensureInwardSequenceRow(connection, financialYear);

  const [rows] = await connection.query(
    `SELECT next_number
     FROM inward_sequences
     WHERE financial_year = ?
     FOR UPDATE`,
    [financialYear]
  );

  const sequenceNo = Number(rows[0]?.next_number || 1);
  await connection.query(
    `UPDATE inward_sequences
     SET next_number = next_number + 1
     WHERE financial_year = ?`,
    [financialYear]
  );

  return {
    inwardNo: formatInwardNo(financialYear, sequenceNo),
    financialYear,
    sequenceNo
  };
}

module.exports = {
  allocateInwardNo,
  ensureInwardSequenceRow,
  formatInwardNo
};
