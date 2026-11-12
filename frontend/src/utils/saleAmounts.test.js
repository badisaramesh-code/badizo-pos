import { calculateSaleAmounts } from './saleAmounts';

const calculate = items => calculateSaleAmounts(items, item => Number(item.sale_price));

test('mixed GST bill at a half rupee uses selling prices rather than recombined tax subtotals', () => {
  const result = calculate([
    { sale_price: 1, quantity: 1, gst_percent: 5 },
    { sale_price: 38.5, quantity: 1, gst_percent: 18 }
  ]);
  // This is the old calculation: it rounded the same bill down to Rs.39.
  expect(Math.round(result.taxable + result.tax)).toBe(39);
  expect(result.saleGrand).toBe(39.5);
  expect(Math.round(result.saleGrand)).toBe(40);
});

test('Counter 2 seven-line cart agrees with the server merchandise total', () => {
  const amounts = calculate([
    [380, 1, 5], [280, 1, 5], [280, 1, 18], [280, 1, 5],
    [22.5, 1, 18], [32, 1, 0], [90, 2, 5]
  ].map(([sale_price, quantity, gst_percent]) => ({ sale_price, quantity, gst_percent })));
  expect(amounts.saleGrand).toBe(1454.5);
  expect(Math.round(amounts.saleGrand)).toBe(1455);
  expect(amounts.taxable + amounts.tax).toBeCloseTo(amounts.saleGrand, 8);
});

test('fractional quantities and quantity-price discounts retain their line totals', () => {
  const items = [{ quantity: 0.25, mrp: 100, gst_percent: 5 }, { quantity: 3, mrp: 10, gst_percent: 0 }];
  const result = calculateSaleAmounts(items, item => item.quantity >= 3 ? 8 : 80);
  expect(result.saleGrand).toBe(44);
  expect(result.discount).toBe(11);
});
