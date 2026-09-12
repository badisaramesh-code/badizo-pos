const { randomUUID } = require('crypto');
const { normalizeDate, todayIso } = require('../utils/formatters');

// Restarting the server invalidates all permissions (fail closed).
function createApprovalStore(now = Date.now) {
  const requests = new Map();
  const clean = () => { for (const [id, row] of requests) if (row.expiresAt <= now()) requests.delete(id); };
  const owner = (user) => `${user.id}:${user.session_id}`;
  function scope(user, kind, query) {
    if (!['pos-sale-report', 'counter-sale-slip'].includes(kind)) throw new Error('Invalid report.');
    if (!user.session_id || !(Number(user.counter_no) > 0)) throw new Error('Please log in to your counter again.');
    const from = normalizeDate(kind === 'counter-sale-slip' ? query.date : query.from || query.date, todayIso());
    const to = kind === 'counter-sale-slip' ? from : normalizeDate(query.to || from, from);
    return { kind, from, to, counterNo: Number(user.counter_no), reportType: kind === 'pos-sale-report' && String(query.report_type || '').toUpperCase() === 'GST' ? 'GST' : 'ALL' };
  }
  return {
    scope,
    request(user, kind, query, ip) {
      clean();
      const report = scope(user, kind, query);
      const key = JSON.stringify(report);
      const existing = [...requests.values()].find(row => row.owner === owner(user) && row.key === key && row.status !== 'REJECTED');
      if (existing) return existing;
      if ([...requests.values()].filter(row => row.owner === owner(user)).length >= 20) throw new Error('Too many requests. Please wait for existing requests to expire.');
      const row = { id: randomUUID(), owner: owner(user), key, ...report, username: user.username, personName: user.person_name, systemNo: user.system_no, ip, status: 'PENDING', requestedAt: now(), expiresAt: now() + 10 * 60 * 1000 };
      requests.set(row.id, row);
      return row;
    },
    pending() { clean(); return [...requests.values()].filter(row => row.status === 'PENDING'); },
    get(id, user) { clean(); const row = requests.get(id); return row?.owner === owner(user) ? row : null; },
    cancel(id, user) {
      const row = this.get(id, user);
      if (row && row.status === 'PENDING') requests.delete(id);
    },
    decide(id, approved, user) {
      clean();
      if (user.role !== 'SERVER') return null;
      const row = requests.get(id);
      if (!row || row.status !== 'PENDING') return null;
      row.status = approved ? 'APPROVED' : 'REJECTED';
      row.approvedBy = user.username;
      row.expiresAt = now() + 5 * 60 * 1000;
      return row;
    },
    permits(id, user, kind, query) {
      const row = this.get(id, user);
      return Boolean(row && row.status === 'APPROVED' && row.key === JSON.stringify(scope(user, kind, query)));
    }
  };
}
module.exports = { createApprovalStore };
