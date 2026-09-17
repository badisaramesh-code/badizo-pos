import * as XLSX from 'xlsx';

test('patched spreadsheet reader preserves barcode strings and numeric quantities', () => {
  const source = [['barcode', 'product', 'quantity', 'price'], ['001234567890', 'GIFFY', 2, 235], ['890000000001', 'Loose product', 0.25, 65.5]];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(source), 'Products');
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  const read = XLSX.read(bytes, { type: 'array' });
  expect(XLSX.utils.sheet_to_json(read.Sheets.Products, { header: 1 })).toEqual(source);
});
