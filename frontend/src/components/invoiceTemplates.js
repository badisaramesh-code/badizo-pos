export const THERMAL_RECEIPT_TEMPLATE = {
  id: 'thermal',
  label: 'Thermal receipt',
  paperClass: 'thermal-paper',
  sections: [
    { id: 'thermal-logo', type: 'thermalLogo', enabled: true },
    { id: 'store-header', type: 'storeHeader', enabled: true },
    { id: 'receipt-meta', type: 'metaGrid', enabled: true },
    { id: 'meta-customer-rule', type: 'rule', enabled: true },
    { id: 'customer-details', type: 'thermalCustomer', enabled: true },
    { id: 'thermal-items', type: 'itemTable', enabled: true },
    { id: 'free-products', type: 'freeProducts', enabled: true, title: '*** Free Product Details ***' },
    { id: 'billing-total', type: 'thermalTotals', enabled: true },
    { id: 'amount-words', type: 'amountWords', enabled: true },
    { id: 'discount', type: 'discountLine', enabled: true },
    { id: 'gst-summary', type: 'gstSummary', enabled: true, title: 'GST Summary' },
    { id: 'terms', type: 'terms', enabled: true },
    { id: 'thanks', type: 'centerText', enabled: true, text: 'Thank You Visit Again' }
  ],
  itemColumns: [
    { key: 'barcode', label: 'Barcode/Product', width: '34%' },
    { key: 'mrp', label: 'MRP', width: '14%', align: 'right' },
    { key: 'discount', label: 'Disc', width: '13%', align: 'right' },
    { key: 'gst', label: 'GST%', width: '12%', align: 'right' },
    { key: 'quantity', label: 'Qty', width: '9%', align: 'right' },
    { key: 'total', label: 'Total', width: '18%', align: 'right' }
  ],
  terms: [
    'E. & O. E',
    '1. Goods Exchange Time 2 P.M - 4 P.M',
    '2. Decoration Items & Toys Exchange Not Allowed',
    '3. Warranty or guarantee is the responsibility of the manufacturer.',
    '4. Any dispute subject related to SATHUPALLY jurisdiction.'
  ]
};

export const A4_TAX_INVOICE_TEMPLATE = {
  id: 'a4',
  label: 'A4 tax invoice',
  paperClass: 'a4-paper',
  sections: [
    { id: 'a4-title', type: 'a4Title', enabled: true },
    { id: 'seller-and-meta', type: 'sellerMeta', enabled: true },
    { id: 'buyer', type: 'buyerBlocks', enabled: true },
    { id: 'a4-items', type: 'a4ItemTable', enabled: true },
    { id: 'a4-words', type: 'a4AmountWords', enabled: true },
    { id: 'a4-gst', type: 'a4GstTable', enabled: true },
    { id: 'tax-words', type: 'taxWords', enabled: true },
    { id: 'declaration-bank', type: 'declarationBank', enabled: true },
    { id: 'signature', type: 'signature', enabled: true },
    { id: 'generated-note', type: 'centerText', enabled: true, text: 'This is a Computer Generated Invoice' }
  ],
  itemColumns: [
    { key: 'serial', label: 'Sl No.', width: '5%' },
    { key: 'description', label: 'Description of Goods', width: '34%' },
    { key: 'hsn', label: 'HSN/SAC', width: '11%' },
    { key: 'quantity', label: 'Quantity', width: '11%', align: 'right' },
    { key: 'rateWithTax', label: 'Rate (Incl. of Tax)', width: '11%', align: 'right' },
    { key: 'rate', label: 'Rate', width: '9%', align: 'right' },
    { key: 'gst', label: 'Tax%', width: '8%', align: 'right' },
    { key: 'amount', label: 'Amount', width: '11%', align: 'right' }
  ],
  declaration: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  bankDetails: [
    ['Bank Name', 'ICICI BANK'],
    ['A/c No.', '363305001255'],
    ['Branch & IFS Code', 'KODAD & ICIC0003633']
  ]
};

export const INVOICE_TEMPLATES = {
  Thermal: THERMAL_RECEIPT_TEMPLATE,
  A4: A4_TAX_INVOICE_TEMPLATE
};
