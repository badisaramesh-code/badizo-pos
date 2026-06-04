import React, { useEffect, useMemo, useState } from 'react';
import { approveSensitiveBillingMode, fetchBarcodeTemplate, generateBarcodePrn, searchProducts } from '../api/client';

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

const BARCODE_STORE_SETTINGS_KEY = 'badizo_barcode_store_settings';
const DEFAULT_STORE_SETTINGS = {
  company: 'hyper fresh mart llp',
  address_line_1: 'H.NO: 3-41, Behind GV Mall, Morisetti Vari street',
  address_line_2: 'Sathupally, Khammam(dt), Telangana-507303',
  customer_care: 'Customer care: 08760 295000 - hyperfreshmart@gmail.com',
  phone: '08760 295000'
};

function loadBarcodeStoreSettings() {
  try {
    const raw = window.localStorage.getItem(BARCODE_STORE_SETTINGS_KEY);
    if (!raw) return DEFAULT_STORE_SETTINGS;
    return { ...DEFAULT_STORE_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    return DEFAULT_STORE_SETTINGS;
  }
}

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
  const savedStoreSettings = loadBarcodeStoreSettings();
  const [screenMode, setScreenMode] = useState('print');
  const [templateName, setTemplateName] = useState(TEMPLATE_OPTIONS[0].name);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [setupPassword, setSetupPassword] = useState({ username: '', password: '' });
  const [form, setForm] = useState({
    product_name: '',
    barcode: '',
    mrp: '0.00',
    sale_price: '0.00',
    pkd_date: todayStickerDate(),
    qty: '1',
    unit: 'Nos',
    company: savedStoreSettings.company,
    address_line_1: savedStoreSettings.address_line_1,
    address_line_2: savedStoreSettings.address_line_2,
    customer_care: savedStoreSettings.customer_care,
    phone: savedStoreSettings.phone,
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
    if (screenMode === 'setup' && setupUnlocked) {
      loadTemplate();
    } else {
      setTemplateInfo(null);
    }
  }, [templateName, screenMode, setupUnlocked]);

  async function loadTemplate() {
    try {
      const result = await fetchBarcodeTemplate(templateName);
      setTemplateInfo(result);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load PRN template.');
    }
  }

  async function unlockTemplateSetup(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    try {
      await approveSensitiveBillingMode({
        username: setupPassword.username,
        password: setupPassword.password,
        reason: 'Barcode PRN template setup'
      });
      setSetupUnlocked(true);
      setSetupPassword({ username: '', password: '' });
      setStatusMessage('PRN Template Setup unlocked.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Admin password required for PRN Template Setup.');
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function saveStoreSettings() {
    const settings = {
      company: form.company,
      address_line_1: form.address_line_1,
      address_line_2: form.address_line_2,
      customer_care: form.customer_care,
      phone: form.phone
    };
    window.localStorage.setItem(BARCODE_STORE_SETTINGS_KEY, JSON.stringify(settings));
    setStatusMessage('PRN store details saved. Refresh tarvata kuda same details vastayi.');
    setErrorMessage('');
  }

  function applyProduct(product) {
    setForm((current) => ({
      ...current,
      product_name: String(product.product_name || '').toUpperCase(),
      barcode: product.barcode || current.barcode,
      mrp: moneyTwoDecimals(product.mrp ?? 0),
      sale_price: moneyTwoDecimals(product.sale_price ?? product.mrp ?? 0),
      pkd_date: todayStickerDate(),
      qty: '1',
      unit: product.unit_type || 'Nos'
    }));
    setSearchQuery(product.barcode || product.product_name || '');
    setSuggestions([]);
    setPrn('');
    setOutputInfo(null);
    setStatusMessage(`${product.product_name} loaded for sticker.`);
    setErrorMessage('');
  }

  async function searchAndLoadProduct(query = searchQuery) {
    const cleaned = String(query || '').trim();
    if (!cleaned) {
      setErrorMessage('Scan barcode or type product name first.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('');

    try {
      const products = await searchProducts(cleaned);
      if (!products.length) {
        setErrorMessage('Product not found for this barcode/product name.');
        return;
      }
      if (products.length === 1) {
        applyProduct(products[0]);
        return;
      }
      const exact = products.find((product) => (
        String(product.barcode || '').toUpperCase() === cleaned.toUpperCase()
        || String(product.product_code || '').toUpperCase() === cleaned.toUpperCase()
      ));
      if (exact) {
        applyProduct(exact);
        return;
      }
      setSuggestions(products.slice(0, 8));
      setStatusMessage(`${products.length} products found. Select one product.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load product from barcode/product name.');
    }
  }

  async function generatePrn() {
    setErrorMessage('');
    setStatusMessage('');
    if (!form.barcode || !form.product_name) {
      setErrorMessage('Scan/search a product before printing sticker.');
      return;
    }
    try {
      const result = await generateBarcodePrn({
        ...form,
        mrp: moneyTwoDecimals(form.mrp),
        sale_price: moneyTwoDecimals(form.sale_price),
        template_name: templateName
      });
      setPrn(result.prn || '');
      setOutputInfo(result);
      setStatusMessage(`Sticker print file ready and report saved: ${result.output_name}. Printer: ${result.printer_name || selectedTemplate.printer}`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to generate PRN.');
    }
  }

  function copyPrn() {
    if (!prn) return;
    window.navigator.clipboard?.writeText(prn);
    setStatusMessage('PRN copied.');
  }

  function openStickerPrint() {
    setScreenMode('print');
    setSetupUnlocked(false);
    setSetupPassword({ username: '', password: '' });
    setTemplateInfo(null);
    setPrn('');
    setOutputInfo(null);
    setErrorMessage('');
    setStatusMessage('');
  }

  function openTemplateSetup() {
    setScreenMode('setup');
    setSetupUnlocked(false);
    setSetupPassword({ username: '', password: '' });
    setTemplateInfo(null);
    setPrn('');
    setOutputInfo(null);
    setErrorMessage('');
    setStatusMessage('');
  }

  const stickerRows = useMemo(() => {
    const fields = [
      ['product_name', 'Product Name'],
      ['barcode', 'Barcode 128'],
      ['mrp', 'MRP'],
      ['sale_price', 'Price'],
      ['pkd_date', 'Packed Date'],
      ['qty', 'Qty'],
      ['unit', 'Unit']
    ];
    return fields;
  }, []);

  return (
    <div className="form-stack">
      <section className="panel barcode-screen-switcher">
        <div className="panel-body barcode-mode-row">
          <button
            className={`segment-button ${screenMode === 'print' ? 'active' : ''}`}
            type="button"
            onClick={openStickerPrint}
          >
            Sticker Print
          </button>
          <button
            className={`segment-button ${screenMode === 'setup' ? 'active' : ''}`}
            type="button"
            onClick={openTemplateSetup}
          >
            PRN Template Setup
          </button>
        </div>
      </section>

      {screenMode === 'print' ? (
      <div className="barcode-grid barcode-print-grid">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Sticker Print</h2></div>
        <div className="panel-body form-stack">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          {outputInfo?.output_path && (
            <div className="file-path-box">{outputInfo.output_path}</div>
          )}

          <label>
            <span className="field-label">Sticker Size</span>
            <select className="select" value={templateName} onChange={(event) => setTemplateName(event.target.value)}>
              {TEMPLATE_OPTIONS.map((option) => (
                <option key={option.name} value={option.name}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="change-box">
            Printer Name: <strong>{selectedTemplate.printer}</strong> | {selectedTemplate.help}
          </div>

          <label>
            <span className="field-label">Scan Barcode / Search Product Name</span>
            <input
              className="field"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSuggestions([]);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  searchAndLoadProduct();
                }
              }}
              placeholder="Scan barcode or type product name"
            />
          </label>
          <button className="secondary-button" type="button" onClick={() => searchAndLoadProduct()}>Load Product</button>

          {suggestions.length > 0 && (
            <div className="barcode-product-suggestions">
              {suggestions.map((product) => (
                <button key={product.barcode} type="button" onClick={() => applyProduct(product)}>
                  <span className="mono">{product.barcode}</span>
                  <strong>{product.product_name}</strong>
                  <span>{moneyTwoDecimals(product.sale_price)}</span>
                </button>
              ))}
            </div>
          )}

          {stickerRows.map(([field, label]) => (
            <label key={field}>
              <span className="field-label">{label}</span>
              <input
                className="field"
                value={form[field]}
                readOnly={!['product_name', 'barcode'].includes(field)}
                onChange={(event) => {
                  if (field === 'product_name') {
                    const value = event.target.value.toUpperCase();
                    update(field, value);
                    setSearchQuery(value);
                    setSuggestions([]);
                  } else if (field === 'barcode') {
                    const value = event.target.value.toUpperCase();
                    update(field, value);
                    setSearchQuery(value);
                    setSuggestions([]);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && ['product_name', 'barcode'].includes(field)) {
                    event.preventDefault();
                    searchAndLoadProduct(form[field]);
                  }
                }}
              />
            </label>
          ))}

          <label>
            <span className="field-label">How many stickers?</span>
            <input
              className="field"
              type="number"
              min="1"
              step="1"
              value={form.stickerCount}
              onChange={(event) => update('stickerCount', event.target.value)}
            />
          </label>

          <label>
            <span className="field-label">Store Name</span>
            <input className="field" value={form.company} readOnly />
          </label>
          <label>
            <span className="field-label">Address Line 1</span>
            <input className="field" value={form.address_line_1} readOnly />
          </label>
          <label>
            <span className="field-label">Address Line 2</span>
            <input className="field" value={form.address_line_2} readOnly />
          </label>
          <label>
            <span className="field-label">Phone Number</span>
            <input className="field" value={form.phone} readOnly />
          </label>
          <label>
            <span className="field-label">Customer Care Line</span>
            <input className="field" value={form.customer_care} readOnly />
          </label>

          <button className="primary-button" type="button" onClick={generatePrn}>Print Stickers</button>
          <button className="secondary-button" type="button" onClick={() => prn && downloadTextFile(prn, outputInfo?.output_name || 'barcode-sticker.prn')} disabled={!prn}>Download Print File</button>

          <div className="change-box">
            Scan/search product, enter only sticker count, then print/download the generated file from barcode/output.
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">{selectedTemplate.label} Preview</h2></div>
        <div className="panel-body barcode-preview-wrap">
          <StickerPreview form={form} templateName={templateName} />
          <div className="change-box">
            Output printer: <strong>{selectedTemplate.printer}</strong>. Print history is saved in Reports - Barcode Stickers.
          </div>
        </div>
      </section>
    </div>
      ) : (
      <div className="barcode-grid">
        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">PRN Template Setup</h2></div>
          <div className="panel-body form-stack">
            {errorMessage && <div className="alert-box">{errorMessage}</div>}
            {statusMessage && <div className="change-box">{statusMessage}</div>}

            {!setupUnlocked ? (
              <form className="form-stack" onSubmit={unlockTemplateSetup}>
                <div className="alert-box">
                  PRN template setup is for admin/server use only. Unlock this screen, create/check the size template, keep the PRN template in the system folder, then close this screen.
                </div>
                <label>
                  <span className="field-label">Admin Username</span>
                  <input className="field" value={setupPassword.username} onChange={(event) => setSetupPassword((current) => ({ ...current, username: event.target.value }))} autoComplete="username" />
                </label>
                <label>
                  <span className="field-label">Password</span>
                  <input className="field" type="password" value={setupPassword.password} onChange={(event) => setSetupPassword((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" />
                </label>
                <button className="primary-button" type="submit">Unlock PRN Setup</button>
              </form>
            ) : (
              <>
                <label>
                  <span className="field-label">Sticker Size / Template</span>
                  <select className="select" value={templateName} onChange={(event) => setTemplateName(event.target.value)}>
                    {TEMPLATE_OPTIONS.map((option) => (
                      <option key={option.name} value={option.name}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="change-box">
                  Printer Name: <strong>{selectedTemplate.printer}</strong> | {selectedTemplate.help}
                </div>
                <div className="change-box">
                  Edit these sample values only for PRN template testing. Store sticker print screen will still auto-fill product data.
                </div>
                <div className="two-column-form">
                  {stickerRows.map(([field, label]) => (
                    <label key={field}>
                      <span className="field-label">{label}</span>
                      <input
                        className="field"
                        value={form[field]}
                        onChange={(event) => update(field, field === 'product_name' ? event.target.value.toUpperCase() : event.target.value)}
                      />
                    </label>
                  ))}
                  <label>
                    <span className="field-label">How many test stickers?</span>
                    <input
                      className="field"
                      type="number"
                      min="1"
                      step="1"
                      value={form.stickerCount}
                      onChange={(event) => update('stickerCount', event.target.value)}
                    />
                  </label>
                </div>
                <div className="two-column-form">
                  <label>
                    <span className="field-label">Store Name</span>
                    <input className="field" value={form.company} onChange={(event) => update('company', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Phone Number</span>
                    <input className="field" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Address Line 1</span>
                    <input className="field" value={form.address_line_1} onChange={(event) => update('address_line_1', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Address Line 2</span>
                    <input className="field" value={form.address_line_2} onChange={(event) => update('address_line_2', event.target.value)} />
                  </label>
                  <label className="wide-field">
                    <span className="field-label">Customer Care Line</span>
                    <input className="field" value={form.customer_care} onChange={(event) => update('customer_care', event.target.value)} />
                  </label>
                </div>
                <button className="primary-button" type="button" onClick={saveStoreSettings}>Save Store Details</button>
                {templateInfo && (
                  <div className="change-box barcode-template-path-box">
                    <span>Template file:</span>
                    <strong>{templateInfo.template_path}</strong>
                  </div>
                )}
                <button className="secondary-button" type="button" onClick={loadTemplate}>Reload Template</button>
                <button className="secondary-button" type="button" onClick={generatePrn}>Create Test PRN From Current Product</button>
                <button className="secondary-button" type="button" onClick={copyPrn} disabled={!prn}>Copy Test PRN</button>
                <button className="secondary-button" type="button" onClick={() => {
                  setSetupUnlocked(false);
                  setTemplateInfo(null);
                  setPrn('');
                }}>Close PRN Setup</button>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">{selectedTemplate.label} Template Preview</h2></div>
          <div className="panel-body barcode-preview-wrap">
            <StickerPreview form={form} templateName={templateName} />
            <pre className="prn-output">
              {setupUnlocked
                ? (prn || templateInfo?.template || `Template file will load from barcode/templates/${templateName}`)
                : 'Unlock PRN Template Setup to view template details.'}
            </pre>
          </div>
        </section>
      </div>
      )}
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
