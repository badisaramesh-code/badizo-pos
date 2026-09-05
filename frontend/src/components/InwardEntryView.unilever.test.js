import {
  isExactImportedProductMatch,
  parseInvoiceRows
} from './InwardEntryView';

const HUL_FIXTURE = `
VINAYAKA AGENCIES
HUL Code : HUL-440738D-P514
Base Sch Taxable GST CGST S/UTGST
SL HSN No Product Name UPC MRP CS Pcs Batch EXP RS Disc Net Amt
Rate Disc Amt % Amt Amt
1 19019090 BOOST 500G*30 CS POUCH(With Free Product) 2+2 0+0 11845.20
19019090 BOOST 500G*30 CS POUCH 30 225.00 2 0 NA 0627 198.41 59.52 0.00 11845.20 5 296.13 296.13 12437.46
22029930 BOOST RTD 180ML TETRAPACK CLASSIC 30 40.00 2 0 NA 1126 0.00 0.00 0.00 0.00 0 0.00 0.00 0.00
2 19019090 BOOST SE 500G ICON JAR 24 250.00 1 0 NA 0227 220.46 26.45 0.00 5264.56 5 131.61 131.61 5527.79
60 BTPR-Buy Knorr Oriental Sauces 85g packs get 8% BTPR for All India - All Channel - MOC 05 2026 44991695 -11.01
`;

describe('HUL/Vinayaka inward invoice format', () => {
  test('has priority and preserves exact invoice quantities and amounts', () => {
    const rows = parseInvoiceRows(HUL_FIXTURE);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      barcode: '',
      product: 'BOOST 500G*30 CS POUCH',
      hsn_code: '19019090',
      qty: '60',
      purchase_unit_size: '30',
      stock_conversion_factor: '1',
      price: '198.41',
      scheme: '59.52',
      discount: '0.00',
      gst_percent: '5',
      taxable_amount: '11845.20',
      total_amount: '12437.46'
    });
    expect(rows[1]).toMatchObject({
      barcode: '',
      product: 'BOOST RTD 180ML TETRAPACK CLASSIC',
      qty: '60',
      price: '0.00',
      total_amount: '0.00'
    });
    expect(rows[2]).toMatchObject({
      product: 'BOOST SE 500G ICON JAR',
      qty: '24',
      purchase_unit_size: '24'
    });
    expect(rows[3]).toMatchObject({
      is_adjustment: true,
      total_amount: '-11.01'
    });
  });

  test('never maps an imported invoice row to a fuzzy unrelated product', () => {
    const invoiceLine = { barcode: '', product: 'BOOST 500G*30 CS POUCH' };

    expect(isExactImportedProductMatch(invoiceLine, {
      barcode: '117202',
      product_name: 'BEAUTY GIRL ITEMS'
    })).toBe(false);
    expect(isExactImportedProductMatch(invoiceLine, {
      barcode: '123456',
      product_name: 'BOOST 500G*30 CS POUCH'
    })).toBe(true);
  });
});
