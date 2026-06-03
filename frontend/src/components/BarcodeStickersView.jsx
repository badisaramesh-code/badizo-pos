import React, { useEffect, useMemo, useState } from 'react';
import { fetchBarcodeTemplate, generateBarcodePrn, searchProducts } from '../api/client';

const TEMPLATE_OPTIONS = [
  {
    name: 'tsc-244-pro-50x50-two-up.prn',
    label: '50 x 50 mm Two-Up',
    printer: 'TSC-244-Pro',
    help: 'One printer row prints two 50x50mm stickers.'
  },
  {
    name: 'tsc-244-1-33x25-single.prn',
    label: '33 x 25 mm Product Sticker',
    printer: 'TSC 244-1',
    help: 'Small product label with product, barcode, MRP, price, tax note, qty, shop, address, phone.'
  },
  {
    name: 'tsc-244-2-jewellery-100x15-tail.prn',
    label: '100 x 15 mm Jewellery Tail',
    printer: 'TSC 244-2',
    help: '65mm printable tail split into price side and shop/address side.'
  }
];

function todayStickerDate() {
  return new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).replace(/ /g, '-').toUpperCase();
}

function moneyTwoDecimals(value) {
  const amount = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount)) return String(value ?? '');
  return amount.toFixed(2);
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export default function BarcodeStickersView() {
  const [templateName, setTemplateName] = useState(TEMPLATE_OPTIONS[0].name);
  const [form, setForm] = useState({
    product_name: 'AASIRWADH FARM AATA',
    barcode: '01234567890',
    mrp: '0000.00',
    sale_price: '0000.00',
    pkd_date: todayStickerDate(),
    qty: '000',
    unit: 'Nos/kg/gms',
    company: 'hyper fresh mart llp',
    address_line_1: 'H.NO: 3-41, Behind GV Mall, Morisetti Vari street',
    address_line_2: 'Sathupally, Khammam(dt), Telangana-507303',
    customer_care: 'Customer care: 08760 295000 - hyperfreshmart@gmail.com',
    phone: '08760 295000',
    stickerCount: '2'
  });
  const [templateInfo, setTemplateInfo] = useState(null);
  const [prn, setPrn] = useState('');
  const [outputInfo, setOutputInfo] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const selectedTemplate = TEMPLATE_OPTIONS.find((option) => option.name === templateName) || TEMPLATE_OPTIONS[0];

  useEffect(() => {
    setPrn('');
    setOutputInfo(null);
    loadTemplate();
  }, [templateName]);

  async function loadTemplate() {
    try {
      const result = await fetchBarcodeTemplate(templateName);
      setTemplateInfo(result);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load PRN template.');
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function loadProductByCode() {
    const code = form.barcode.trim();
    if (!code) {
      setErrorMessage('Enter barcode or product code first.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('');

    try {
      const products = await searchProducts(code);
      const product = products[0];
      if (!product) {
        setErrorMessage('Product not found for this barcode/product code.');
        return;
      }

    setForm((current) => ({
      ...current,
      product_name: String(product.product_name || current.product_name).toUpperCase(),
        barcode: product.barcode || current.barcode,
        mrp: moneyTwoDecimals(product.mrp ?? current.mrp),
        sale_price: moneyTwoDecimals(product.sale_price ?? current.sale_price),
        unit: product.unit_type || current.unit,
        qty: current.qty || '1'
      }));
      setStatusMessage(`${product.product_name} loaded for sticker.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load product from barcode/product code.');
    }
  }

  async function generatePrn() {
    setErrorMessage('');
    setStatusMessage('');
    try {
      const result = await generateBarcodePrn({
        ...form,
        mrp: moneyTwoDecimals(form.mrp),
        sale_price: moneyTwoDecimals(form.sale_price),
        template_name: templateName
      });
      setPrn(result.prn || '');
      setOutputInfo(result);
      setStatusMessage(`PRN generated: ${result.output_name}. Printer: ${selectedTemplate.printer}`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to generate PRN.');
    }
  }

  function copyPrn() {
    if (!prn) return;
    window.navigator.clipboard?.writeText(prn);
    setStatusMessage('PRN copied. Save/send it to the TSC printer.');
  }

  const stickerRows = useMemo(() => {
    const fields = [
      ['product_name', 'Product Name'],
      ['barcode', 'Barcode 128'],
      ['mrp', 'MRP'],
      ['sale_price', 'Price'],
      ['pkd_date', 'Packed Date'],
      ['qty', 'Qty'],
      ['unit', 'Unit'],
      ['stickerCount', 'Sticker Count']
    ];
    return fields;
  }, []);

  return (
    <div className="barcode-grid">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Barcode Sticker Print</h2></div>
        <div className="panel-body form-stack">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          {outputInfo?.output_path && (
            <div className="file-path-box">{outputInfo.output_path}</div>
          )}

          <label>
            <span className="field-label">Sticker Size / PRN Template</span>
            <select className="select" value={templateName} onChange={(event) => setTemplateName(event.target.value)}>
              {TEMPLATE_OPTIONS.map((option) => (
                <option key={option.name} value={option.name}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="change-box">
            Printer Name: <strong>{selectedTemplate.printer}</strong> | {selectedTemplate.help}
          </div>

          {stickerRows.map(([field, label]) => (
            <label key={field}>
              <span className="field-label">{label}</span>
              <input
                className="field"
                value={form[field]}
                onChange={(event) => update(field, event.target.value)}
                onKeyDown={(event) => {
                  if (field === 'barcode' && event.key === 'Enter') {
                    event.preventDefault();
                    loadProductByCode();
                  }
                }}
              />
            </label>
          ))}

          <button className="secondary-button" type="button" onClick={loadProductByCode}>Load Product From Code</button>

          <label>
            <span className="field-label">Store Name</span>
            <input className="field" value={form.company} onChange={(event) => update('company', event.target.value)} />
          </label>
          <label>
            <span className="field-label">Address Line 1</span>
            <input className="field" value={form.address_line_1} onChange={(event) => update('address_line_1', event.target.value)} />
          </label>
          <label>
            <span className="field-label">Address Line 2</span>
            <input className="field" value={form.address_line_2} onChange={(event) => update('address_line_2', event.target.value)} />
          </label>
          <label>
            <span className="field-label">Phone Number</span>
            <input className="field" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
          </label>
          <label>
            <span className="field-label">Customer Care Line</span>
            <input className="field" value={form.customer_care} onChange={(event) => update('customer_care', event.target.value)} />
          </label>

          <button className="primary-button" type="button" onClick={generatePrn}>Generate PRN</button>
          <button className="secondary-button" type="button" onClick={() => prn && downloadTextFile(prn, outputInfo?.output_name || 'barcode-sticker.prn')} disabled={!prn}>Download PRN</button>
          <button className="secondary-button" type="button" onClick={copyPrn} disabled={!prn}>Copy PRN</button>

          <div className="change-box">
            Generate PRN, then send the generated file from barcode/output to the selected TSC printer. Template files stay external in barcode/templates for store-wise adjustment.
          </div>

          {templateInfo && (
            <div className="change-box barcode-template-path-box">
              <span>Template file:</span>
              <strong>{templateInfo.template_path}</strong>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">{selectedTemplate.label} Preview and TSC PRN</h2></div>
        <div className="panel-body barcode-preview-wrap">
          <StickerPreview form={form} templateName={templateName} />
          <pre className="prn-output">{prn || `Click Generate PRN to create TSC command file from barcode/templates/${templateName}`}</pre>
        </div>
      </section>
    </div>
  );
}

function StickerPreview({ form, templateName }) {
  if (templateName === 'tsc-244-1-33x25-single.prn') {
    return (
      <div className="sticker-preview sticker-preview-33x25">
        <strong className="sticker-product">{form.product_name}</strong>
        <div className="barcode-bars small"></div>
        <div className="mono sticker-code">{form.barcode}</div>
        <div className="sticker-price-row"><strong>MRP {form.mrp}</strong><strong>Price {form.sale_price}</strong></div>
        <div className="tax-note">Inclusive of all taxes</div>
        <div className="sticker-meta-row">Qty: {form.qty} {form.unit}</div>
        <div className="sticker-divider"></div>
        <strong className="sticker-store">{form.company}</strong>
        <small>{form.address_line_1}<br />Ph: {form.phone}</small>
      </div>
    );
  }

  if (templateName === 'tsc-244-2-jewellery-100x15-tail.prn') {
    const shortName = String(form.product_name || '').toUpperCase().slice(0, 25);
    return (
      <div className="sticker-preview sticker-preview-jewellery">
        <div className="jewellery-side">
          <strong className="jewellery-product-name">{shortName}</strong>
          <strong>MRP {form.mrp}</strong>
          <strong>Price {form.sale_price}</strong>
          <div className="barcode-bars jewellery-bars"></div>
          <span className="mono">{form.barcode}</span>
        </div>
        <div className="jewellery-side shop-side">
          <strong>{form.company}</strong>
          <span>{form.address_line_1}</span>
          <span>{form.address_line_2}</span>
          <span>Ph: {form.phone}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sticker-preview sticker-preview-wide">
      <strong className="sticker-product">{form.product_name}</strong>
      <div className="barcode-bars"></div>
      <div className="mono sticker-code">{form.barcode}</div>
      <div className="sticker-price-row"><strong>MRP Rs: {form.mrp}</strong><strong>Price Rs: {form.sale_price}</strong></div>
      <div>[ Inclusive of all taxes ]</div>
      <div className="sticker-price-row sticker-meta-row"><span>Pkd. Date: {form.pkd_date}</span><span>Qty: {form.qty} {form.unit}</span></div>
      <div className="sticker-divider"></div>
      <strong className="sticker-store">{form.company}</strong>
      <small>{form.address_line_1}<br />{form.address_line_2}<br />{form.customer_care}</small>
    </div>
  );
}
