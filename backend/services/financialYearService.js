function fiscalStartYearForDate(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  const year = parsed.getFullYear();
  const month = parsed.getMonth() + 1;
  return month >= 4 ? year : year - 1;
}

function formatFinancialYear(startYear) {
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

function getFinancialYear(date = new Date()) {
  return formatFinancialYear(fiscalStartYearForDate(date));
}

function getFinancialYearBounds(financialYear = getFinancialYear()) {
  const match = String(financialYear || '').trim().match(/^(\d{2}|\d{4})-(\d{2}|\d{4})$/);
  if (!match) {
    const startYear = fiscalStartYearForDate();
    return {
      financialYear: formatFinancialYear(startYear),
      label: `${startYear}-${startYear + 1}`,
      from: `${startYear}-04-01`,
      to: `${startYear + 1}-03-31`
    };
  }

  const rawStart = Number.parseInt(match[1], 10);
  const startYear = rawStart < 100 ? 2000 + rawStart : rawStart;
  return {
    financialYear: formatFinancialYear(startYear),
    label: `${startYear}-${startYear + 1}`,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`
  };
}

function getFinancialYearOptions(pastYears = 8, futureYears = 1) {
  const currentStart = fiscalStartYearForDate();
  const years = [];
  for (let startYear = currentStart + futureYears; startYear >= currentStart - pastYears; startYear -= 1) {
    years.push(getFinancialYearBounds(formatFinancialYear(startYear)));
  }
  return years;
}

module.exports = {
  fiscalStartYearForDate,
  formatFinancialYear,
  getFinancialYear,
  getFinancialYearBounds,
  getFinancialYearOptions
};
