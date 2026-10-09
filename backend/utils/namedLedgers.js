// Shared classification for the report and details-only edits.
const NAMED_LEDGER_QUERY = `SELECT cle.id,
              DATE_FORMAT(cle.entry_date, '%Y-%m-%d') AS entry_date,
              cle.counter_no,
              CONCAT('C', cle.counter_no) AS counter_label,
              cle.source_id,
              chs.sheet_no,
              CASE
                WHEN cle.named_ledger_account IS NOT NULL THEN cle.named_ledger_account
                WHEN cle.source_type = 'NAMED_LEDGER_MANUAL' THEN UPPER(TRIM(cle.account_name))
                WHEN account_counts.entry_count >= 2
                  THEN UPPER(TRIM(CASE WHEN cle.account_name LIKE 'Expense - %' THEN SUBSTRING(cle.account_name, 11) ELSE cle.account_name END))
                ELSE 'GENERAL'
              END AS account_name,
              UPPER(TRIM(CASE WHEN cle.account_name LIKE 'Expense - %' THEN SUBSTRING(cle.account_name, 11) ELSE cle.account_name END)) AS source_account_name,
              cle.details,
              cle.named_ledger_details,
              cle.remarks,
              cle.direction,
              cle.amount,
              cle.created_by,
              DATE_FORMAT(cle.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM counter_cash_ledger_entries cle
       LEFT JOIN counter_handover_sheets chs ON chs.id = cle.source_id
       LEFT JOIN (
         SELECT UPPER(TRIM(CASE WHEN account_name LIKE 'Expense - %' THEN SUBSTRING(account_name, 11) ELSE account_name END)) AS normalized_name,
                COUNT(*) AS entry_count
         FROM counter_cash_ledger_entries
         WHERE source_type = 'COUNTER_HANDOVER'
           AND payment_mode NOT IN ('CLOSING_BASE', 'SALES', 'CASH_NOTES')
           AND entry_date <= ?
         GROUP BY UPPER(TRIM(CASE WHEN account_name LIKE 'Expense - %' THEN SUBSTRING(account_name, 11) ELSE account_name END))
       ) account_counts ON account_counts.normalized_name = UPPER(TRIM(CASE WHEN cle.account_name LIKE 'Expense - %' THEN SUBSTRING(cle.account_name, 11) ELSE cle.account_name END))
       WHERE ((cle.source_type = 'COUNTER_HANDOVER'
               AND cle.payment_mode NOT IN ('CLOSING_BASE', 'SALES', 'CASH_NOTES'))
              OR cle.source_type = 'NAMED_LEDGER_MANUAL')
         AND cle.entry_date <= ?
       ORDER BY account_name ASC, cle.entry_date ASC, cle.created_at ASC, cle.id ASC`;
async function fetchNamedLedgers(connection, to) {
  const [rows] = await connection.query(NAMED_LEDGER_QUERY, [to, to]);
  return rows;
}
function overrideKey(row) {
  return JSON.stringify([row.account_name, row.details, row.direction, String(row.amount), row.payment_mode]);
}
module.exports = { fetchNamedLedgers, overrideKey };
