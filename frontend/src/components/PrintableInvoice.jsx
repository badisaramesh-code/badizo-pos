import React from 'react';
import { amountInWords, formatMoney, toNumber } from '../utils/money';
import { INVOICE_TEMPLATES } from './invoiceTemplates';

function formatPlainMoney(value) {
  return toNumber(value).toFixed(2);
}

function SectionLine() {
  return <div className="print-rule" />;
}

function getTaxBillLabel(invoice) {
  return invoice.taxType === 'INTERSTATE'
    ? 'INTERSTATE IGST BILL'
    : 'LOCAL GST BILL (CGST + SGST)';
}

function ThermalLogoSlot() {
  return (
    <div className="thermal-logo-slot">
      <picture>
        <source srcSet="/thermal-logo.png" type="image/png" />
        <img src="/thermal-logo.jpg" alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
      </picture>
    </div>
  );
}

function getGstRows(items, isInterstate) {
  const grouped = new Map();

  items.forEach((item) => {
    const gst = toNumber(item.gst_percent);
    const amount = toNumber(item.lineTotal);
    const taxable = amount / (1 + gst / 100);
    const tax = amount - taxable;
    const current = grouped.get(gst) || { gst, taxable: 0, tax: 0 };
    current.taxable += taxable;
    current.tax += tax;
    grouped.set(gst, current);
  });

  return Array.from(grouped.values()).sort((a, b) => a.gst - b.gst).map((row) => ({
    ...row,
    cgst: isInterstate ? 0 : row.tax / 2,
    sgst: isInterstate ? 0 : row.tax / 2,
    igst: isInterstate ? row.tax : 0
  }));
}

function StoreHeader({ invoice }) {
  const taxBillLabel = getTaxBillLabel(invoice);
  return (
    <div className="print-store-header">
      <h2>{invoice.shop.shop_name}</h2>
      <p>{invoice.shop.address}</p>
      <p>GSTIN: {invoice.shop.gst_number}</p>
      <SectionLine />
      <strong>GST INVOICE</strong>
      <strong className="print-tax-type-label">{taxBillLabel}</strong>
      <SectionLine />
    </div>
  );
}

function MetaGrid({ invoice }) {
  const taxBillLabel = getTaxBillLabel(invoice);
  return (
    <div className="print-meta-grid">
      <span>INVOICE NO. {invoice.invoiceNo}</span>
      <span>Counter - {invoice.counterNo}</span>
      <span>Date : {invoice.date}</span>
      <span>Time : {invoice.time}</span>
      <span>Bill Type : {taxBillLabel}</span>
      <span>Tax : {invoice.taxType === 'INTERSTATE' ? 'IGST' : 'CGST + SGST'}</span>
    </div>
  );
}

