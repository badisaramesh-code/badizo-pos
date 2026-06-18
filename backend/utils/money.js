const { parseMoney } = require('./formatters');

function moneyToPaise(value) {
  return Math.round(parseMoney(value) * 100);
}

function paiseToMoney(value) {
  return value / 100;
}

function parseCurrency(value) {
  return paiseToMoney(moneyToPaise(value));
}

function sumMoneyToPaise(values) {
  return values.reduce((total, value) => total + moneyToPaise(value), 0);
}

module.exports = {
  moneyToPaise,
  paiseToMoney,
  parseCurrency,
  sumMoneyToPaise
};
