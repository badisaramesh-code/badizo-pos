import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { amountInWords, toNumber } from './money';

const money = value => toNumber(value).toFixed(2);
const date = value => String(value || '').slice(0, 10) || '-';

export function OrderEstimate({ details, shop }) {
  const { order, items } = details;
  const bankRows = [['Bank Name', shop.bank_name], ['Account Name', shop.bank_account_name || shop.shop_name], ['A/c No', shop.bank_account_no], ['IFSC', shop.bank_ifsc], ['Branch', shop.bank_branch], ['UPI ID', shop.upi_id]].filter(([, value]) => String(value || '').trim());
  return <div className="printable-quotation">
    <header className="quotation-heading"><div className="quotation-title-box"><strong>ORDER ESTIMATE</strong><span>(NOT A TAX INVOICE)</span></div></header>
    <section className="quotation-parties">
      <div className="quotation-shop-details"><h1>{shop.shop_name || 'BADIZO POS'}</h1><p>{shop.address}</p><p><b>GSTIN:</b> {shop.gst_number || '-'}</p><p><b>Phone:</b> {shop.phone || '-'}</p></div>
      <div className="quotation-customer-details"><h3>Customer Details</h3><div><span>Name</span><b>{order.customer_name}</b></div><div><span>Phone</span><b>{order.customer_phone || '-'}</b></div><div><span>Event</span><b>{order.event_type || '-'}</b></div></div>
    </section>
    <section className="quotation-meta"><div><span>Order No.</span><strong>{order.order_no}</strong></div><div><span>Order Date</span><strong>{date(order.created_at)}</strong></div><div><span>Required Date</span><strong>{date(order.required_date)}</strong></div><div><span>Delivery Time</span><strong>{order.delivery_time || '-'}</strong></div></section>
    <table className="quotation-items-table"><thead><tr><th>Sl.</th><th>Barcode</th><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>{items.map((item, index) => <tr key={index}><td>{index + 1}</td><td>{item.barcode || '-'}</td><td><strong>{item.item_name}</strong></td><td>{toNumber(item.quantity)}</td><td>{item.unit}</td><td>{money(item.estimated_rate)}</td><td><strong>{money(toNumber(item.quantity) * toNumber(item.estimated_rate))}</strong></td></tr>)}</tbody>
      <tfoot><tr><th colSpan="6">Order Total</th><th>Rs. {money(order.total_amount)}</th></tr></tfoot>
    </table>
    <section className="quotation-summary"><div className="quotation-amount-words"><span>Amount in words</span><strong>INR {amountInWords(order.total_amount)}</strong>{order.notes && <p><b>Notes:</b> {order.notes}</p>}</div>
      <div className="quotation-total-box"><div><span>Advance / Paid</span><strong>Rs. {money(order.paid_amount)}</strong></div><div className="quotation-grand"><span>Balance Due</span><strong>Rs. {money(order.balance_due)}</strong></div><div><span>Due Date</span><strong>{date(order.due_date)}</strong></div></div></section>
    <section className="quotation-bottom"><div className="quotation-bank-details"><h3>Bank Details</h3>{bankRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="quotation-signature"><span>For {shop.shop_name || 'BADIZO POS'}</span><strong>Store Authorised Signatory</strong></div></section>
    <footer>Special order estimate. Please quote the order number for enquiries and payments.</footer>
  </div>;
}

export function buildOrderEstimateHtml(details, shop) {
  const markup = renderToStaticMarkup(<OrderEstimate details={details} shop={shop} />);
  // Embed the complete print design: desktop PDF windows must not depend on
  // app stylesheet links, which may be inaccessible from their data: URL.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Badizo Order Estimate</title><style>
    @page { size: A4 portrait; margin: 10mm; }
    html, body { margin:0!important; padding:0!important; background:#fff!important; }
    .quotation-print-host, .printable-quotation { width:190mm!important; margin:0 auto!important; }
    * { box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#111827; font-size:10px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .printable-quotation { min-height:277mm; padding:8mm; border:0!important; }
    .quotation-heading { border:2px solid #08783e; text-align:center; }
    .quotation-title-box { display:flex; align-items:baseline; justify-content:center; gap:1.5mm; padding:1.5mm 3mm; }
    .quotation-title-box strong { color:#08783e; font-size:16px; letter-spacing:1px; }
    .quotation-title-box span { color:#b91c1c; font-size:8px; font-weight:bold; }
    .quotation-parties { display:grid; grid-template-columns:1fr 1fr; border:1px solid #9ca3af; border-top:0; }
    .quotation-shop-details,.quotation-customer-details { padding:3mm; overflow-wrap:anywhere; }
    .quotation-shop-details { border-right:1px solid #9ca3af; }
    h1 { margin:0 0 1.5mm; color:#08783e; font-size:20px; }
    p { margin:.8mm 0; } h3 { margin:0 0 2mm; color:#08783e; font-size:12px; }
    .quotation-customer-details div { display:grid; grid-template-columns:20mm 1fr; gap:2mm; margin:1mm 0; }
    .quotation-customer-details span,.quotation-meta span,.quotation-amount-words span { color:#4b5563; font-size:9px; }
    .quotation-meta { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid #9ca3af; border-top:0; }
    .quotation-meta>div { padding:2mm; min-height:13mm; border-right:1px solid #d1d5db; overflow-wrap:anywhere; }
    .quotation-meta>div:last-child { border-right:0; }
    .quotation-meta span,.quotation-meta strong { display:block; } .quotation-meta strong { margin-top:1mm; font-size:11px; }
    .quotation-items-table { width:100%; margin-top:3mm; border-collapse:collapse; table-layout:fixed; }
    .quotation-items-table th,.quotation-items-table td { padding:1.8mm 1mm; border:1px solid #9ca3af; vertical-align:top; overflow-wrap:anywhere; }
    .quotation-items-table thead th { background:#eaf7ef; color:#065f46; font-size:9px; text-transform:uppercase; }
    .quotation-items-table td:nth-child(n+4),.quotation-items-table th:nth-child(n+4) { text-align:right; }
    .quotation-items-table tfoot th { background:#f3f4f6; font-size:11px; }
    .quotation-summary { display:grid; grid-template-columns:1fr 65mm; border:1px solid #9ca3af; border-top:0; }
    .quotation-amount-words { padding:3mm; } .quotation-amount-words strong { display:block; margin-top:1mm; font-size:11px; }
    .quotation-amount-words p { margin:3mm 0 0; white-space:pre-wrap; }
    .quotation-total-box { border-left:1px solid #9ca3af; }
    .quotation-total-box div { display:flex; justify-content:space-between; gap:3mm; padding:1.5mm 2mm; border-bottom:1px solid #d1d5db; }
    .quotation-total-box div:last-child { border-bottom:0; }
    .quotation-grand { color:#08783e; font-size:12px; }
    .quotation-bottom { display:grid; grid-template-columns:1fr 55mm; margin-top:3mm; border:1px solid #9ca3af; break-inside:avoid; }
    .quotation-bank-details { padding:3mm; } .quotation-bank-details h3 { text-align:center; }
    .quotation-bank-details div { display:grid; grid-template-columns:24mm 1fr; gap:2mm; margin:1mm 0; }
    .quotation-bank-details strong { text-align:right; overflow-wrap:anywhere; }
    .quotation-signature { display:flex; flex-direction:column; justify-content:space-between; text-align:center; padding:3mm; min-height:30mm; border-left:1px solid #9ca3af; }
    footer { margin-top:3mm; padding-top:2mm; border-top:1px solid #9ca3af; color:#4b5563; font-size:9px; }
    .quotation-items-table th:nth-child(1) { width:8mm; }
    .quotation-items-table th:nth-child(2) { width:26mm; }
    .quotation-items-table th:nth-child(3) { width:62mm; }
    .quotation-items-table th:nth-child(4), .quotation-items-table th:nth-child(5) { width:15mm; }
    .quotation-items-table th:nth-child(6) { width:22mm; }
    .quotation-items-table th:nth-child(7) { width:26mm; }
    thead { display:table-header-group; } tr { break-inside:avoid; }
  </style></head><body><div class="quotation-print-host">${markup}</div></body></html>`;
}