function ThermalCustomer({ invoice }) {
  const customerName = String(invoice.customerName || '').trim();
  const lines = [
    customerName ? ['Customer', customerName] : null,
    ['Phone', invoice.customerPhone || ''],
    ['GSTIN', invoice.customerGstin || ''],
    ['Address', invoice.customerAddress || '']
  ].filter(Boolean);

  return (
    <div className="thermal-customer-block">
      {lines.map(([label, value]) => (
        <div key={label}>
          <span>{label}:</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function ThermalItemTable({ invoice, template }) {
  return (
    <table className="print-table thermal-items">
      <thead>
        <tr>
          {template.itemColumns.map((column) => (
            <th key={column.key} style={{ width: column.width, textAlign: column.align || 'left' }}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {invoice.items.map((item, index) => {
          const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0);
          return (
            <React.Fragment key={`${item.barcode}-${index}`}>
              <tr>
                <td>{item.barcode || '-'}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.mrp)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(discount)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.gst_percent)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.quantity)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.lineTotal)}</td>
              </tr>
              <tr className="thermal-product-row">
                <td colSpan="6"><strong className="thermal-product-name">{item.product_name}</strong></td>
              </tr>
              <tr className="thermal-hsn-row">
                <td colSpan="6">HSN Code: {item.hsn_code || '-'}</td>
              </tr>
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function ThermalTotals({ invoice }) {
  return (
    <div className="thermal-total-box">
      <div><span>Billing Total</span><span /><strong>{formatPlainMoney(invoice.totals.grand)}</strong></div>
      <div><span>Bill Amount</span><span /><strong>{formatPlainMoney(invoice.totals.grand)}</strong></div>
      <div><span>Received Amt ({invoice.paymentMode})</span><span /><strong>{formatPlainMoney(invoice.cashReceived || invoice.totals.grand)}</strong></div>
      <div><span>Change Amt</span><span /><strong>{formatPlainMoney(invoice.changeReturned || 0)}</strong></div>
    </div>
  );
}

function GstSummary({ invoice }) {
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const rows = getGstRows(invoice.items, isInterstate);
  return (
    <table className="print-table gst-summary-table">
      <thead>
        {isInterstate ? (
          <tr>
            <th>TaxableAmt</th>
            <th>GST%</th>
            <th>IGST%</th>
            <th>IGST Amt</th>
            <th>TaxAmt</th>
          </tr>
        ) : (
          <tr>
            <th>TaxableAmt</th>
            <th>GST%</th>
            <th>CGST%</th>
            <th>CGST Amt</th>
            <th>SGST%</th>
            <th>SGST Amt</th>
            <th>TaxAmt</th>
          </tr>
        )}
      </thead>
      <tbody>
        {rows.map((row) => {
          const cgstPercent = row.gst / 2;
          const sgstPercent = row.gst / 2;
          return isInterstate ? (
            <tr key={row.gst}>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(row.igst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          ) : (
            <tr key={row.gst}>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(cgstPercent)}%</td>
              <td>{formatPlainMoney(row.cgst)}</td>
              <td>{formatPlainMoney(sgstPercent)}%</td>
              <td>{formatPlainMoney(row.sgst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          );
        })}
        <tr className="gst-summary-total-row">
          {isInterstate ? (
            <>
              <td>Total</td>
              <td />
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.igst, 0))}</td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.tax, 0))}</td>
            </>
          ) : (
            <>
              <td>Total</td>
              <td />
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.cgst, 0))}</td>
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.sgst, 0))}</td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.tax, 0))}</td>
            </>
          )}
        </tr>
      </tbody>
    </table>
  );
}

function A4Title() {
  return (
    <div className="a4-title-row">
      <span />
      <h1>Tax Invoice</h1>
      <span>(ORIGINAL FOR RECIPIENT)</span>
    </div>
  );
}

function SellerMeta({ invoice }) {
  return (
    <div className="a4-seller-meta">
      <div className="a4-seller">
        <strong>{invoice.shop.shop_name}</strong>
        <span>{invoice.shop.address}</span>
        <span>GSTIN/UIN: {invoice.shop.gst_number}</span>
        <span>Phone: {invoice.shop.phone || '-'}</span>
      </div>
      <div className="a4-meta-table">
        <div><span>Invoice No.</span><strong>{invoice.invoiceNo}</strong></div>
        <div><span>Dated</span><strong>{invoice.date}</strong></div>
        <div><span>Mode/Terms of Payment</span><strong>{invoice.paymentMode}</strong></div>
        <div><span>Reference No. & Date.</span><strong>-</strong></div>
        <div><span>Buyer's Order No.</span><strong>-</strong></div>
        <div><span>Destination</span><strong>-</strong></div>
      </div>
    </div>
  );
}

function BuyerBlocks({ invoice }) {
  const buyer = invoice.customerName || 'Walk-in Customer';
  return (
    <div className="a4-buyer-blocks">
      {['Consignee (Ship to)', 'Buyer (Bill to)'].map((label) => (
        <div key={label}>
          <span className="print-label">{label}</span>
          <strong>{buyer}</strong>
          <span>{invoice.customerAddress || '-'}</span>
          <span>GSTIN/UIN: {invoice.customerGstin || '-'}</span>
          <span>Place of Supply: Telangana, Code : 36</span>
        </div>
      ))}
    </div>
  );
}

