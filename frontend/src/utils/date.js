export function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeDateInput(value, fallback = todayIso()) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const isoPrefix = text.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoPrefix) return isoPrefix[1];

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

export function formatDisplayDate(value, fallback = '') {
  const normalized = normalizeDateInput(value, fallback || todayIso());
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback || String(value || '');
  return `${match[3]}-${match[2]}-${match[1]}`;
}
