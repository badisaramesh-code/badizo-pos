const parties = new Map([
  ['CLOSING_CUSTOMER', 'Customer'],
  ['CLOSING_LOCAL', 'Local vendor'],
  ['CLOSING_NON_LOCAL', 'Non-Local vendor']
]);

function closingParty(row) {
  if (row.source_type !== 'COUNTER_HANDOVER') return undefined;
  return parties.get(row.payment_mode);
}

function partyName(row) {
  const name = String(row.account_name).trim();
  const kind = closingParty(row);
  return kind && kind !== 'Customer' ? name + ' (' + kind + ')' : name;
}

// Day sheet balances carry forward through the report end date. Current-period
// customer movements are already in the debtor book; add only their opening balance.
function daySheetBalances(rows, debtorBalances) {
  const balances = new Map();
  for (const [name, value] of Object.entries(debtorBalances)) {
    const key = 'Customer:' + name.trim().toUpperCase();
    const previous = balances.get(key);
    balances.set(key, { name: previous?.name || name, cents: (previous?.cents || 0) + Math.round(value * 100) });
  }
  for (const row of rows) {
    const kind = closingParty(row);
    if (!kind) continue;
    const key = kind + ':' + row.account_name.trim().toUpperCase();
    const account = balances.get(key) || { name: partyName(row), cents: 0 };
    account.cents += Math.round(Number(kind === 'Customer' ? row.opening_balance : row.net_balance) * 100);
    account.daySheet = kind;
    balances.set(key, account);
  }
  return [...balances.values()];
}

module.exports = { closingParty, partyName, daySheetBalances };