function A4ItemTable({ invoice, template }) {
  const taxLabel = invoice.taxType === 'INTERSTATE' ? 'IGST' : 'CGST / SGST';
  const taxValue = invoice.taxType === 'INTERSTATE'
    ? invoice.totals.igst
    : invoice.totals.cgst + invoice.totals.sgst;

  return (
    <table className="print-table a4-items">
      <thead>
        <tr>
          {template.itemColumns.map((column) => (
            <th key={column.key} style={{ width: column.width, textAlign: column.align || 'left' }}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {invoice.items.map((item, index) => (
          <tr key={`${item.barcode}-${index}`}>
            <td>{index + 1}</td>
            <td><strong>{item.product_name}</strong></td>
            <td>{item.hsn_code || '-'}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.quantity)}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.unitPrice)}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.taxableRate)}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.gst_percent)}%</td>
            <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(item.lineTotal)}</strong></td>
          </tr>
        ))}
        <tr className="a4-tax-line">
          <td />
          <td><strong>{taxLabel}</strong></td>
          <td colSpan="5" />
          <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(taxValue)}</strong></td>
        </tr>
        <tr className="a4-tax-line">
          <td />
          <td><strong>ROUND OFF</strong></td>
          <td colSpan="5" />
          <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(invoice.totals.roundOff)}</strong></td>
        </tr>
      </tbody>
      <tfoot>
        <tr className="a4-grand-total-row">
          <td colSpan="3"><strong>Total Amount</strong></td>
          <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(invoice.itemCount)}</strong></td>
          <td colSpan="3" />
          <td style={{ textAlign: 'right' }}><strong>{formatMoney(invoice.totals.grand)}</strong></td>
        </tr>
      </tfoot>
    </table>
  );
}

function A4BottomSummary({ invoice, template }) {
  return (
    <div className="a4-bottom-summary">
      <div className="a4-words"><span>Amount Chargeable (in words)</span><strong>INR {amountInWords(invoice.totals.grand)}</strong></div>
      <div className="a4-section-title">GST Summary</div>
      <A4GstTable invoice={invoice} />
      <div className="a4-words"><span>Tax Amount (in words)</span><strong>INR {amountInWords(invoice.totals.tax)}</strong></div>
      <DeclarationBank template={template} />
      <div className="a4-signature"><span>Customer's Seal and Signature</span><strong>for {invoice.shop.shop_name}</strong><em>Authorised Signatory</em></div>
      <div className="print-center a4-generated-note"><strong>This is a Computer Generated Invoice</strong></div>
    </div>
  );
}

function A4GstTable({ invoice }) {
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const rows = getGstRows(invoice.items, isInterstate);
  return (
    <table className="print-table a4-gst-table">
      <thead>
        {isInterstate ? (
          <tr>
            <th>HSN/SAC</th>
            <th>Taxable Value</th>
            <th>GST%</th>
            <th>IGST%</th>
            <th>IGST Amt</th>
            <th>Total Tax Amount</th>
          </tr>
        ) : (
          <tr>
            <th>HSN/SAC</th>
            <th>Taxable Value</th>
            <th>GST%</th>
            <th>CGST%</th>
            <th>CGST Amt</th>
            <th>SGST%</th>
            <th>SGST Amt</th>
            <th>Total Tax Amount</th>
          </tr>
        )}
      </thead>
      <tbody>
        {rows.map((row) => {
          const hsn = invoice.items.find((item) => toNumber(item.gst_percent) === row.gst)?.hsn_code || '-';
          const cgstPercent = row.gst / 2;
          const sgstPercent = row.gst / 2;
          return isInterstate ? (
            <tr key={row.gst}>
              <td>{hsn}</td>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(row.igst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          ) : (
            <tr key={row.gst}>
              <td>{hsn}</td>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.gst)}%</td>
              <td>{formatPlainMoney(cgstPercent)}%</td>
              <td>{formatPlainMoney(row.cgst)}</td>
              <td>{formatPlainMoney(sgstPercent)}%</td>
              <td>{formatPlainMoney(row.sgst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          );
        })}
        <tr className="gst-summary-total-row">
          {isInterstate ? (
            <>
              <td><strong>Total</strong></td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.taxable, 0))}</td>
              <td />
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.igst, 0))}</td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.tax, 0))}</td>
            </>
          ) : (
            <>
              <td><strong>Total</strong></td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.taxable, 0))}</td>
              <td />
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.cgst, 0))}</td>
              <td />
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.sgst, 0))}</td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.tax, 0))}</td>
            </>
          )}
        </tr>
      </tbody>
    </table>
  );
}

