// Catalog rates have two decimal places and weighed quantities can have three.
// Sum in hundred-thousandths of a rupee so repeated lines cannot drift across a rounding boundary.
function lineUnits(rate, quantity) {
  return Math.round(Number(rate) * Number(quantity) * 100000);
}

function rupees(units) {
  return units / 100000;
}

function roundedPayable(net, redeemed) {
  // Loyalty conversion may divide points by a non-integral redemption ratio.
  const payable = Math.max(net - redeemed, 0);
  return Math.round(Number(payable.toFixed(9)));
}

module.exports = { lineUnits, rupees, roundedPayable };
