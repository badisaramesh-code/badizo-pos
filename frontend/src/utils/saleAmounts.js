import { lineUnits, rupees } from './checkoutAmounts';
import { toNumber } from './money';

// GST is a split of the selling price, not a second source for the payable
// amount. Recombining floating-point tax subtotals can turn 39.50 into
// 39.49999999999999 and round a bill down by one rupee.
export function calculateSaleAmounts(items, priceForItem) {
  let saleUnits = 0;
  let taxable = 0;
  let tax = 0;
  let discount = 0;
  for (const item of items) {
    const quantity = toNumber(item.quantity, 1);
    const unitPrice = priceForItem(item);
    const lineTotal = unitPrice * quantity;
    const gstPercent = toNumber(item.gst_percent);
    const rowTax = lineTotal * (gstPercent / (100 + gstPercent));
    saleUnits += lineUnits(unitPrice, quantity);
    taxable += lineTotal - rowTax;
    tax += rowTax;
    discount += Math.max(toNumber(item.mrp) - unitPrice, 0) * quantity;
  }
  return { saleGrand: rupees(saleUnits), taxable, tax, discount };
}
