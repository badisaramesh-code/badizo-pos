function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Match a typed prefix with one insertion, deletion or substitution.
function closePrefix(query, name) {
  let i = 0;
  while (i < query.length && query[i] === name[i]) i++;
  const rest = query.slice(i + 1);
  return name.startsWith(rest, i + 1) || name.startsWith(rest, i)
    || name.startsWith(query.slice(i), i + 1);
}

function matchingAccounts(rows, input) {
  const query = normalize(input);
  if (query.length < 3) return [];
  const matches = [];
  for (const row of rows) {
    const name = normalize(row.name);
    let score;
    if (name === query) score = 0;
    else if (name.startsWith(query)) score = 1;
    else if (name.includes(query)) score = 2;
    else if (name.split(' ').some((_, i, words) => closePrefix(query, words.slice(i).join(' ')))) score = 3;
    else continue;
    matches.push({ row, score });
  }
  return matches.sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name)
    || a.row.kind.localeCompare(b.row.kind)).slice(0, 20).map(match => match.row);
}

module.exports = { matchingAccounts };
