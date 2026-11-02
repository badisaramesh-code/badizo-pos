const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export async function saveLedgerPdf({ account, from, to, columns, rows, totals }) {
  const filename = `BADIZO-Ledger-${account}-${from}-${to}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const balance = `${Math.abs(totals.balance).toFixed(2)} ${totals.balance < 0 ? 'CR' : 'DR'}`;
  const summary = `DR Total: INR ${totals.dr.toFixed(2)}     CR Total: INR ${totals.cr.toFixed(2)}     Balance: INR ${balance}`;
  const generated = new Date().toLocaleString('en-IN');
  const moneyColumns = ['DR Rs', 'CR Rs', 'Balance Rs'];
  const weights = columns.map(c => c === 'Details' || c === 'Particulars' ? 38 : c === 'Remarks' ? 20 : c === 'Sheet' ? 22 : moneyColumns.includes(c) ? 20 : c.toLowerCase() === 'dr/cr' ? 8 : c === 'Date' ? 18 : 14);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (window.badizoDesktop?.saveA4PdfHtml) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(account)} Ledger</title><style>
      @page { size: A4 portrait; margin: 10mm; } body { font-family: Arial,sans-serif; font-size: 9px; margin: 0; color: #172b23; }
      h1 { color:#006b37; font-size:22px; margin:0 0 6px; } h2 { font-size:14px; margin:0 0 12px; }
      .summary { padding:12px; background:#eef7ef; border:1px solid #a9bcb0; font-weight:bold; margin:12px 0; }
      table { border-collapse:collapse; width:100%; table-layout:fixed; } th,td { padding:6px 4px; border:1px solid #a9bcb0; overflow-wrap:anywhere; vertical-align:top; }
      th { background:#b5d9bb; text-align:left; } .money { text-align:right; font-variant-numeric:tabular-nums; }
      tbody tr:nth-child(odd) { background:#fffef0; } tbody tr:nth-child(even) { background:#eaf3f5; }
      thead { display:table-header-group; } tr { break-inside:avoid; } .footer { font-size:9px; margin-top:12px; }
    </style></head><body><h1>${escapeHtml(account)}</h1><h2>LEDGER BOOK</h2><div>Period: ${escapeHtml(from)} to ${escapeHtml(to)} | Entries: ${rows.length}</div>
    <div class="summary">${escapeHtml(summary)}</div><table><colgroup>${weights.map(weight => `<col style="width:${weight / totalWeight * 100}%">`).join('')}</colgroup><thead><tr>${columns.map(c => `<th class="${moneyColumns.includes(c) ? 'money' : ''}">${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.length ? rows.map(row => `<tr>${row.map((v,i) => `<td class="${moneyColumns.includes(columns[i]) ? 'money' : ''}">${escapeHtml(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">No entries for selected date range.</td></tr>`}
    </tbody></table><div class="footer">Generated: ${escapeHtml(generated)} | Badizo POS</div></body></html>`;
    const result = await window.badizoDesktop.saveA4PdfHtml({html,filename});
    if (!result?.ok && !result?.canceled) throw new Error(result?.error || 'Unable to save ledger PDF.');
    return result;
  }
  const [{jsPDF},{default:autoTable}] = await Promise.all([import('jspdf'),import('jspdf-autotable')]);
  const pdf = new jsPDF({orientation:'portrait',format:'a4'});
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const tableWidth = pageWidth - 20;
  const drawHeader = () => {
    pdf.setFont('helvetica','bold'); pdf.setFontSize(18); pdf.setTextColor(0,107,55);
    pdf.text(pdf.splitTextToSize(String(account),tableWidth).slice(0,2),10,14); pdf.setFontSize(11); pdf.text('LEDGER BOOK',10,28);
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9); pdf.setTextColor(23,43,35);
    pdf.text(`Period: ${from} to ${to} | Entries: ${rows.length}`,10,35);
    pdf.setFillColor(238,247,239); pdf.rect(10,39,tableWidth,14,'F'); pdf.setFont('helvetica','bold'); pdf.text(pdf.splitTextToSize(summary,tableWidth-8),14,45);
  };
  const columnStyles = Object.fromEntries(columns.map((c,i)=>[i, {cellWidth:tableWidth * weights[i] / totalWeight, ...(moneyColumns.includes(c) ? {halign:'right'} : {})}]));
  autoTable(pdf,{startY:58,margin:{top:58,bottom:16,left:10,right:10},tableWidth,head:[columns],body:rows.length?rows:[[{content:'No entries for selected date range.',colSpan:columns.length}]],theme:'grid',rowPageBreak:'avoid',styles:{fontSize:7,cellPadding:1.5,lineColor:[169,188,176],lineWidth:0.15,textColor:[23,43,35],overflow:'linebreak'},headStyles:{fillColor:[181,217,187],textColor:[0,59,34]},alternateRowStyles:{fillColor:[234,243,245]},bodyStyles:{fillColor:[255,254,240]},columnStyles,didDrawPage:()=>{drawHeader();pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.text(`Generated: ${generated} | Badizo POS | Page ${pdf.getNumberOfPages()}`,10,pageHeight-8);}});
  pdf.save(`${filename}.pdf`);
  return {ok:true};
}
