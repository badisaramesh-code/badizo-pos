import { parseInvoiceRows } from './InwardEntryView';

const invoiceText = `
ANY SUPPLIER DISTRIBUTORS
HSN P/C PRODUCT DETAILS D.PRICE MRP Qty. Unit Price C.D GST % CGST SGST Amount
3402 20 YD SOFTOUCH - JSMNE - 210+210ML 99/- 1796.65 99.00 2.00 Case 1,522.59 0.00 18% 274.07 274.07 3,593.30
3402 20 YD SOFTOUCH - ROSE - 210+210ML 99/- 1796.65 99.00 2.00 Case 1,522.59 0.00 18% 274.07 274.07 3,593.30
3402 20 YD SOFTOUCH - LVDR - 210+210ML 99/- 1796.65 99.00 2.00 Case 1,522.59 0.00 18% 274.07 274.07 3,593.30
3401 24 STR GOLD - 125GR 3+1 199/- 4086.14 199.00 2.00 Case 3,891.56 0.00 5% 194.58 194.58 8,172.27
3808 4 CJ - MAX KLEEN - 1.8LTR B1G1 435/- 1550.18 435.00 1.00 Case 1,313.71 0.00 18% 118.23 118.23 1,550.18
3808 6 CJ CJ - MAX KLEEN - 1.25+1.25 354/- 1853.67 354.00 1.00 Case 1,570.91 0.00 18% 141.38 141.38 1,853.67
3808 6 FB - FB - MAX KLEEN - 1.25+1.25 354/- 1853.67 354.00 1.00 Case 1,570.91 0.00 18% 141.38 141.38 1,853.67
3808 6 2IN 1 - MAX KLEEN - 1.25+1.25 354/- 1853.67 354.00 1.00 Case 1,570.91 0.00 18% 141.38 141.38 1,853.67
3402 21 SOFTOUCH BLUE - 18ML 4/- 40PCS CL840P 3085.87 160.00 2.00 Case 2,615.14 0.00 18% 470.73 470.73 6,171.73
3402 21 SOFTOUCH BLACK - 18ML 4/- 40P CL21K 3085.87 160.00 2.00 Case 2,615.14 0.00 18% 470.73 470.73 6,171.73
3401 6 HYGIENIX - HW - 675ML+675ML 189/- 859.06 189.00 6.00 Case 728.01 0.00 18% 393.13 393.13 5,154.34
3401 168 STR WHITE- 100G 40/- B23G1 CDC18GR 5808.93 40.00 1.00 Case 5,532.31 0.00 5% 138.31 138.31 5,808.93
3401 90 STR WHITE - 43GR X 4set 40/- 3151.86 40.00 1.00 Case 3,001.77 0.00 5% 75.04 75.04 3,151.86
3401 24 STR HAND WASH CLC - 200+200ML 99/- 2159.99 99.00 2.00 Case 1,830.50 0.00 18% 329.49 329.49 4,319.97
3402 12 SW LD FRONT LOAD - 1LTR POUCH 115/- 106.48 115.00 50.00 Pcs. 90.24 0.00 18% 406.07 406.07 5,324.05
8539 60 WIPRO GARNET LED - 12W 70.00 550.00 50.00 Pcs. 59.32 0.00 18% 266.95 266.95 3,500.00
3401 24 SANTOOR - 125GR 4+1 209/- 4405.56 209.00 15.00 Case 4,195.77 0.00 5% 1573.41 1573.41 66083.35
3401 30 SANTOOR - SSP - 100GRX4 Pack 4613.20 150.00 5.00 Case 4,393.52 0.00 5% 549.19 549.19 23066.00
3402 20 YD SOFTOUCH - ROSE - 210+210ML 99/- 0.00 99.00 10.00 SET 0.00 916.70 18% 0.00 0.00 0.00
3402 21 SOFTOUCH BLUE - 18ML 4/- 40PCS CL840P 0.00 160.00 20.00 KATTA 0.00 2963.00 18% 0.00 0.00 0.00
3401 24 STR HAND WASH CLC - 200+200ML 99/- 0.00 99.00 2.00 Pcs. 0.00 180.00 18% 0.00 0.00 0.00
3402 12 SW LD FRONT LOAD - 1LTR POUCH 115/- 0.00 115.00 10.00 Pcs. 0.00 1064.80 18% 0.00 0.00 0.00
Less : Rounded Off (-) 0.32
Grand Total 1,54,815.00
`;

test('keeps supplier-independent P/C Product Details format stable and matches invoice grand total', () => {
  const rows = parseInvoiceRows(invoiceText);
  expect(rows).toHaveLength(23);
  expect(rows[0]).toMatchObject({
    barcode: '',
    product: 'YD SOFTOUCH - JSMNE - 210+210ML',
    hsn_code: '3402',
    mrp: '99.00',
    qty: '40',
    purchase_unit_size: '20',
    stock_conversion_factor: '1',
    gst_percent: '18',
    total_amount: '3593.30'
  });
  expect(Number(rows[0].price)).toBeCloseTo(76.1295, 4);

  const freeRow = rows.find((row) => row.product.includes('SOFTOUCH - ROSE') && row.total_amount === '0.00');
  expect(freeRow).toMatchObject({ qty: '10', price: '0', unit: 'PCS', purchase_unit_size: '20' });

  const roundOff = rows.at(-1);
  expect(roundOff).toMatchObject({ is_adjustment: true, qty: '1', price: '-0.32', total_amount: '-0.32' });
  expect(rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)).toBeCloseTo(154815, 2);
});