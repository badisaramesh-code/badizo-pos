const amount = (value) => Number(value || 0).toFixed(2);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export async function saveSaleReportPdf(report, shop = {}) {
  const totals = report.totals || {};
  const payments = report.paymentTotals || {};
  const title = `${report.reportType || 'ALL'} SALE REPORT`;
  const filename = `BADIZO-Sales-${report.from}-${report.to}-${report.reportType || 'ALL'}-${report.counter || 'ALL'}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const generated = new Date().toLocaleString('en-IN');
  const summary = [
    ['Bills', String(totals.billCount || 0)], ['Start Bill', totals.startingInvoiceNo || '-'],
    ['End Bill', totals.endingInvoiceNo || '-'], ['Total (INR)', amount(payments.total ?? totals.netTotal)], ['GST (INR)', amount(totals.gst)]
  ];
  const paymentRows = [['UPI Sales', amount(payments.upi), 'Card Sales', amount(payments.card)], ['Other Sales', amount(payments.other), 'Cash Sales', amount(payments.cash)]];
  const extraRows = [
    ['Total Sale', amount(totals.saleTotal), 'Taxable', amount(totals.taxable)],
    ['Exchange Bills', String(totals.exchangeBillCount || 0), 'Exchange Sale', amount(totals.exchangeSaleTotal)],
    ['Exchange Less', amount(totals.exchangeTotal), 'Exchange Net', amount(totals.exchangeNetTotal)],
    ['Loyalty Less', amount(totals.loyaltyRedeemedTotal), 'Round Off', amount(totals.roundOffTotal)],
    ['Net Sale', amount(totals.netTotal), 'Payment / Net Total', amount(payments.total ?? totals.netTotal)]
  ];
  const headings = ['GST', 'Bills', 'Qty', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total Tax', 'Total'];
  const rows = (report.gst || []).map((row) => [
    `${Number(row.gstPercent || 0)}%`, String(row.billCount || 0), amount(row.quantity),
    ...['taxable', 'cgst', 'sgst', 'igst', 'gst', 'total'].map((key) => amount(row[key]))
  ]);
  const htmlRows = (data, cell = 'td') => data.map((row) => `<tr>${row.map((value) => `<${cell}>${escapeHtml(value)}</${cell}>`).join('')}</tr>`).join('');
  if (window.badizoDesktop?.saveA4PdfHtml) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page { size: A4 landscape; margin: 12mm; }
      body { margin: 0; font-family: Arial, sans-serif; color: #172b23; font-size: 11px; }
      h1 { margin: 0 0 5px; font-size: 23px; color: #006b37; } .shop-info { margin-bottom: 12px; color: #53635b; }
      h2 { margin: 0 0 12px; padding: 10px 12px; background: #eaf5ee; border: 1px solid #8aba98; font-size: 16px; }
      .meta { display: flex; justify-content: space-between; margin: 10px 0; }
      .summary { display: flex; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid #8aba98; background: #f5faf6; margin-bottom: 12px; }
      .summary span { display: block; font-size: 10px; margin-bottom: 5px; } .summary strong { font-size: 12px; overflow-wrap: anywhere; }
      table { width: 100%; border-collapse: collapse; margin: 10px 0; table-layout: fixed; }
      td, th { border: 1px solid #a9bcb0; padding: 8px 5px; } th { background: #b5d9bb; color: #003b22; }
      .gst td, .gst th { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .gst td:first-child, .gst th:first-child { text-align: left; } .gst td:last-child { font-weight: bold; }
      .gst tbody tr:nth-child(odd) { background: #fffef0; } .gst tbody tr:nth-child(even) { background: #eaf3f5; }
      .pairs td:nth-child(even) { text-align: right; font-weight: bold; } .pairs td { width: 25%; }
      thead { display: table-header-group; } tr, .summary { break-inside: avoid; } h3 { font-size: 12px; margin: 16px 0 4px; }
      .footer { margin-top: 12px; font-size: 10px; color: #53635b; }
    </style></head><body><h1>${escapeHtml(shop.shop_name || 'Badizo')}</h1>
    <div class="shop-info">${escapeHtml([shop.address, shop.gst_number && `GSTIN: ${shop.gst_number}`, shop.phone && `Phone: ${shop.phone}`].filter(Boolean).join(' | '))}</div>
    <h2>${escapeHtml(title)}</h2><div class="meta"><strong>Period: ${escapeHtml(report.from)} to ${escapeHtml(report.to)}</strong><span>Counter: ${escapeHtml(report.counter || 'ALL')}</span></div>
    <div class="summary">${summary.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
    <table class="pairs">${htmlRows(paymentRows)}</table><h3>GST BREAKDOWN - ALL AMOUNTS IN INR</h3>
    <table class="gst"><colgroup>${[5, 7, 10, 15, 12, 12, 11, 13, 15].map((width) => `<col style="width:${width}%">`).join('')}</colgroup><thead>${htmlRows([headings], 'th')}</thead><tbody>${htmlRows(rows)}</tbody></table>
    <h3>ADDITIONAL TOTALS (INR)</h3><table class="pairs">${htmlRows(extraRows)}</table><div class="footer">Generated: ${escapeHtml(generated)} | Badizo POS Sale Report</div></body></html>`;
    const result = await window.badizoDesktop.saveA4PdfHtml({ html, filename });
    if (!result?.ok && !result?.canceled) throw new Error(result?.error || 'Unable to save sale report PDF.');
    return result;
  }
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const pdf = new jsPDF({ orientation: 'landscape', format: 'a4' });
  const green = [0, 107, 55];
  pdf.setTextColor(...green);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text(String(shop.shop_name || 'Badizo'), 12, 18);
  pdf.setTextColor(70, 80, 75);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text([shop.address, shop.gst_number && `GSTIN: ${shop.gst_number}`, shop.phone && `Phone: ${shop.phone}`].filter(Boolean).join(' | '), 12, 24);
  pdf.setFillColor(234, 245, 238);
  pdf.rect(12, 29, 273, 12, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...green);
  pdf.setFontSize(12);
  pdf.text(title, 16, 37);
  pdf.setFontSize(10);
  pdf.setTextColor(23, 43, 35);
  pdf.text(`Period: ${report.from} to ${report.to}`, 12, 48);
  pdf.text(`Counter: ${report.counter || 'ALL'}`, 285, 48, { align: 'right' });
  const base = { theme: 'grid', margin: 12, styles: { fontSize: 9, cellPadding: 1.5, textColor: [23, 43, 35], lineColor: [169, 188, 176], lineWidth: 0.15 }, headStyles: { fillColor: [181, 217, 187], textColor: [0, 59, 34] } };
  autoTable(pdf, { ...base, startY: 53, head: [summary.map(([label]) => label)], body: [summary.map(([, value]) => value)], styles: { ...base.styles, fontStyle: 'bold' } });
  const pairs = { ...base, columnStyles: { 0: { cellWidth: 68.25 }, 1: { cellWidth: 68.25, halign: 'right', fontStyle: 'bold' }, 2: { cellWidth: 68.25 }, 3: { cellWidth: 68.25, halign: 'right', fontStyle: 'bold' } } };
  autoTable(pdf, { ...pairs, startY: pdf.lastAutoTable.finalY + 4, body: paymentRows });
  let y = pdf.lastAutoTable.finalY + 7;
  pdf.setFontSize(9);
  pdf.text('GST BREAKDOWN - ALL AMOUNTS IN INR', 12, y);
  autoTable(pdf, { ...base, startY: y + 3, head: [headings], body: rows, styles: { ...base.styles, halign: 'right' }, headStyles: { ...base.headStyles, halign: 'right' }, alternateRowStyles: { fillColor: [234, 243, 245] }, bodyStyles: { fillColor: [255, 254, 240] }, columnStyles: { 0: { cellWidth: 14, halign: 'left' }, 1: { cellWidth: 18 }, 2: { cellWidth: 26 }, 3: { cellWidth: 40 }, 4: { cellWidth: 31 }, 5: { cellWidth: 31 }, 6: { cellWidth: 30 }, 7: { cellWidth: 36 }, 8: { cellWidth: 47, fontStyle: 'bold' } } });
  y = pdf.lastAutoTable.finalY + 7;
  pdf.text('ADDITIONAL TOTALS (INR)', 12, y);
  autoTable(pdf, { ...pairs, startY: y + 3, body: extraRows });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text(`Generated: ${generated} | Badizo POS Sale Report`, 12, pdf.lastAutoTable.finalY + 7);
  pdf.save(`${filename}.pdf`);
  return { ok: true };
}
