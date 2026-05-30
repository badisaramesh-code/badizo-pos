export function toNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatMoney(value) {
  return `Rs. ${toNumber(value).toFixed(2)}`;
}

const ones = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen'
];

const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(value) {
  if (value < 20) return ones[value];
  return `${tens[Math.floor(value / 10)]} ${ones[value % 10]}`.trim();
}

function belowThousand(value) {
  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  if (!hundred) return belowHundred(rest);
  return `${ones[hundred]} Hundred ${belowHundred(rest)}`.trim();
}

export function amountInWords(value) {
  let amount = Math.round(toNumber(value));
  if (amount === 0) return 'Zero Rupees Only';

  const crore = Math.floor(amount / 10000000);
  amount %= 10000000;
  const lakh = Math.floor(amount / 100000);
  amount %= 100000;
  const thousand = Math.floor(amount / 1000);
  amount %= 1000;

  const parts = [];
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (amount) parts.push(belowThousand(amount));

  return `${parts.join(' ')} Rupees Only`;
}
