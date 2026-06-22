function parseMoney(value) {
  return Number.parseFloat(value) || 0;
}

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDate(value, fallback = todayIso()) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dayFirstMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dayFirstMatch) {
    const day = Number.parseInt(dayFirstMatch[1], 10);
    const month = Number.parseInt(dayFirstMatch[2], 10);
    const year = Number.parseInt(dayFirstMatch[3], 10);
    const parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() === year
      && parsed.getMonth() === month - 1
      && parsed.getDate() === day
    ) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return fallback;
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
