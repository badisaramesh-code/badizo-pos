const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moneyToPaise,
  paiseToMoney,
  parseCurrency,
  sumMoneyToPaise
} = require('../utils/money');

test('moneyToPaise rounds currency values to whole paise', () => {
  assert.equal(moneyToPaise(10), 1000);
  assert.equal(moneyToPaise('10.25'), 1025);
  assert.equal(moneyToPaise('10.255'), 1026);
  assert.equal(moneyToPaise(''), 0);
  assert.equal(moneyToPaise(null), 0);
});

test('paiseToMoney converts integer paise back to rupees', () => {
  assert.equal(paiseToMoney(0), 0);
  assert.equal(paiseToMoney(1250), 12.5);
});

test('parseCurrency normalizes unsafe decimal values', () => {
  assert.equal(parseCurrency('99.999'), 100);
  assert.equal(parseCurrency('abc'), 0);
});

test('sumMoneyToPaise avoids floating point addition drift', () => {
  assert.equal(sumMoneyToPaise([0.1, 0.2, '0.3']), 60);
});
