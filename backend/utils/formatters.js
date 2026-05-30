function parseMoney(value) {
  return Number.parseFloat(value) || 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value, fallback = todayIso()) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function normalizeCounterNo(value, maxCounters = 6) {
  const counterNo = Number.parseInt(value, 10) || 1;
  return Math.min(Math.max(counterNo, 1), maxCounters);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvLine(values) {
  return values.map(csvEscape).join(',');
}

module.exports = {
  csvEscape,
  csvLine,
  normalizeCounterNo,
  normalizeDate,
  normalizePhone,
  parseMoney,
  todayIso
};
