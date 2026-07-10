import QRCode from 'qrcode';
import React from 'react';
import { amountInWords, formatMoney, toNumber } from '../utils/money';
import { INVOICE_TEMPLATES } from './invoiceTemplates';

function formatPlainMoney(value) {
  return toNumber(value).toFixed(2);
}

function formatPercent(value) {
  const fixed = toNumber(value).toFixed(2);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function getItemUnit(item) {
  return String(item?.unit_type || item?.unit || '').trim() || 'Nos';
}

function formatQuantityWithUnit(itemOrQuantity, maybeUnit = '') {
  const quantity = typeof itemOrQuantity === 'object'
    ? toNumber(itemOrQuantity?.quantity, 1)
    : toNumber(itemOrQuantity, 1);
  const unit = typeof itemOrQuantity === 'object'
    ? getItemUnit(itemOrQuantity)
    : (String(maybeUnit || '').trim() || 'Nos');
  return `${formatPlainMoney(quantity)} ${unit}`;
}

function formatQuantityDetail(item) {
  const unit = String(item?.unit_type || item?.unit || '').trim();
  if (!unit) return '';
  return unit;
}

function SectionLine() {
  return <div className="print-rule" />;
}

function getTaxBillLabel(invoice) {
  return invoice.taxType === 'INTERSTATE'
    ? 'INTERSTATE IGST BILL'
    : 'LOCAL GST BILL (CGST + SGST)';
}

function sanitizeQrText(value, limit = 32) {
  return String(value || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function getPaymentSplits(invoice) {
  return Array.isArray(invoice.paymentSplits)
    ? invoice.paymentSplits.filter((payment) => toNumber(payment.amount) > 0)
    : [];
}

function getReceivedAmount(invoice) {
  const billingTotal = toNumber(invoice?.totals?.grand);
  if (invoice?.paymentMode === 'Mixed') {
    const splitTotal = getPaymentSplits(invoice).reduce((sum, payment) => sum + toNumber(payment.amount), 0);
    return splitTotal || toNumber(invoice.cashReceived || billingTotal);
  }
  if (invoice?.paymentMode === 'Cash') {
    return toNumber(invoice.cashReceived || billingTotal);
  }
  return billingTotal;
}

function getChangeAmount(invoice) {
  return ['Cash', 'Mixed'].includes(invoice?.paymentMode)
    ? toNumber(invoice.changeReturned)
    : 0;
}

function buildBillQrPayload(invoice) {
  const billingTotal = toNumber(invoice?.totals?.grand);
  const exchangeTotal = toNumber(invoice?.totals?.exchangeTotal);
  const loyaltyRedeemAmount = toNumber(invoice?.totals?.loyaltyRedeemAmount);
  const loyaltyRedeemPoints = toNumber(invoice?.totals?.loyaltyRedeemPoints);
  const received = getReceivedAmount(invoice);
  const change = getChangeAmount(invoice);
  const lines = [
    'BADIZO POS BILL',
    `Shop: ${sanitizeQrText(invoice.shop?.shop_name, 36)}`,
    `Invoice: ${sanitizeQrText(invoice.invoiceNo, 36)}`,
    `Date: ${sanitizeQrText(invoice.date, 16)}`,
    `Time: ${sanitizeQrText(invoice.time, 16)}`,
    `Bill Amount: Rs. ${formatPlainMoney(billingTotal)}`,
    `Paid By: ${sanitizeQrText(invoice.paymentMode, 12)}`,
    `Received: Rs. ${formatPlainMoney(received)}`,
    `Change: Rs. ${formatPlainMoney(change)}`
  ];
  getPaymentSplits(invoice).forEach((payment) => {
    lines.push(`${sanitizeQrText(payment.mode, 8)}: Rs. ${formatPlainMoney(payment.amount)}`);
  });
  if (exchangeTotal > 0) lines.splice(6, 0, `Exchange Less: Rs. ${formatPlainMoney(exchangeTotal)}`);
  if (loyaltyRedeemAmount > 0) {
    lines.splice(7, 0, `Less Loyalty Amount: Rs. ${formatPlainMoney(loyaltyRedeemAmount)} (${formatPlainMoney(loyaltyRedeemPoints)} pts)`);
  }
  const customerName = sanitizeQrText(invoice.customerName, 24);
  const customerPhone = sanitizeQrText(invoice.customerPhone, 16);
  const customerGstin = sanitizeQrText(invoice.customerGstin, 18);
  if (customerName) lines.push(`Customer: ${customerName}`);
  if (customerPhone) lines.push(`Phone: ${customerPhone}`);
  if (customerGstin) lines.push(`GSTIN: ${customerGstin}`);
  return lines.join('\n').slice(0, 420);
}

function BillQrCode({ invoice, className = '' }) {
  const payload = buildBillQrPayload(invoice);
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const margin = 4;
  const viewSize = size + margin * 2;

  return (
    <svg className={`bill-qr ${className}`} viewBox={`0 0 ${viewSize} ${viewSize}`} role="img" aria-label="Bill details QR">
      <rect width={viewSize} height={viewSize} fill="#fff" />
      {Array.from(qr.modules.data).map((value, index) => {
        if (!value) return null;
        const x = (index % size) + margin;
        const y = Math.floor(index / size) + margin;
        return <rect key={index} x={x} y={y} width="1" height="1" fill="#000" />;
      })}
    </svg>
  );
}

function ThermalLogoSlot({ invoice }) {
  const shop = invoice?.shop || {};
  const logoEnabled = shop.thermal_bill_logo_enabled !== false && shop.thermal_bill_logo_enabled !== '0';
  const logoSrc = String(shop.thermal_bill_logo_data_url || '').trim();
  const showLogo = logoEnabled && logoSrc;

  return (
    <div className={`thermal-logo-slot${showLogo ? '' : ' thermal-logo-slot-text'}`}>
      {showLogo ? (
        <img src={logoSrc} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
      ) : (
        <strong className="thermal-logo-fallback">Badizo</strong>
      )}
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

function getExchangeGstRows(items, isInterstate) {
  const normalized = (items || []).map((item) => {
    const unitPrice = toNumber(item.unitPrice || item.sale_price || item.mrp);
    const quantity = toNumber(item.quantity, 1);
    return {
      ...item,
      unitPrice,
      quantity,
      gst_percent: toNumber(item.gst_percent),
      lineTotal: unitPrice * quantity
    };
  });
  return getGstRows(normalized, isInterstate);
}

function getValidFreeItems(items) {
  return (items || []).filter((item) => (
    item.is_free_bonus
    && String(item.product_name || '').trim()
    && toNumber(item.quantity) > 0
  ));
}

function getThermalTerms(invoice, template) {
  const defaultTerms = template.terms || [];
  const customLines = [1, 2, 3, 4]
    .map((lineNo) => String(invoice?.shop?.[`thermal_footer_line_${lineNo}`] || '').trim())
    .filter(Boolean);

  return [
    defaultTerms[0] || 'E. & O. E',
    ...(customLines.length ? customLines : defaultTerms.slice(1))
  ];
}

function StoreHeader({ invoice }) {
  const taxBillLabel = getTaxBillLabel(invoice);
  return (
    <div className="print-store-header">
      <h2>{invoice.shop.shop_name}</h2>
      <p>{invoice.shop.address}</p>
      <p>GSTIN: {invoice.shop.gst_number}</p>
      <p>Phone: {invoice.shop.phone || '-'}</p>
      <SectionLine />
      <strong>GST INVOICE</strong>
      {invoice.isDuplicate && <strong className="duplicate-invoice-label">DUPLICATE INVOICE</strong>}
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
  const saleItems = invoice.items.filter((item) => !item.is_free_bonus);

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
        {saleItems.map((item, index) => {
          const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0);
          const quantityDetail = formatQuantityDetail(item);
          return (
            <React.Fragment key={`${item.barcode}-${index}`}>
              <tr className="thermal-product-row">
                <td colSpan="6"><strong className="thermal-product-name">{index + 1}. {item.product_name}</strong></td>
              </tr>
              <tr className="thermal-hsn-row">
                <td colSpan="6">
                  <span>HSN Code: {item.hsn_code || '-'}</span>
                  {quantityDetail && <span className="thermal-product-detail-gap">{quantityDetail}</span>}
                </td>
              </tr>
              <tr className="thermal-detail-row">
                <td>{item.barcode || '-'}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.mrp)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(discount)}</td>
                <td style={{ textAlign: 'right' }}>{formatPercent(item.gst_percent)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.quantity)}</td>
                <td className="thermal-line-total" style={{ textAlign: 'right' }}>{formatPlainMoney(item.lineTotal)}</td>
              </tr>
              {index < saleItems.length - 1 && (
                <tr className="thermal-product-separator-row">
                  <td colSpan={template.itemColumns.length}></td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function ThermalFreeProducts({ invoice, title }) {
  const saleItems = invoice.items.filter((item) => !item.is_free_bonus);
  const freeItems = getValidFreeItems(invoice.items);
  if (!freeItems.length) return null;

  return (
    <>
      <SectionLine />
      <div className="thermal-free-products-box">
        <div className="print-center"><strong>{title}</strong></div>
        {freeItems.map((freeItem, index) => {
          const trigger = saleItems.find((item) => (
            freeItem.trigger_barcode === item.barcode || freeItem.barcode === item.barcode
          ));
          return (
            <div className="thermal-free-product-line" key={`${freeItem.barcode}-${index}`}>
              <strong>{freeItem.product_name}</strong>
              <span>x {formatQuantityWithUnit(freeItem)} - Free Counter</span>
              {trigger && <em>For: {trigger.product_name}</em>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function ThermalTotals({ invoice }) {
  const saleTotal = toNumber(invoice.totals.saleGrand || invoice.totals.grand);
  const exchangeTotal = toNumber(invoice.totals.exchangeTotal);
  const loyaltyRedeemAmount = toNumber(invoice.totals.loyaltyRedeemAmount);
  const loyaltyRedeemPoints = toNumber(invoice.totals.loyaltyRedeemPoints);
  const paymentSplits = getPaymentSplits(invoice);
  const receivedAmount = getReceivedAmount(invoice);
  const changeAmount = getChangeAmount(invoice);
  return (
    <div className="thermal-total-box">
      <div><span>Billing Total</span><span /><strong>{formatPlainMoney(saleTotal)}</strong></div>
      {exchangeTotal > 0 && <div><span>Exchange Less</span><span /><strong>-{formatPlainMoney(exchangeTotal)}</strong></div>}
      {loyaltyRedeemAmount > 0 && (
        <div><span>Less Loyalty Amount ({formatPlainMoney(loyaltyRedeemPoints)} pts)</span><span /><strong>-{formatPlainMoney(loyaltyRedeemAmount)}</strong></div>
      )}
      <div><span>Bill Amount</span><span /><strong>{formatPlainMoney(invoice.totals.grand)}</strong></div>
      {invoice.paymentMode === 'Mixed' && paymentSplits.map((payment) => (
        <div key={payment.mode}><span>{payment.mode} Paid</span><span /><strong>{formatPlainMoney(payment.amount)}</strong></div>
      ))}
      <div><span>Received Amt ({invoice.paymentMode})</span><span /><strong>{formatPlainMoney(receivedAmount)}</strong></div>
      <div><span>Change Amt</span><span /><strong>{formatPlainMoney(changeAmount)}</strong></div>
    </div>
  );
}

function ExchangeDetails({ invoice, compact = false }) {
  const rows = Array.isArray(invoice.exchangeItems) ? invoice.exchangeItems : [];
  if (!rows.length) return null;
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const gstRows = getExchangeGstRows(rows, isInterstate);

  return (
    <>
      <SectionLine />
      <div className="print-center"><strong>EXCHANGE PRODUCTS</strong></div>
      <table className={`print-table ${compact ? 'thermal-exchange-table' : 'a4-exchange-table'}`}>
        <thead>
          <tr>
            <th>Code</th>
            <th>Product</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, index) => {
            const rate = toNumber(item.unitPrice || item.sale_price || item.mrp);
            const qty = toNumber(item.quantity, 1);
            return (
              <tr key={`${item.barcode}-${index}`}>
                <td>{item.barcode || '-'}</td>
                <td>{item.product_name || '-'}</td>
                <td style={{ textAlign: 'right' }}>{formatQuantityWithUnit(item)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(rate)}</td>
                <td style={{ textAlign: 'right' }}>{formatPlainMoney(rate * qty)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr><th colSpan="4">Exchange Less</th><th style={{ textAlign: 'right' }}>{formatPlainMoney(invoice.totals.exchangeTotal)}</th></tr>
        </tfoot>
      </table>
      {gstRows.length > 0 && (
        <>
          <div className="print-center exchange-gst-title"><strong>Exchange GST Summary</strong></div>
          <table className={`print-table gst-summary-table ${compact ? 'thermal-exchange-gst-table' : 'a4-exchange-gst-table'}`}>
            <thead>
              {isInterstate ? (
                <tr><th>Taxable</th><th>GST%</th><th>IGST</th><th>Total</th></tr>
              ) : (
                <tr><th>Taxable</th><th>GST%</th><th>CGST</th><th>SGST</th><th>Total</th></tr>
              )}
            </thead>
            <tbody>
              {gstRows.map((row) => (
                isInterstate ? (
                  <tr key={row.gst}>
                    <td>{formatPlainMoney(row.taxable)}</td>
                    <td>{formatPercent(row.gst)}</td>
                    <td>{formatPlainMoney(row.igst)}</td>
                    <td>{formatPlainMoney(row.taxable + row.tax)}</td>
                  </tr>
                ) : (
                  <tr key={row.gst}>
                    <td>{formatPlainMoney(row.taxable)}</td>
                    <td>{formatPercent(row.gst)}</td>
                    <td>{formatPlainMoney(row.cgst)}</td>
                    <td>{formatPlainMoney(row.sgst)}</td>
                    <td>{formatPlainMoney(row.taxable + row.tax)}</td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function GstSummary({ invoice }) {
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const rows = getGstRows(invoice.items, isInterstate);
  const taxableTotal = rows.reduce((sum, row) => sum + row.taxable, 0);
  const taxTotal = rows.reduce((sum, row) => sum + row.tax, 0);
  const igstTotal = rows.reduce((sum, row) => sum + row.igst, 0);
  const cgstTotal = rows.reduce((sum, row) => sum + row.cgst, 0);
  const sgstTotal = rows.reduce((sum, row) => sum + row.sgst, 0);

  return (
    <table className="print-table gst-summary-table">
      <thead>
        {isInterstate ? (
          <tr>
            <th>GST%</th>
            <th>Taxable</th>
            <th>IGST</th>
            <th>Tax</th>
            <th>Total</th>
          </tr>
        ) : (
          <tr>
            <th>GST%</th>
            <th>Taxable</th>
            <th>CGST</th>
            <th>SGST</th>
            <th>Tax</th>
          </tr>
        )}
      </thead>
      <tbody>
        {rows.map((row) => {
          return isInterstate ? (
            <tr key={row.gst}>
              <td>{formatPercent(row.gst)}%</td>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.igst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
              <td>{formatPlainMoney(row.total)}</td>
            </tr>
          ) : (
            <tr key={row.gst}>
              <td>{formatPercent(row.gst)}%</td>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPlainMoney(row.cgst)}</td>
              <td>{formatPlainMoney(row.sgst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          );
        })}
        <tr className="gst-summary-total-row">
          {isInterstate ? (
            <>
              <td>Total</td>
              <td>{formatPlainMoney(taxableTotal)}</td>
              <td>{formatPlainMoney(igstTotal)}</td>
              <td>{formatPlainMoney(taxTotal)}</td>
              <td>{formatPlainMoney(rows.reduce((sum, row) => sum + row.total, 0))}</td>
            </>
          ) : (
            <>
              <td>Total</td>
              <td>{formatPlainMoney(taxableTotal)}</td>
              <td>{formatPlainMoney(cgstTotal)}</td>
              <td>{formatPlainMoney(sgstTotal)}</td>
              <td>{formatPlainMoney(taxTotal)}</td>
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
            <td style={{ textAlign: 'right' }}>{formatQuantityWithUnit(item)}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.unitPrice)}</td>
            <td style={{ textAlign: 'right' }}>{formatPlainMoney(item.taxableRate)}</td>
            <td style={{ textAlign: 'right' }}>{formatPercent(item.gst_percent)}%</td>
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
              <td>{formatPercent(row.gst)}%</td>
              <td>{formatPercent(row.gst)}%</td>
              <td>{formatPlainMoney(row.igst)}</td>
              <td>{formatPlainMoney(row.tax)}</td>
            </tr>
          ) : (
            <tr key={row.gst}>
              <td>{hsn}</td>
              <td>{formatPlainMoney(row.taxable)}</td>
              <td>{formatPercent(row.gst)}%</td>
              <td>{formatPercent(cgstPercent)}%</td>
              <td>{formatPlainMoney(row.cgst)}</td>
              <td>{formatPercent(sgstPercent)}%</td>
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

const A4_FIRST_PAGE_ITEMS = 14;
const A4_CONTINUATION_PAGE_ITEMS = 28;
const A4_LAST_PAGE_ITEMS = 13;

function splitA4Items(items) {
  if (items.length <= A4_FIRST_PAGE_ITEMS) {
    return [{ type: 'single', startIndex: 0, items }];
  }

  const pages = [];
  let cursor = 0;
  pages.push({ type: 'first', startIndex: cursor, items: items.slice(cursor, cursor + A4_FIRST_PAGE_ITEMS) });
  cursor += A4_FIRST_PAGE_ITEMS;

  while (items.length - cursor > A4_LAST_PAGE_ITEMS) {
    const remaining = items.length - cursor;
    const take = Math.min(A4_CONTINUATION_PAGE_ITEMS, remaining - A4_LAST_PAGE_ITEMS);
    pages.push({ type: 'middle', startIndex: cursor, items: items.slice(cursor, cursor + take) });
    cursor += take;
  }

  pages.push({ type: 'last', startIndex: cursor, items: items.slice(cursor) });
  return pages;
}

function A4StoreTitle({ taxBillLabel, pageNo, pageCount }) {
  return (
    <div className="a4-store-title">
      <span>{pageCount > 1 ? `Page ${pageNo} / ${pageCount}` : ''}</span>
      <strong>TAX INVOICE</strong>
      <span>{taxBillLabel}</span>
    </div>
  );
}

function A4StoreTop({ invoice }) {
  const taxBillLabel = getTaxBillLabel(invoice);
  return (
    <div className="a4-store-top">
      <div className="a4-store-shop">
        <div className="a4-store-shop-qr-box">
          <BillQrCode invoice={invoice} className="a4-bill-qr" />
        </div>
        <div className="a4-store-shop-text">
          <strong>{invoice.shop.shop_name}</strong>
          {String(invoice.shop.address || '').split(/\s*\|\s*|\n/).filter(Boolean).map((line) => <span key={line}>{line}</span>)}
          <span>Gst no: {invoice.shop.gst_number}</span>
          <span>Phno {invoice.shop.phone || '-'}</span>
        </div>
      </div>
      <div className="a4-store-meta">
        {invoice.isDuplicate && <><span>Copy</span><strong className="duplicate-invoice-label">DUPLICATE INVOICE</strong></>}
        <span>Invoice No.</span><strong>{invoice.invoiceNo}</strong>
        <span>Date</span><strong>{invoice.date}</strong>
        <span>payment mode</span><strong>{invoice.paymentMode}</strong>
        <span>Transaction ID</span><strong>{invoice.paymentReference || '-'}</strong>
        <span>Counter</span><strong>{invoice.counterNo || '-'}</strong>
        <span>Bill Type</span><strong>{taxBillLabel}</strong>
      </div>
    </div>
  );
}

function A4StoreCustomer({ invoice }) {
  return (
    <div className="a4-store-customer">
      <div>
        <span>Name&nbsp;&nbsp;:</span><strong>{invoice.customerName || ''}</strong>
        <span>Address :</span><strong>{invoice.customerAddress || ''}</strong>
        <span>Phno.&nbsp;&nbsp;:</span><strong>{invoice.customerPhone || ''}</strong>
        <span>GST NO:</span><strong>{invoice.customerGstin || ''}</strong>
      </div>
      <div />
    </div>
  );
}

function A4StoreItemsTable({ rows, freeItems = [], startIndex, blankRowCount = 0 }) {
  return (
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
        {rows.map((item, index) => {
          const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0) * toNumber(item.quantity);
          const itemFreebies = freeItems.filter((freeItem) => freeItem.trigger_barcode === item.barcode || freeItem.barcode === item.barcode);
          return (
            <React.Fragment key={`${item.barcode}-${startIndex + index}`}>
              <tr>
                <td>{startIndex + index + 1}</td>
                <td>{item.barcode || '-'}</td>
                <td><strong>{item.product_name}</strong></td>
                <td>{item.hsn_code || '-'}</td>
                <td>{formatPlainMoney(item.mrp)}</td>
                <td>{formatPlainMoney(discount)}</td>
                <td>{formatPercent(item.gst_percent)}</td>
                <td>{formatQuantityWithUnit(item)}</td>
                <td><strong>{formatPlainMoney(item.lineTotal)}</strong></td>
              </tr>
              {itemFreebies.map((freeItem, freeIndex) => (
                <tr className="a4-free-inline-row" key={`${item.barcode}-free-${freeIndex}`}>
                  <td />
                  <td colSpan="7"><strong>Free:</strong> {freeItem.product_name} x {formatQuantityWithUnit(freeItem)} <span>Issue at Free Counter</span></td>
                  <td />
                </tr>
              ))}
            </React.Fragment>
          );
        })}
        {Array.from({ length: blankRowCount }).map((_, index) => (
          <tr className="a4-store-empty-row" key={`blank-${index}`}><td colSpan="9" /></tr>
        ))}
      </tbody>
    </table>
  );
}

function A4OnePageInvoice({ invoice, template }) {
  const isInterstate = invoice.taxType === 'INTERSTATE';
  const taxBillLabel = getTaxBillLabel(invoice);
  const saleItems = invoice.items.filter((item) => !item.is_free_bonus);
  const freeItems = getValidFreeItems(invoice.items);
  const gstRows = getGstRows(saleItems, isInterstate);
  const bankDetails = getA4BankDetails(invoice.shop, template);
  const qtyTotal = saleItems.reduce((sum, item) => sum + toNumber(item.quantity), 0);
  const billingTotal = toNumber(invoice.totals.grand);
  const saleTotal = toNumber(invoice.totals.saleGrand || invoice.totals.grand);
  const exchangeTotal = toNumber(invoice.totals.exchangeTotal);
  const loyaltyRedeemAmount = toNumber(invoice.totals.loyaltyRedeemAmount);
  const loyaltyRedeemPoints = toNumber(invoice.totals.loyaltyRedeemPoints);
  const receivedAmount = getReceivedAmount(invoice);
  const changeAmount = getChangeAmount(invoice);
  const taxableTotal = gstRows.reduce((sum, row) => sum + row.taxable, 0);
  const sgstTotal = gstRows.reduce((sum, row) => sum + row.sgst, 0);
  const cgstTotal = gstRows.reduce((sum, row) => sum + row.cgst, 0);
  const igstTotal = gstRows.reduce((sum, row) => sum + row.igst, 0);
  const taxTotal = gstRows.reduce((sum, row) => sum + row.tax, 0);
  const totalDiscount = saleItems.reduce((sum, item) => {
    const discount = Math.max(toNumber(item.mrp) - toNumber(item.unitPrice), 0) * toNumber(item.quantity);
    return sum + discount;
  }, 0);
  const exchangeItemCount = Array.isArray(invoice.exchangeItems) ? invoice.exchangeItems.length : 0;
  const bottomReserveRows = exchangeItemCount > 0 || gstRows.length > 2 || freeItems.length > 0 ? 4 : 7;
  const blankRowCount = Math.max(1, bottomReserveRows - saleItems.length);
  const pages = splitA4Items(saleItems);
  const isMultiPage = pages.length > 1;

  const renderBottom = () => (
    <>
      <ExchangeDetails invoice={invoice} />
      <div className="a4-store-discount">You Have Gained Discount Amount Rs. <strong>{formatPlainMoney(totalDiscount)}</strong></div>
      <div className="a4-store-words">Total Amount In words................................ <strong>INR {amountInWords(invoice.totals.grand)}</strong></div>

      <div className="a4-store-bottom">
        <div className="a4-store-bank">
          <strong>Bank Details</strong>
          {bankDetails.map(([label, value]) => <span key={label}>{label}: <b>{value}</b></span>)}
        </div>
        <div className="a4-store-right-bottom">
          <div className="a4-store-payment-summary">
            <div><span>Billing Total</span><strong>{formatPlainMoney(saleTotal)}</strong></div>
            {exchangeTotal > 0 && <div><span>Exchange Less</span><strong>-{formatPlainMoney(exchangeTotal)}</strong></div>}
            {loyaltyRedeemAmount > 0 && (
              <div><span>Less Loyalty Amount ({formatPlainMoney(loyaltyRedeemPoints)} pts)</span><strong>-{formatPlainMoney(loyaltyRedeemAmount)}</strong></div>
            )}
            <div><span>Bill Amount</span><strong>{formatPlainMoney(billingTotal)}</strong></div>
            <div><span>Qty Total</span><strong>{formatPlainMoney(qtyTotal)}</strong></div>
            {invoice.paymentMode === 'Mixed' && getPaymentSplits(invoice).map((payment) => (
              <div key={payment.mode}><span>{payment.mode} Paid</span><strong>{formatPlainMoney(payment.amount)}</strong></div>
            ))}
            <div><span>Received Amount</span><strong>{formatPlainMoney(receivedAmount)}</strong></div>
            <div><span>Given Change Amount</span><strong>{formatPlainMoney(changeAmount)}</strong></div>
          </div>
          <table className="a4-store-gst">
            <caption>{isInterstate ? 'IGST Summary' : 'GST Summary'}</caption>
            <thead><tr><th>GST%</th><th>SGST Rs</th><th>CGST Rs</th><th>IGST Rs</th><th>Taxable</th><th>Tax Amt</th><th>Total</th></tr></thead>
            <tbody>
              {gstRows.map((row) => (
                <tr key={row.gst}>
                  <td>{formatPercent(row.gst)}</td>
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
    </>
  );

  if (isMultiPage) {
    return (
      <div className={`print-invoice a4-multi-page ${isInterstate ? 'a4-igst-invoice' : 'a4-gst-invoice'}`}>
        {pages.map((page, index) => {
          const pageNo = index + 1;
          const isFirst = index === 0;
          const isLast = index === pages.length - 1;
          const lastPageBlankRows = isLast ? Math.max(1, A4_LAST_PAGE_ITEMS - page.items.length) : 0;
          return (
            <div className={`a4-paper a4-page-sheet a4-store-invoice ${isLast ? 'a4-last-page' : ''}`} key={`${page.type}-${page.startIndex}`}>
              <A4StoreTitle taxBillLabel={taxBillLabel} pageNo={pageNo} pageCount={pages.length} />
              {isFirst ? (
                <>
                  <A4StoreTop invoice={invoice} />
                  <A4StoreCustomer invoice={invoice} />
                </>
              ) : (
                <div className="a4-continuation-header">
                  <strong>{invoice.shop.shop_name}</strong>
                  <span>Invoice No. {invoice.invoiceNo}</span>
                  <span>Date {invoice.date}</span>
                  <span>Continued from previous page</span>
                </div>
              )}
              <A4StoreItemsTable rows={page.items} freeItems={freeItems} startIndex={page.startIndex} blankRowCount={lastPageBlankRows} />
              {!isLast && <div className="a4-continue-note">Continued on next page...</div>}
              {isLast && renderBottom()}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`print-invoice a4-paper a4-one-page a4-store-invoice ${isInterstate ? 'a4-igst-invoice' : 'a4-gst-invoice'}`}>
      <A4StoreTitle taxBillLabel={taxBillLabel} pageNo={1} pageCount={1} />
      <A4StoreTop invoice={invoice} />
      <A4StoreCustomer invoice={invoice} />
      <A4StoreItemsTable rows={saleItems} freeItems={freeItems} startIndex={0} blankRowCount={blankRowCount} />
      {renderBottom()}
    </div>
  );
}

function renderSection(section, invoice, template) {
  if (!section.enabled) return null;

  switch (section.type) {
    case 'thermalLogo':
      return <ThermalLogoSlot invoice={invoice} />;
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
      return <ThermalFreeProducts invoice={invoice} title={section.title} />;
    case 'thermalTotals':
      return <div className="thermal-summary-section thermal-total-summary"><SectionLine /><div className="print-center thermal-summary-title"><strong>Total Summary</strong></div><ThermalTotals invoice={invoice} /></div>;
    case 'amountWords':
      return <><SectionLine /><p><strong>({amountInWords(invoice.totals.grand)})</strong></p></>;
    case 'discountLine':
      return invoice.totals.discount > 0 ? <><SectionLine /><div className="print-row print-discount-row"><span>You Have Gained Discount Amount</span><strong>{formatPlainMoney(invoice.totals.discount)}</strong></div></> : null;
    case 'gstSummary':
      return <div className="thermal-summary-section thermal-gst-summary"><SectionLine /><div className="print-center thermal-summary-title"><strong>{invoice.taxType === 'INTERSTATE' ? 'IGST Summary' : 'GST Summary'}</strong></div><GstSummary invoice={invoice} /></div>;
    case 'terms': {
      const terms = getThermalTerms(invoice, template);
      return <><SectionLine /><div className="print-terms">{terms.map((term, index) => <p key={`${index}-${term}`}>{term}</p>)}</div></>;
    }
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
      <div className="thermal-brand-edge">Badizo</div>
      {template.sections.map((section) => (
        <React.Fragment key={section.id}>
          {renderSection(section, invoice, template)}
        </React.Fragment>
      ))}
      <SectionLine />
      <div className="thermal-bill-qr-wrap">
        <BillQrCode invoice={invoice} className="thermal-bill-qr" />
        <strong>Scan Bill Details</strong>
      </div>
      <ExchangeDetails invoice={invoice} compact />
    </div>
  );
}