function DeclarationBank({ template }) {
  return (
    <div className="a4-declaration-bank">
      <div>
        <strong>Declaration</strong>
        <span>{template.declaration}</span>
      </div>
      <div>
        <strong>Company's Bank Details</strong>
        {template.bankDetails.map(([label, value]) => (
          <span key={label}>{label}: <strong>{value}</strong></span>
        ))}
      </div>
    </div>
  );
}

function getA4BankDetails(shop, template) {
  const details = [
    ['Bank Name', shop.bank_name || ''],
    ['Account Name', shop.bank_account_name || shop.shop_name || ''],
    ['A/c No', shop.bank_account_no || ''],
    ['IFSC', shop.bank_ifsc || ''],
    ['Branch', shop.bank_branch || '']
  ].filter(([, value]) => String(value || '').trim());

  return details.length ? details : template.bankDetails;
}

function A4OnePageInvoice({ invoice, template }) {
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const taxBillLabel = getTaxBillLabel(invoice);
  const gstRows = getGstRows(invoice.items, isInterstate);
  const bankDetails = getA4BankDetails(invoice.shop, template);
  const qtyTotal = invoice.items.reduce((sum, item) => sum + toNumber(item.quantity), 0);
  const billingTotal = toNumber(invoice.totals.grand);
  const receivedAmount = invoice.paymentMode === 'Cash'
    ? toNumber(invoice.cashReceived || billingTotal)
    : billingTotal;
  const changeAmount = invoice.paymentMode === 'Cash'
    ? toNumber(invoice.changeReturned)
    : 0;
  const taxableTotal = gstRows.reduce((sum, row) => sum + row.taxable, 0);
  const sgstTotal = gstRows.reduce((sum, row) => sum + row.sgst, 0);
  const cgstTotal = gstRows.reduce((sum, row) => sum + row.cgst, 0);
  const igstTotal = gstRows.reduce((sum, row) => sum + row.igst, 0);
  const taxTotal = gstRows.reduce((sum, row) => sum + row.tax, 0);
  const totalDiscount = invoice.items.reduce((sum, item) => {
    const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0) * toNumber(item.quantity);
    return sum + discount;
  }, 0);

  return (
    <div className={`print-invoice a4-paper a4-one-page a4-store-invoice ${isInterstate ? 'a4-igst-invoice' : 'a4-gst-invoice'}`}>
      <div className="a4-store-title">
        <strong>TAX INVOICE</strong>
        <span>{taxBillLabel}</span>
      </div>

      <div className="a4-store-top">
        <div className="a4-store-shop">
          <strong>{invoice.shop.shop_name}</strong>
          {String(invoice.shop.address || '').split(/\s*\|\s*|\n/).filter(Boolean).map((line) => <span key={line}>{line}</span>)}
          <span>Gst no: {invoice.shop.gst_number}</span>
          <span>Phno {invoice.shop.phone || '-'}</span>
        </div>
        <div className="a4-store-meta">
          <span>Invoice No.</span><strong>{invoice.invoiceNo}</strong>
          <span>Date</span><strong>{invoice.date}</strong>
          <span>payment mode</span><strong>{invoice.paymentMode}</strong>
          <span>Transaction ID</span><strong>{invoice.paymentReference || '-'}</strong>
          <span>Counter</span><strong>{invoice.counterNo || '-'}</strong>
          <span>Bill Type</span><strong>{taxBillLabel}</strong>
        </div>
      </div>

      <div className="a4-store-customer">
        <div>
          <span>Name&nbsp;&nbsp;:</span><strong>{invoice.customerName || ''}</strong>
          <span>Address :</span><strong>{invoice.customerAddress || ''}</strong>
          <span>Phno.&nbsp;&nbsp;:</span><strong>{invoice.customerPhone || ''}</strong>
          <span>GST NO:</span><strong>{invoice.customerGstin || ''}</strong>
        </div>
        <div />
      </div>

      <table className="a4-store-items">
        <thead>
          <tr>
            <th>sno</th>
            <th>Barcode</th>
            <th>Description</th>
            <th>HSN</th>
            <th>MRP</th>
            <th>Discount</th>
            <th>GST%</th>
            <th>Qty</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item, index) => {
            const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0) * toNumber(item.quantity);
            return (
              <tr key={`${item.barcode}-${index}`}>
                <td>{index + 1}</td>
                <td>{item.barcode || '-'}</td>
                <td><strong>{item.product_name}</strong></td>
                <td>{item.hsn_code || '-'}</td>
                <td>{formatPlainMoney(item.mrp)}</td>
                <td>{formatPlainMoney(discount)}</td>
                <td>{formatPlainMoney(item.gst_percent)}</td>
                <td>{formatPlainMoney(item.quantity)}</td>
                <td><strong>{formatPlainMoney(item.lineTotal)}</strong></td>
              </tr>
            );
          })}
          {Array.from({ length: Math.max(10, 20 - invoice.items.length) }).map((_, index) => (
            <tr className="a4-store-empty-row" key={`blank-${index}`}><td colSpan="9" /></tr>
          ))}
        </tbody>
      </table>

      <div className="a4-store-discount">You Have Gained Discount Amount Rs. <strong>{formatPlainMoney(totalDiscount)}</strong></div>
      <div className="a4-store-words">Total Amount In words................................ <strong>INR {amountInWords(invoice.totals.grand)}</strong></div>

      <div className="a4-store-bottom">
        <div className="a4-store-bank">
          <strong>Bank Details</strong>
          {bankDetails.map(([label, value]) => <span key={label}>{label}: <b>{value}</b></span>)}
        </div>
        <div className="a4-store-right-bottom">
          <div className="a4-store-payment-summary">
            <div><span>Billing Total</span><strong>{formatPlainMoney(billingTotal)}</strong></div>
            <div><span>Qty Total</span><strong>{formatPlainMoney(qtyTotal)}</strong></div>
            <div><span>Received Amount</span><strong>{formatPlainMoney(receivedAmount)}</strong></div>
            <div><span>Given Change Amount</span><strong>{formatPlainMoney(changeAmount)}</strong></div>
          </div>
          <table className="a4-store-gst">
            <caption>{isInterstate ? 'IGST Summary' : 'GST Summary'}</caption>
            <thead><tr><th>GST%</th><th>SGST Rs</th><th>CGST Rs</th><th>IGST Rs</th><th>Taxable</th><th>Tax Amt</th><th>Total</th></tr></thead>
            <tbody>
              {gstRows.map((row) => (
                <tr key={row.gst}>
                  <td>{formatPlainMoney(row.gst)}</td>
                  <td>{formatPlainMoney(row.sgst)}</td>
                  <td>{formatPlainMoney(row.cgst)}</td>
                  <td>{formatPlainMoney(row.igst)}</td>
                  <td>{formatPlainMoney(row.taxable)}</td>
                  <td>{formatPlainMoney(row.tax)}</td>
                  <td>{formatPlainMoney(row.taxable + row.tax)}</td>
                </tr>
              ))}
              {Array.from({ length: Math.max(0, 2 - gstRows.length) }).map((_, index) => (
                <tr key={`gst-blank-${index}`}><td /><td /><td /><td /><td /><td /><td /></tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>Total</th><th>{formatPlainMoney(sgstTotal)}</th><th>{formatPlainMoney(cgstTotal)}</th><th>{formatPlainMoney(igstTotal)}</th><th>{formatPlainMoney(taxableTotal)}</th><th>{formatPlainMoney(taxTotal)}</th><th>{formatPlainMoney(billingTotal)}</th></tr>
            </tfoot>
          </table>
        </div>
        <div className="a4-store-customer-sign">Customer Signature</div>
        <div className="a4-store-auth"><span>For {invoice.shop.shop_name}</span><strong>Authorised Signature</strong></div>
      </div>
    </div>
  );
}

function renderSection(section, invoice, template) {
  if (!section.enabled) return null;

  switch (section.type) {
    case 'thermalLogo':
      return <ThermalLogoSlot />;
    case 'storeHeader':
      return <StoreHeader invoice={invoice} />;
    case 'metaGrid':
      return <MetaGrid invoice={invoice} />;
    case 'rule':
      return <SectionLine />;
    case 'thermalCustomer':
      return <ThermalCustomer invoice={invoice} />;
    case 'itemTable':
      return <ThermalItemTable invoice={invoice} template={template} />;
    case 'freeProducts':
      return <><SectionLine /><div className="print-center"><strong>{section.title}</strong></div></>;
    case 'thermalTotals':
      return <><SectionLine /><ThermalTotals invoice={invoice} /></>;
    case 'amountWords':
      return <><SectionLine /><p><strong>({amountInWords(invoice.totals.grand)})</strong></p></>;
    case 'discountLine':
      return invoice.totals.discount > 0 ? <><SectionLine /><div className="print-row print-discount-row"><span>You Have Gained Discount Amount</span><strong>{formatPlainMoney(invoice.totals.discount)}</strong></div></> : null;
    case 'gstSummary':
      return <><SectionLine /><div className="print-center"><strong>{invoice.taxType === 'INTERSTATE' ? 'IGST Summary' : 'GST Summary'}</strong></div><GstSummary invoice={invoice} /></>;
    case 'terms':
      return <><SectionLine /><div className="print-terms">{template.terms.map((term) => <p key={term}>{term}</p>)}</div></>;
    case 'centerText':
      if (template.paperClass === 'a4-paper' && section.id === 'generated-note') return null;
      return <div className="print-center"><strong>{section.text}</strong></div>;
    case 'a4Title':
      return <A4Title />;
    case 'sellerMeta':
      return <SellerMeta invoice={invoice} />;
    case 'buyerBlocks':
      return <BuyerBlocks invoice={invoice} />;
    case 'a4ItemTable':
      return <A4ItemTable invoice={invoice} template={template} />;
    case 'a4AmountWords':
      return null;
    case 'a4GstTable':
      return <A4BottomSummary invoice={invoice} template={template} />;
    case 'taxWords':
      return null;
    case 'declarationBank':
      return null;
    case 'signature':
      return null;
    default:
      return null;
  }
}

export default function PrintableInvoice({ invoice, mode }) {
  const template = INVOICE_TEMPLATES[mode] || INVOICE_TEMPLATES.Thermal;
  if (!invoice) return null;
  if (template.paperClass === 'a4-paper') {
    return <A4OnePageInvoice invoice={invoice} template={template} />;
  }

  return (
    <div className={`print-invoice ${template.paperClass}`}>
      {template.sections.map((section) => (
        <React.Fragment key={section.id}>
          {renderSection(section, invoice, template)}
        </React.Fragment>
      ))}
    </div>
  );
}
