const test = require('node:test');
const assert = require('node:assert/strict');
const { daySheetBalances } = require('../utils/daySheetBalances');

function row(kind, opening, net) {
  return { source_type: 'COUNTER_HANDOVER', payment_mode: 'CLOSING_' + kind,
    account_name: 'Lankapalli', opening_balance: opening, net_balance: net };
}

test('closing balances distinguish same-name customer and vendors, including overpayments', () => {
  const result = daySheetBalances([
    row('CUSTOMER', 200, -10), row('LOCAL', -500, -300), row('NON_LOCAL', 0, 40)
  ], { Lankapalli: -210 });
  assert.deepEqual(result.map(r => [r.name, r.cents]), [
    ['Lankapalli', -1000], ['Lankapalli (Local vendor)', -30000], ['Lankapalli (Non-Local vendor)', 4000]
  ]);
});

test('opening balance carries forward, partial customer receipt applies once and fully paid vendor has zero due', () => {
  const amounts = daySheetBalances([row('CUSTOMER', 100, 59.99), row('LOCAL', -95, 0)], { LANKAPALLI: -40.01 });
  assert.deepEqual(amounts.map(r => r.cents), [5999, 0]);
});
