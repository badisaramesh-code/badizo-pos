const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Built-in PDF fonts lack Indian scripts. Preserve unsupported characters as
// explicit Unicode escapes rather than silently printing incorrect glyphs.
function text(value) {
  return String(value === null ? '(empty)' : value ?? '').replace(/[^\x20-\x7e\n]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4,'0'));
}
function createRecoveryReport(review) {
  if (!review?.plan?.id || !Array.isArray(review.history) || !Array.isArray(review.decisions)) throw Error('A saved recovery review is required.');
  const document = new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const width=document.internal.pageSize.getWidth();
  document.setFontSize(17);document.text('BADIZO - Recovery decision report',14,16);
  document.setFontSize(10);
  document.text(text(`Shop: ${review.plan.shopId} | Saved revision: ${review.revision} | Unresolved: ${review.unresolvedConflictIds.length}`),14,24);
  document.setFontSize(8);
  document.text(text(`Plan: ${review.plan.id}`),14,30);
  document.text(text(`History fingerprint: ${review.headHash}`),14,35);
  document.text(review.applied ? 'APPLIED LOCALLY - Cloud delivery remains separate. This report does not authorize a billing switch.' : 'REVIEW ONLY - These choices do not certify a database transfer or authorize local billing.',14,42);
  document.text('Non-Latin characters are shown as Unicode escapes. Download JSON for original text.',14,47);
  const decisions=new Map(review.decisions.map(item=>[item.conflictId,item]));
  const rows=review.plan.entries.filter(item=>item.state==='conflict').map(item=>{
    const choice=decisions.get(item.id);
    return [text(item.recordId),text(item.field),text(item.base),text(item.local),text(item.cloud),choice?text(`${choice.chosenSide}: ${choice.chosenValue}`):'UNRESOLVED',choice?text(`${choice.actor}\n${choice.at}`):''];
  });
  autoTable(document,{startY:52,head:[['Record','Field','Original','Local','Cloud','Current choice','Approved by / time']],body:rows.length?rows:[['No conflicts','','','','','','']],styles:{fontSize:8,cellPadding:2,overflow:'linebreak'},margin:{left:14,right:14,bottom:14},rowPageBreak:'avoid'});
  document.addPage();document.setFontSize(15);document.text('Decision history - including corrected choices',14,16);
  const history=review.history.flatMap(batch=>batch.decisions.map(item=>[String(batch.revision),text(item.recordId),text(item.field),text(item.local),text(item.cloud),text(`${item.chosenSide}: ${item.chosenValue}`),text(item.actor),text(item.at)]));
  autoTable(document,{startY:23,head:[['Revision','Record','Field','Local','Cloud','Selected','Owner','Time']],body:history.length?history:[['No saved decisions','','','','','','','']],styles:{fontSize:8,cellPadding:2,overflow:'linebreak'},margin:{left:14,right:14,bottom:14},rowPageBreak:'avoid'});
  const pages=document.getNumberOfPages();
  for(let page=1;page<=pages;page++) {document.setPage(page);document.setFontSize(8);document.text(`Page ${page} / ${pages}`,width-35,document.internal.pageSize.getHeight()-7);}
  return document;
}
module.exports={createRecoveryReport};
