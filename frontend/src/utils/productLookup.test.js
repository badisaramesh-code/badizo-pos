import { findExactSaleProduct } from './productLookup';

describe('findExactSaleProduct', () => {
  test('prefers Code128 when another product has the same product code', () => {
    const productCodeMatch = { barcode: '890100000001', product_code: '700054' };
    const code128Match = { barcode: '700054', product_code: 'P-2' };
    expect(findExactSaleProduct([productCodeMatch, code128Match], '700054')).toBe(code128Match);
  });

  test('falls back to product code only when no Code128 matches', () => {
    const productCodeMatch = { barcode: '890100000001', product_code: '700054' };
    expect(findExactSaleProduct([productCodeMatch], '700054')).toBe(productCodeMatch);
  });

  test('returns null when neither value matches', () => {
    expect(findExactSaleProduct([{ barcode: '890100000001', product_code: 'P-1' }], '700054')).toBeNull();
  });
});