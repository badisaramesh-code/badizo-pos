import React, { useEffect, useMemo, useState } from 'react';
import { fetchRecentInwards, saveInwardEntry, searchProducts } from '../api/client';
import { formatMoney, toNumber } from '../utils/money';

const blankLine = {
  product: '',
  barcode: '',
  hsn_code: '',
  gst_percent: '5',
  price: '',
  discount: '',
  scheme: '',
  qty: ''
};

const blankSupplier = {
  name: '',
  address: '',
  gstin: '',
  phone: '',
  invoice_no: '',
  invoice_date: ''
};

export default function InwardEntryView() {
  const [supplier, setSupplier] = useState(blankSupplier);
  const [lines, setLines] = useState([blankLine]);
  const [recentInwards, setRecentInwards] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadRecentInwards();
  }, []);

  const totals = useMemo(() => lines.reduce((acc, line) => {
    const gross = toNumber(line.price) * toNumber(line.qty);
    const discount = gross * (toNumber(line.discount) / 100);
    const taxable = gross - discount;
    const gst = taxable * (toNumber(line.gst_percent) / 100);

    return {
      qty: acc.qty + toNumber(line.qty),
      taxable: acc.taxable + taxable,
      gst: acc.gst + gst,
      total: acc.total + taxable + gst
    };
  }, { qty: 0, taxable: 0, gst: 0, total: 0 }), [lines]);

  async function loadRecentInwards() {
    try {
      setRecentInwards(await fetchRecentInwards());
    } catch (err) {
      setRecentInwards([]);
    }
  }

  function updateSupplier(field, value) {
    setSupplier((current) => ({ ...current, [field]: value }));
  }

  function updateLine(index, field, value) {
    setLines((current) => current.map((line, lineIndex) => (
      lineIndex === index ? { ...line, [field]: value } : line
    )));
  }

  function addRow() {
    setLines((current) => [...current, { ...blankLine }]);
  }

  function removeRow(index) {
    setLines((current) => (current.length === 1 ? [{ ...blankLine }] : current.filter((_, lineIndex) => lineIndex !== index)));
  }

  async function fillProduct(index) {
    const line = lines[index];
    const query = line.barcode || line.product;
    if (!query || query.trim().length < 3) {
      setErrorMessage('Enter at least 3 letters or barcode digits before product lookup.');
      return;
    }

    try {
      const results = await searchProducts(query.trim());
      const product = results[0];
      if (!product) {
        setErrorMessage('Product not found. It will be created from this inward line if saved.');
        return;
      }

      setLines((current) => current.map((currentLine, lineIndex) => (
        lineIndex === index ? {
          ...currentLine,
          product: product.product_name,
          barcode: product.barcode,
          hsn_code: product.hsn_code,
          gst_percent: String(product.gst_percent),
          price: currentLine.price || String(product.sale_price || product.mrp || 0)
        } : currentLine
      )));
      setErrorMessage('');
    } catch (err) {
      setErrorMessage('Unable to lookup product.');
    }
  }

  async function handleSave() {
    setStatusMessage('');
    setErrorMessage('');
    setIsSaving(true);

    try {
      const result = await saveInwardEntry({ supplier, lines });
      setStatusMessage(`Inward ${result.inward_no} saved. Stock updated for ${result.item_count} products.`);
      setSupplier(blankSupplier);
      setLines([{ ...blankLine }]);
      await loadRecentInwards();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save inward entry.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="form-stack">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">New Inward Entry (Purchase)</h2></div>
        <div className="panel-body form-stack">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}

          <div className="customer-grid">
            {Object.entries({
              name: 'Sundry Creditor Name',
              address: 'Address',
              gstin: 'GST Number',
              phone: 'Phone Number',
              invoice_no: 'Supplier Invoice No',
              invoice_date: 'Invoice Date'
            }).map(([field, label]) => (
              <label key={field}>
                <span className="field-label">{label}</span>
                <input
                  className="field"
                  type={field === 'invoice_date' ? 'date' : 'text'}
                  value={supplier[field]}
                  onChange={(event) => updateSupplier(field, field === 'gstin' ? event.target.value.toUpperCase() : event.target.value)}
                />
              </label>
            ))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="product-table">
              <thead>
                <tr>
                  <th>S.No</th><th>Product</th><th>Barcode</th><th>HSN</th><th>GST%</th><th>Price</th><th>Discount%</th><th>Scheme</th><th>Qty</th><th>Amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const gross = toNumber(line.price) * toNumber(line.qty);
                  const discount = gross * (toNumber(line.discount) / 100);
                  const taxable = gross - discount;
                  const gst = taxable * (toNumber(line.gst_percent) / 100);
                  const amount = taxable + gst;

                  return (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td><input className="field" value={line.product} onChange={(event) => updateLine(index, 'product', event.target.value)} /></td>
                      <td>
                        <div className="inline-field-action">
                          <input className="field" value={line.barcode} onChange={(event) => updateLine(index, 'barcode', event.target.value.toUpperCase())} />
                          <button className="secondary-button" type="button" onClick={() => fillProduct(index)}>Find</button>
                        </div>
                      </td>
                      <td><input className="field" value={line.hsn_code} onChange={(event) => updateLine(index, 'hsn_code', event.target.value)} /></td>
                      <td>
                        <select className="select" value={line.gst_percent} onChange={(event) => updateLine(index, 'gst_percent', event.target.value)}>
                          <option value="0">0%</option>
                          <option value="3">3%</option>
                          <option value="5">5%</option>
                          <option value="12">12%</option>
                          <option value="18">18%</option>
                          <option value="40">40%</option>
                        </select>
                      </td>
                      <td><input className="field" type="number" min="0" step="0.01" value={line.price} onChange={(event) => updateLine(index, 'price', event.target.value)} /></td>
                      <td><input className="field" type="number" min="0" step="0.01" value={line.discount} onChange={(event) => updateLine(index, 'discount', event.target.value)} /></td>
                      <td><input className="field" value={line.scheme} onChange={(event) => updateLine(index, 'scheme', event.target.value)} /></td>
                      <td><input className="field" type="number" min="0" step="0.01" value={line.qty} onChange={(event) => updateLine(index, 'qty', event.target.value)} /></td>
                      <td><strong>{formatMoney(amount)}</strong></td>
                      <td><button className="danger-button" onClick={() => removeRow(index)}>Del</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="summary-band">
            <span>Items: <strong>{lines.length}</strong></span>
            <span>Total Qty: <strong>{totals.qty}</strong></span>
            <span>Taxable: <strong>{formatMoney(totals.taxable)}</strong></span>
            <span>GST: <strong>{formatMoney(totals.gst)}</strong></span>
            <span>Grand Total: <strong>{formatMoney(totals.total)}</strong></span>
            <button className="secondary-button" onClick={addRow}>Add Row</button>
            <button className="primary-button compact-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Inward'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Recent Inward Entries</h2></div>
        <div className="panel-body">
          <table className="history-table">
            <thead>
              <tr><th>Inward No</th><th>Supplier</th><th>Invoice</th><th>Items</th><th>Qty</th><th>Total</th><th>Created</th></tr>
            </thead>
            <tbody>
              {recentInwards.length === 0 ? (
                <tr><td colSpan="7">No inward entries saved yet.</td></tr>
              ) : (
                recentInwards.map((entry) => (
                  <tr key={entry.inward_no}>
                    <td className="mono">{entry.inward_no}</td>
                    <td>{entry.supplier_name}</td>
                    <td>{entry.supplier_invoice_no || '-'}</td>
                    <td>{entry.item_count}</td>
                    <td>{entry.total_qty}</td>
                    <td><strong>{formatMoney(entry.grand_total)}</strong></td>
                    <td>{entry.created_at ? new Date(entry.created_at).toLocaleString() : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
