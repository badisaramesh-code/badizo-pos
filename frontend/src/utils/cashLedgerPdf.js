export async function createCashLedgerPdf({ from, to, counter, rows, openingBalance, totals, closingBalance }) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const pdf = new jsPDF({ orientation: 'portrait', format: 'a4' });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const money = (value) => Number(value || 0).toFixed(2);
  const balance = (value) => `${money(Math.abs(value))} ${value < 0 ? 'Cr' : 'Dr'}`;
  const generated = new Date().toLocaleString('en-IN');
  const header = () => {
    pdf.setFillColor(0, 107, 55);
    pdf.rect(12, 10, width - 24, 17, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(15);
    pdf.text('BADIZO POS', width / 2, 17, { align: 'center' });
    pdf.setFontSize(10);
    pdf.text('COUNTER CLOSING CASH ACCOUNT', width / 2, 23, { align: 'center' });
    pdf.setTextColor(23, 43, 35);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text(`Period: ${from} to ${to}`, 12, 34);
    pdf.text(counter ? `Counter ${counter}` : 'All Counters', width - 12, 34, { align: 'right' });
    const boxes = [
      ['OPENING BALANCE', balance(openingBalance)],
      ['TOTAL DR', money(totals?.dr)],
      ['TOTAL CR', money(totals?.cr)],
      ['CLOSING CASH BALANCE', balance(closingBalance)]
    ];
    const boxWidth = (width - 24) / 4;
    boxes.forEach(([label, value], index) => {
      const x = 12 + index * boxWidth;
      pdf.setFillColor(238, 247, 239);
      pdf.rect(x, 39, boxWidth - 2, 16, 'F');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(6.5);
      pdf.text(label, x + 3, 44);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.text(`INR ${value}`, x + 3, 51);
    });
  };
  const body = [
    [from, 'Opening Balance', '', '', '', money(Math.abs(openingBalance)), openingBalance < 0 ? 'Cr' : 'Dr'],
    ...rows.map(row => [row.date, row.details, row.noteDetail, row.dr ? money(row.dr) : '', row.cr ? money(row.cr) : '', money(Math.abs(row.balance)), row.balanceType]),
    ['', 'TOTAL / CLOSING BALANCE', '', money(totals?.dr), money(totals?.cr), money(Math.abs(closingBalance)), closingBalance < 0 ? 'Cr' : 'Dr']
  ];
  autoTable(pdf, {
    startY: 61,
    margin: { top: 12, bottom: 16, left: 12, right: 12 },
    head: [['DATE', 'DETAILS', 'NOTE DETAIL', 'DR (INR)', 'CR (INR)', 'BALANCE (INR)', 'DR/CR']],
    body, theme: 'grid', rowPageBreak: 'avoid',
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.5, lineColor: [181, 201, 188], lineWidth: 0.15, textColor: [23, 43, 35], overflow: 'linebreak' },
    headStyles: { fillColor: [0, 107, 55], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [242, 248, 244] },
    columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 52 }, 2: { cellWidth: 25 }, 3: { cellWidth: 24, halign: 'right' }, 4: { cellWidth: 24, halign: 'right' }, 5: { cellWidth: 28, halign: 'right' }, 6: { cellWidth: 13, halign: 'center' } },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      if (data.row.index === 0 || data.row.index === body.length - 1) {
        data.cell.styles.fillColor = [222, 238, 225];
        data.cell.styles.fontStyle = 'bold';
      }
      if (data.row.raw[6] === 'Cr' && data.column.index >= 5) data.cell.styles.textColor = [190, 35, 35];
    },
    didDrawPage: (data) => {
      if (data.pageNumber === 1) header();
    }
  });
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(181, 201, 188);
    pdf.line(12, height - 12, width - 12, height - 12);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(90, 105, 96);
    pdf.setFontSize(8);
    pdf.text(`Badizo POS | Generated: ${generated}`, 12, height - 7);
    pdf.text(`${page}-${pages}`, width - 12, height - 7, { align: 'right' });
  }
  return pdf;
}
