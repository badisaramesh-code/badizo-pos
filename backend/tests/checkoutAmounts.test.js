const test = require('node:test');
const assert = require('node:assert/strict');
const counter = require('../../frontend/src/utils/checkoutAmounts');
const server = require('../utils/checkoutAmounts');

test('counter and server match independent integer expectations across decimal billing boundaries', () => {
  for (const pricePaise of [0, 1, 19, 101, 1070, 3899, 55000]) {
    for (const thousandths of [1, 125, 500, 1000, 3000, 6000, 12000]) {
      for (const count of [1, 10, 99]) {
        for (const exchangeUnits of [0, 267500, 999999]) {
          for (const points of [0, 1, 9, 31]) {
            const units = pricePaise * thousandths;
            // Ten points redeem fifty paise, capped at the payable amount.
            const net = Math.max(0, units * count - exchangeUnits);
            const expected = Math.floor((Math.max(0, net - points * 5000) + 50000) / 100000);
            for (const math of [counter, server]) {
              assert.equal(math.lineUnits(pricePaise / 100, thousandths / 1000), units);
              const amount = math.rupees(units * count) - math.rupees(exchangeUnits);
              assert.equal(math.roundedPayable(amount, points * 0.05), expected);
            }
          }
        }
      }
    }
  }
});
