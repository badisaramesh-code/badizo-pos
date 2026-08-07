import React from 'react';
import { amountInWords, toNumber } from '../utils/money';

function money(value) {
  return toNumber(value).toFixed(2);
}

function quantity(value) {
  return toNumber(value, 1).toFixed(3).replace(/\.?0+$/, '') || '0';
}

export default function PrintableQuotation({ quotation }) {
  const items = Array.isArray(quotation.items) ? quotation.items : [];
  const bankRows = [
    ['Bank Name', quotation.shop?.bank_name],
    ['Account Name', quotation.shop?.bank_account_name || quotation.shop?.shop_name],
    ['A/c No', quotation.shop?.bank_account_no],
    ['IFSC', quotation.shop?.bank_ifsc],
    ['Branch', quotation.shop?.bank_branch],
    ['UPI ID', quotation.shop?.upi_id]
  ].filter(([, value]) => String(value || '').trim());
  const totalQuantity = items.reduce((sum, item) => sum + toNumber(item.quantity), 0);

  return (
    <div className="printable-quotation">
      <header className="quotation-heading">
        <div className="quotation-title-box">
          <strong>QUOTATION</strong>
          <span>(NOT A TAX INVOICE)</span>
        </div>
      </header>

      <section className="quotation-parties">
        <div className="quotation-shop-details">
          <h1>{quotation.shop?.shop_name || 'BADIZO POS'}</h1>
          <p>{quotation.shop?.address || '-'}</p>
          <p><b>GSTIN:</b> {quotation.shop?.gst_number || '-'}</p>
          <p><b>Phone:</b> {quotation.shop?.phone || '-'}</p>
        </div>
        <div className="quotation-customer-details">
          <h3>Customer Details</h3>
          <div><span>Name</span><b>{quotation.customerName || 'Walk-in Customer'}</b></div>
          <div><span>Phone</span><b>{quotation.customerPhone || '-'}</b></div>
          <div><span>Address</span><b>{quotation.customerAddress || '-'}</b></div>
          <div><span>GSTIN</span><b>{quotation.customerGstin || '-'}</b></div>
        </div>
      </section>

      <section className="quotation-meta">
        <div><span>Quotation No.</span><strong>{quotation.quotationNo}</strong></div>
        <div><span>Date</span><strong>{quotation.date}</strong></div>
        <div><span>Valid For</span><strong>{quotation.validityDays} days</strong></div>
        <div><span>Prepared At</span><strong>{quotation.counterLabel || '-'}</strong></div>
      </section>
      <table className="quotation-items-table">
        <thead>
          <tr><th>Barcode</th><th>Description</th><th>HSN</th><th>MRP</th><th>Discount</th><th>GST%</th><th>Qty</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0) * toNumber(item.quantity, 1);
            return (
              <tr key={`${item.barcode || 'item'}-${index}`}>
                <td>{item.barcode || '-'}</td>
                <td><strong>{item.product_name}</strong>{item.pack_measure ? <small>{item.pack_measure}</small> : null}</td>
                <td>{item.hsn_code || '-'}</td>
                <td>{money(item.mrp)}</td>
                <td>{money(discount)}</td>
                <td>{money(item.gst_percent)}</td>
                <td>{quantity(item.quantity)} {item.unit_type || ''}</td>
                <td><strong>{money(item.lineTotal)}</strong></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr><th colSpan="6">Total</th><th>{quantity(totalQuantity)}</th><th>Rs. {money(quotation.totals?.grand)}</th></tr>
        </tfoot>
      </table>

      <section className="quotation-summary">
        <div className="quotation-amount-words">
          <span>Amount in words</span>
          <strong>INR {amountInWords(quotation.totals?.grand)}</strong>
          {quotation.notes && <p><b>Notes:</b> {quotation.notes}</p>}
        </div>
        <div className="quotation-total-box">
          <div><span>Taxable Amount</span><strong>{money(quotation.totals?.taxable)}</strong></div>
          <div><span>GST Amount</span><strong>{money(quotation.totals?.tax)}</strong></div>
          <div><span>Round Off</span><strong>{money(quotation.totals?.roundOff)}</strong></div>
          <div className="quotation-grand"><span>Quotation Amount</span><strong>Rs. {money(quotation.totals?.grand)}</strong></div>
        </div>
      </section>

      <section className="quotation-bottom">
        <div className="quotation-bank-details">
          <h3>Bank Details</h3>
          {bankRows.length ? bankRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>) : <p>Bank details are not configured.</p>}
        </div>
        <div className="quotation-signature"><span>For {quotation.shop?.shop_name}</span><strong>Store Authorised Signatory</strong></div>
      </section>

      <footer>
        <strong>Terms:</strong> Prices and stock availability are subject to confirmation. This quotation does not reserve stock and does not record a sale or payment.
      </footer>
    </div>
  );
}