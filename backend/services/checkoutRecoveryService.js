const { moneyToPaise, parseCurrency } = require('../utils/money');

function lineSignature(items) {
  return JSON.stringify(items.map(item => [String(item.barcode || '').trim(), Math.round(Number(item.quantity) * 100), moneyToPaise(item.sale_price)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

async function findSavedCheckout(connection, payload) {
  const id = String(payload.checkout_request_id || '').trim();
  if (!id) return null;
  const [rows] = await connection.query(
    'SELECT invoice_no, grand_total, invoice_status FROM invoices WHERE checkout_request_id = ? LIMIT 1', [id]);
  if (!rows.length) return null;
  const invoice = rows[0];
  const conflict = error => ({ status: 409, body: { code: 'CHECKOUT_ALREADY_SAVED', error } });
  if (invoice.invoice_status !== 'PAID') return conflict('This checkout already exists and is no longer a paid sale. Check Bill History.');
  if (Math.abs(moneyToPaise(invoice.grand_total) - moneyToPaise(Math.round(parseCurrency(payload.grand_total)))) > 1) {
    return conflict('This checkout was already saved with a different total. Check Bill History before starting another sale.');
  }
  const [items] = await connection.query('SELECT barcode, product_name, quantity, sale_price, gst_percent, is_free_bonus FROM invoice_items WHERE invoice_no = ? ORDER BY id', [invoice.invoice_no]);
  const paidItems = items.filter(item => !Number(item.is_free_bonus));
  if (lineSignature(paidItems) !== lineSignature(payload.items || [])) {
    return conflict('This checkout was already saved with different items. Check Bill History before starting another sale.');
  }
  return { status: 200, body: {
    success: true, duplicate_prevented: true,
    message: 'Invoice was already committed successfully.', invoice_no: invoice.invoice_no,
    free_items: items.filter(item => Number(item.is_free_bonus) === 1)
  } };
}
module.exports = { findSavedCheckout };
