import { parseInvoiceRows } from './InwardEntryView';

const invoiceText = `
RANDOM DISTRIBUTOR PRIVATE LIMITED
# Item Name UOM MRP Rate Qty GrossAmt Free Disc% Disc.Amt Other Disc Tot.Tax Amount
HSN | Qty in SUOM Taxable Amt CGST % CGST Amt SGST% SGST Amt
1 MD Cup Sambrani Rs. 72 (N)_12591 CFC 72.00 2331.43 1.00 2331.43 0.00 11.51 268.35 0.00 103.15 2166.23
33074100 |0.576000M_S 2063.08 2.50 51.58 2.50 51.58
2 MD TREYA CUP SAMBRANI 75_12730 PAC 75.00 60.19 24.00 1444.51 0.00 11.51 166.26 0.00 63.91 1342.16
33074100 |0.216000M_S 1278.25 2.50 31.96 2.50 31.96
15 NIMYLE FC HERBAL 500ML_PNMFC0149 CFC 95.00 2529.35 1.00 2529.35 0.00 0.00 0.00 0.00 455.28 2984.63
38089400 |18.000000L 2529.35 9.00 227.64 9.00 227.64
17 SAVLON HANDWASH MS 80ML_PSVHW04P3A7C PAC 30.00 22.42 36.00 807.09 0.00 2.53 20.42 0.00 141.60 928.27
34025000 |2.880000L 786.67 9.00 70.80 9.00 70.80
Round Off Amt : 0.01
Net Amt Payable : 7421.30
`;

test('parses supplier-independent two-line tax invoice format', () => {
  const rows = parseInvoiceRows(invoiceText);
  expect(rows).toHaveLength(5);
  expect(rows[0]).toMatchObject({
    barcode: '',
    product: 'MD CUP SAMBRANI RS. 72 (N)',
    hsn_code: '33074100',
    mrp: '72.00',
    price: '2331.43',
    qty: '1.00',
    free: '0.00',
    discount_type: 'PERCENT',
    discount: '11.51',
    gst_percent: '5',
    total_amount: '2166.23',
    supplier_product_code: '12591',
    secondary_quantity: '0.576000',
    secondary_unit: 'M_S'
  });
  expect(rows[2]).toMatchObject({ product: 'NIMYLE FC HERBAL 500ML', gst_percent: '18', total_amount: '2984.63' });
  expect(rows.at(-1)).toMatchObject({ is_adjustment: true, price: '0.01', total_amount: '0.01' });
  expect(rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)).toBeCloseTo(7421.30, 2);
});