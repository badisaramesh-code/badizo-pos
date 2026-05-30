import React from 'react';
import { amountInWords, formatMoney, toNumber } from '../utils/money';
import { INVOICE_TEMPLATES } from './invoiceTemplates';

function formatPlainMoney(value) {
  return toNumber(value).toFixed(2);
}

function SectionLine() {
  return <div className="print-rule" />;
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
  return (
    <div className="print-store-header">
      <h2>{invoice.shop.shop_name}</h2>
      <p>{invoice.shop.address}</p>
      <p>GSTIN: {invoice.shop.gst_number}</p>
      <SectionLine />
      <strong>GST Invoice</strong>
      <span>{invoice.paymentMode}</span>
    </div>
  );
}

function MetaGrid({ invoice }) {
  return (
    <div className="print-meta-grid">
      <span>SI - {invoice.invoiceNo}</span>
      <span>Date : {invoice.date}</span>
      <span />
      <span>Time : {invoice.time}</span>
      <span />
      <span>User : Counter{invoice.counterNo}</span>
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
        {invoice.items.map((item, index) => (
          <React.Fragment key={`${item.barcode}-${index}`}>
            <tr>
              <td>{index + 1} {item.barcode || '-'}</td>
              <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.gst_percent)}%</td>
              <td />
              <td />
            </tr>
            <tr>
              <td colSpan="4"><strong>{item.product_name}</strong></td>
            </tr>
            <tr>
              <td>HSN : {item.hsn_code || '-'}</td>
              <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.unitPrice)}</td>
              <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.quantity)}</td>
              <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.lineTotal)}</td>
            </tr>
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

function ThermalTotals({ invoice }) {
  return (
    <div className="thermal-total-box">
      <div><span>Billing Total</span><span>{formatPlainMoney(invoice.itemCount)}</span><strong>{formatPlainMoney(invoice.totals.grand)}</strong></div>
      <div><span>Bill Amount</span><span>{formatPlainMoney(invoice.itemCount)}</span><strong>{formatPlainMoney(invoice.totals.grand)}</strong></div>
      <div><span>Received Amt</span><span /></div>
    </div>
  );
}

function GstSummary({ invoice }) {
  const rows = getGstRows(invoice.items, invoice.taxType === 'INTERSTATE');
  return (
    <table className="print-table gst-summary-table">
      <thead>
        <tr>
          <th>TaxableAmt</th>
          <th>GST%</th>
          <th>CGST</th>
          <th>SGST</th>
          <th>IGST</th>
          <th>TaxAmt</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.gst}>
            <td>{formatPlainMoney(row.taxable)}</td>
            <td>{formatPlainMoney(row.gst)}%</td>
            <td>{formatPlainMoney(row.cgst)}</td>
            <td>{formatPlainMoney(row.sgst)}</td>
            <td>{formatPlainMoney(row.igst)}</td>
            <td>{formatPlainMoney(row.tax)}</td>
          </tr>
        ))}
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
            <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(item.lineTotal)}</strong></td>
          </tr>
        ))}
        <tr className="a4-tax-lines">
          <td />
          <td><strong>CGST</strong><br /><strong>SGST</strong><br /><strong>IGST</strong><br /><strong>ROUND OFF</strong></td>
          <td colSpan="4" />
          <td style={{ textAlign: 'right' }}>
            <strong>{formatPlainMoney(invoice.totals.cgst)}</strong><br />
            <strong>{formatPlainMoney(invoice.totals.sgst)}</strong><br />
            <strong>{formatPlainMoney(invoice.totals.igst)}</strong><br />
            <strong>{formatPlainMoney(invoice.totals.roundOff)}</strong>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colSpan="3">Total</td>
          <td style={{ textAlign: 'right' }}><strong>{formatPlainMoney(invoice.itemCount)}</strong></td>
          <td colSpan="2" />
          <td style={{ textAlign: 'right' }}><strong>{formatMoney(invoice.totals.grand)}</strong></td>
        </tr>
      </tfoot>
    </table>
  );
}

function A4GstTable({ invoice }) {
  const rows = getGstRows(invoice.items, invoice.taxType === 'INTERSTATE');
  return (
    <table className="print-table a4-gst-table">
      <thead>
        <tr>
          <th>HSN/SAC</th>
          <th>Taxable Value</th>
          <th>CGST</th>
          <th>SGST/UTGST</th>
          <th>Total Tax Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.gst}>
            <td>{invoice.items.find((item) => toNumber(item.gst_percent) === row.gst)?.hsn_code || '-'}</td>
            <td>{formatPlainMoney(row.taxable)}</td>
            <td>{formatPlainMoney(row.cgst)}</td>
            <td>{formatPlainMoney(row.sgst + row.igst)}</td>
            <td>{formatPlainMoney(row.tax)}</td>
          </tr>
        ))}
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

function renderSection(section, invoice, template) {
  if (!section.enabled) return null;

  switch (section.type) {
    case 'storeHeader':
      return <StoreHeader invoice={invoice} />;
    case 'metaGrid':
      return <MetaGrid invoice={invoice} />;
    case 'itemTable':
      return <ThermalItemTable invoice={invoice} template={template} />;
    case 'freeProducts':
      return <><SectionLine /><div className="print-center"><strong>{section.title}</strong></div></>;
    case 'thermalTotals':
      return <><SectionLine /><ThermalTotals invoice={invoice} /></>;
    case 'amountWords':
      return <><SectionLine /><p><strong>({amountInWords(invoice.totals.grand)})</strong></p></>;
    case 'discountLine':
      return invoice.totals.discount > 0 ? <><SectionLine /><div className="print-row"><span>You Have Gained Discount Amount</span><strong>{formatPlainMoney(invoice.totals.discount)}</strong></div></> : null;
    case 'gstSummary':
      return <><SectionLine /><div className="print-center"><strong>{section.title}</strong></div><GstSummary invoice={invoice} /></>;
    case 'terms':
      return <><SectionLine /><div className="print-terms">{template.terms.map((term) => <p key={term}>{term}</p>)}</div></>;
    case 'centerText':
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
      return <div className="a4-words"><span>Amount Chargeable (in words)</span><strong>INR {amountInWords(invoice.totals.grand)}</strong></div>;
    case 'a4GstTable':
      return <A4GstTable invoice={invoice} />;
    case 'taxWords':
      return <div className="a4-words"><span>Tax Amount (in words)</span><strong>INR {amountInWords(invoice.totals.tax)}</strong></div>;
    case 'declarationBank':
      return <DeclarationBank template={template} />;
    case 'signature':
      return <div className="a4-signature"><span>Customer's Seal and Signature</span><strong>for {invoice.shop.shop_name}</strong><em>Authorised Signatory</em></div>;
    default:
      return null;
  }
}

export default function PrintableInvoice({ invoice, mode }) {
  const template = INVOICE_TEMPLATES[mode] || INVOICE_TEMPLATES.Thermal;
  if (!invoice) return null;

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
