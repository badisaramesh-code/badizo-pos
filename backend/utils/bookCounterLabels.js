// Keep the latest invoice's counter label for each local business date and counter.
function buildCounterLabels(rows) {
  const labels = new Map();
  rows.forEach((row) => {
    const match = String(row.billing_counter || '').match(/Counter([0-9]+)$/i);
    if (!match) return;
    const key = row.invoice_date + '/' + match[1];
    const previous = labels.get(key);
    if (!previous || new Date(row.latest_at) > new Date(previous.latest_at)) labels.set(key, row);
  });
  return labels;
}

function applyCounterLabel(labels, row, date) {
  // MySQL DATE values arrive as local midnight; UTC conversion can move them back a day.
  const localDate = date instanceof Date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : String(date || '').slice(0, 10);
  const label = labels.get(localDate + '/' + row.counter_no);
  if (label) row.counter_label = String(label.billing_counter).replaceAll('Counter', 'C');
}

module.exports = { buildCounterLabels, applyCounterLabel };
