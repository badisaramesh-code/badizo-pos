import React, { useMemo, useState } from 'react';

export default function BarcodeStickersView() {
  const [form, setForm] = useState({
    product_name: 'Parle G Biscuits 100g',
    barcode: '8901719110086',
    mrp: '10.00',
    sale_price: '8.00',
    qty: '10',
    unit: 'Nos',
    company: 'Hyper Fresh Mart LLP',
    address: 'Sathupally - Khammam(dt) - 507303',
    phone: '08761 295000',
    stickerCount: '1'
  });

  const prn = useMemo(() => {
    return [
      'SIZE 50 mm,50 mm',
      'GAP 2 mm,0',
      'DIRECTION 1',
      'CLS',
      `TEXT 20,20,"3",0,1,1,"${form.product_name}"`,
      `BARCODE 45,58,"128",70,1,0,2,2,"${form.barcode}"`,
      `TEXT 20,145,"2",0,1,1,"MRP Rs.${form.mrp}  SALE Rs.${form.sale_price}"`,
      `TEXT 20,172,"2",0,1,1,"Qty: ${form.qty} ${form.unit}"`,
      `TEXT 20,198,"1",0,1,1,"${form.company}"`,
      `TEXT 20,218,"1",0,1,1,"${form.address} Ph:${form.phone}"`,
      `PRINT ${Number(form.stickerCount) || 1},1`
    ].join('\n');
  }, [form]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="barcode-grid">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Barcode Sticker Print</h2></div>
        <div className="panel-body form-stack">
          {Object.entries({
            product_name: 'Product Name',
            barcode: 'Barcode 128',
            mrp: 'MRP',
            sale_price: 'Sale Price',
            qty: 'Qty',
            unit: 'Unit (Nos/Weight/Lts)',
            stickerCount: 'How many stickers'
          }).map(([field, label]) => (
            <label key={field}>
              <span className="field-label">{label}</span>
              <input className="field" value={form[field]} onChange={(event) => update(field, event.target.value)} />
            </label>
          ))}
          <button className="primary-button" onClick={() => window.print()}>Print Sticker</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">50 x 50 mm Preview and TSC PRN</h2></div>
        <div className="panel-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div className="sticker-preview">
            <strong>{form.product_name}</strong>
            <div className="barcode-bars"></div>
            <div className="mono">{form.barcode}</div>
            <div><strong>MRP Rs.{form.mrp}</strong> Sale Rs.{form.sale_price}</div>
            <div>Qty: {form.qty} {form.unit}</div>
            <small>{form.company}<br />{form.address}<br />Ph: {form.phone}</small>
          </div>
          <pre className="prn-output">{prn}</pre>
        </div>
      </section>
    </div>
  );
}
