const crypto = require('crypto');

function todayIndia() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function date(value, label = 'Date') {
  const text = String(value || '');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(`${label} is invalid.`);
  return text;
}
function money(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) fail(`${label} must be a non-negative amount with at most two decimals.`);
  return Math.round(Number(text) * 100);
}
function fy(value) { const d = date(value); return Number(d.slice(0, 4)) - (d.slice(5, 7) < '04' ? 1 : 0); }
function scope(value) { if (!['LOCAL', 'NON_LOCAL'].includes(value)) fail('Select Local or Non-Local.'); return value; }
function requestId(value) { const id = String(value || ''); if (!/^[A-Za-z0-9_-]{12,100}$/.test(id)) fail('A payment request identity is required.'); return id; }
function text(value, max, label, required = false) { const s = String(value || '').trim(); if ((required && !s) || s.length > max) fail(`${label} is required and must be ${max} characters or fewer.`); return s; }
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS local_payment_diary (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, account_scope ENUM('LOCAL','NON_LOCAL') NOT NULL,
    account_name VARCHAR(180) NOT NULL, bill_no VARCHAR(100) NOT NULL, bill_date DATE NOT NULL,
    due_date DATE NOT NULL, amount DECIMAL(12,2) NOT NULL, notes VARCHAR(500) NOT NULL DEFAULT '',
    create_request_id VARCHAR(100) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL,
    created_by VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_diary_bill(account_scope,account_name,bill_no,bill_date),
    INDEX idx_diary_due(due_date), INDEX idx_diary_account(account_scope,account_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS local_payment_diary_payments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, diary_id BIGINT NOT NULL, payment_date DATE NOT NULL,
    paid_amount DECIMAL(12,2) NOT NULL, discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    payment_mode ENUM('Cash','Bank','UPI') NOT NULL, bank_name VARCHAR(120) NOT NULL DEFAULT '',
    reference_no VARCHAR(120) NOT NULL DEFAULT '', notes VARCHAR(500) NOT NULL DEFAULT '',
    request_id VARCHAR(100) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL,
    payment_entry_id BIGINT DEFAULT NULL, discount_entry_id BIGINT DEFAULT NULL,
    reversal_payment_entry_id BIGINT DEFAULT NULL, reversal_discount_entry_id BIGINT DEFAULT NULL,
    created_by VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reversed_date DATE DEFAULT NULL, reversed_by VARCHAR(100) DEFAULT NULL,
    reversal_reason VARCHAR(255) DEFAULT NULL, reversal_request_id VARCHAR(100) DEFAULT NULL UNIQUE,
    INDEX idx_diary_payment(diary_id,payment_date),
    CONSTRAINT fk_diary_payment FOREIGN KEY(diary_id) REFERENCES local_payment_diary(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS local_payment_diary_years (
    year_start SMALLINT PRIMARY KEY, closed_by VARCHAR(100) NOT NULL,
    closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS local_payment_diary_changes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, diary_id BIGINT NOT NULL,
    change_type ENUM('EDIT','DELETE','RESTORE') NOT NULL, event_date DATE NOT NULL,
    reason VARCHAR(255) NOT NULL, changes_json JSON NOT NULL,
    request_id VARCHAR(100) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL,
    created_by VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_diary_changes(diary_id,event_date),
    CONSTRAINT fk_diary_changes FOREIGN KEY(diary_id) REFERENCES local_payment_diary(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Preserve the bill due date; Sunday reminders are shown on Saturday.
function reminderDate(value) {
  const day = new Date(date(value) + 'T00:00:00Z');
  if (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0,10);
}
const reminderSql = 'CASE WHEN DAYOFWEEK(d.due_date)=1 THEN DATE_SUB(d.due_date, INTERVAL 1 DAY) ELSE d.due_date END';
function createService(pool, { today = todayIndia } = {}) {
  async function transaction(work) {
    const c = await pool.getConnection();
    try { await c.beginTransaction(); const value = await work(c); await c.commit(); return value; }
    catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async function openDate(c, value) {
    if (value > today()) fail('Payment date cannot be in the future.');
    if (fy(value) !== fy(today())) fail('Payments and reversals must be dated in the active financial year.');
    const [closed] = await c.query('SELECT year_start FROM local_payment_diary_years WHERE year_start=?', [fy(value)]);
    if (closed.length) fail('This financial year is closed.');
  }
  async function accountExists(c, accountScope, name) {
    const [rows] = await c.query(`SELECT account_name FROM local_account_ledgers WHERE account_scope=? AND account_name=?
      UNION SELECT account_name FROM local_account_entries WHERE account_scope=? AND account_name=? LIMIT 1`, [accountScope, name, accountScope, name]);
    if (!rows.length) fail('Choose an existing Local/Non-Local ledger account.');
  }
  async function ledgerEntry(c, row, payment, amount, discount = false, reverse = false) {
    if (!amount) return null;
    const details = `${reverse ? 'REVERSAL ' : ''}${discount ? 'DISCOUNT / LESS' : `PAYMENT ${payment.payment_mode.toUpperCase()}`} - BILL ${row.bill_no}`.slice(0, 255);
    const remarks = [payment.bank_name, payment.reference_no, payment.notes, `DIARY #${row.id}`].filter(Boolean).join(' | ').slice(0, 255);
    const [result] = await c.query(`INSERT INTO local_account_entries
      (account_scope,entry_date,account_name,details,remarks,dr_amount,cr_amount,created_by)
      VALUES(?,?,?,?,?,?,?,?)`, [row.account_scope, payment.payment_date, row.account_name, details, remarks,
      reverse ? 0 : amount / 100, reverse ? amount / 100 : 0, payment.actor]);
    return result.insertId;
  }
  async function changeState(c,id) {
    const [rows]=await c.query(`SELECT COALESCE(MAX(id),0) AS version,
      COALESCE(MAX(CASE WHEN change_type='DELETE' THEN id ELSE 0 END),0) AS deleted,
      COALESCE(MAX(CASE WHEN change_type='RESTORE' THEN id ELSE 0 END),0) AS restored
      FROM local_payment_diary_changes WHERE diary_id=?`,[id]);
    return {version:Number(rows[0].version),deleted:Number(rows[0].deleted)>Number(rows[0].restored)};
  }
  async function add(body, actor, connection = null) {
    const row = { account_scope: scope(body.account_scope), account_name: text(body.account_name, 180, 'Account', true).toUpperCase(),
      bill_no: text(body.bill_no, 100, 'Bill number', true).toUpperCase(), bill_date: date(body.bill_date, 'Bill date'),
      due_date: date(body.due_date, 'Due date'), amount: money(body.amount, 'Bill amount'), notes: text(body.notes, 500, 'Notes') };
    if (!row.amount) fail('Bill amount must be greater than zero.');
    if (row.due_date < row.bill_date) fail('Due date cannot precede the bill date.');
    if (row.bill_date > today()) fail('Bill date cannot be in the future.');
    const id = requestId(body.request_id), hash = fingerprint(row);
    const work = async c => {
      const [existing] = await c.query('SELECT id,request_hash FROM local_payment_diary WHERE create_request_id=?', [id]);
      if (existing.length) { if (existing[0].request_hash !== hash) fail('This reminder request was already used for different details.', 409); return { id: existing[0].id, duplicate: true }; }
      await accountExists(c, row.account_scope, row.account_name);
      const [closed] = await c.query('SELECT year_start FROM local_payment_diary_years WHERE year_start=?', [fy(row.bill_date)]);
      if (closed.length) fail('This bill belongs to a closed financial year. Add its outstanding balance as an opening reminder dated in the active year.');
      const [result] = await c.query(`INSERT INTO local_payment_diary
        (account_scope,account_name,bill_no,bill_date,due_date,amount,notes,create_request_id,request_hash,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [row.account_scope,row.account_name,row.bill_no,row.bill_date,row.due_date,row.amount/100,row.notes,id,hash,actor]);
      return { id: result.insertId };
    };
    return connection ? work(connection) : transaction(work);
  }
  async function pay(id, body, actor) {
    const p = { payment_date: date(body.payment_date, 'Payment date'), paid: money(body.paid_amount || '0', 'Paid amount'),
      discount: money(body.discount_amount || '0', 'Discount'), payment_mode: String(body.payment_mode || ''),
      bank_name: text(body.bank_name,120,'Bank name'), reference_no: text(body.reference_no,120,'Reference'), notes: text(body.notes,500,'Notes') };
    if (!['Cash','Bank','UPI'].includes(p.payment_mode)) fail('Choose Cash, Bank or UPI.');
    if (p.payment_mode === 'Bank' && !p.bank_name) fail('Enter the bank/account name.');
    if (!p.paid && !p.discount) fail('Enter a payment or discount amount.');
    const key = requestId(body.request_id), hash = fingerprint({ id, ...p });
    return transaction(async c => {
      // Serializes partial payments from multiple admins, including retries.
      const [rows] = await c.query("SELECT *,DATE_FORMAT(bill_date,'%Y-%m-%d') AS bill_date FROM local_payment_diary WHERE id=? FOR UPDATE", [id]);
      if (!rows.length) fail('Reminder not found.',404);
      const row = rows[0];
      const [existing] = await c.query('SELECT id,request_hash FROM local_payment_diary_payments WHERE request_id=?', [key]);
      if (existing.length) { if (existing[0].request_hash !== hash) fail('This payment request was already used for different details.',409); return { id: existing[0].id, duplicate:true }; }
      const diaryState=await changeState(c,id);
      if(diaryState.deleted)fail('This reminder has been deleted. Restore it before recording a payment.',409);
      if(Number(body.version||0)!==diaryState.version)fail('This reminder was edited. Refresh and check its current details before recording payment.',409);
      await openDate(c,p.payment_date);
      if (p.payment_date < row.bill_date) fail('Payment date cannot precede the bill date.');
      await accountExists(c,row.account_scope,row.account_name);
      const [paid] = await c.query(`SELECT COALESCE(SUM(paid_amount+discount_amount),0) AS settled,
        DATE_FORMAT(MAX(payment_date),'%Y-%m-%d') AS last_payment FROM local_payment_diary_payments WHERE diary_id=? AND reversed_date IS NULL`, [id]);
      if (paid[0].last_payment && p.payment_date < paid[0].last_payment) fail('Payment date cannot precede the latest payment on this bill.');
      const remaining = Math.round(Number(row.amount)*100)-Math.round(Number(paid[0].settled)*100);
      if (p.paid+p.discount > remaining) fail(`Payment plus discount exceeds the pending amount Rs.${(remaining/100).toFixed(2)}.`);
      const post = { ...p, actor };
      const paymentEntry = await ledgerEntry(c,row,post,p.paid);
      const discountEntry = await ledgerEntry(c,row,post,p.discount,true);
      const [result] = await c.query(`INSERT INTO local_payment_diary_payments
        (diary_id,payment_date,paid_amount,discount_amount,payment_mode,bank_name,reference_no,notes,
         request_id,request_hash,payment_entry_id,discount_entry_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,p.payment_date,p.paid/100,p.discount/100,p.payment_mode,p.bank_name,p.reference_no,p.notes,key,hash,paymentEntry,discountEntry,actor]);
      return { id: result.insertId, pending_amount:(remaining-p.paid-p.discount)/100 };
    });
  }
  async function reverse(id, body, actor) {
    const reason = text(body.reason,255,'Reversal reason',true), reversalDate = date(body.reversal_date), key = requestId(body.request_id);
    return transaction(async c => {
      // Acquire the reminder lock first, in the same order as normal payments.
      const [found] = await c.query('SELECT diary_id FROM local_payment_diary_payments WHERE id=?',[id]);
      if (!found.length) fail('Payment not found.',404);
      const [rows] = await c.query('SELECT * FROM local_payment_diary WHERE id=? FOR UPDATE',[found[0].diary_id]);
      const [payments] = await c.query("SELECT *,DATE_FORMAT(payment_date,'%Y-%m-%d') AS payment_date,DATE_FORMAT(reversed_date,'%Y-%m-%d') AS reversed_date FROM local_payment_diary_payments WHERE id=? FOR UPDATE",[id]);
      const p=payments[0];
      if(p.reversed_date) { if(p.reversal_request_id===key && p.reversed_date===reversalDate && p.reversal_reason===reason) return {id,duplicate:true}; fail('This payment has already been reversed.',409); }
      await openDate(c,reversalDate);
      if(reversalDate<p.payment_date) fail('Reversal date cannot precede payment date.');
      const post={...p,payment_date:reversalDate,notes:reason,actor};
      const paymentEntry=await ledgerEntry(c,rows[0],post,Math.round(Number(p.paid_amount)*100),false,true);
      const discountEntry=await ledgerEntry(c,rows[0],post,Math.round(Number(p.discount_amount)*100),true,true);
      await c.query(`UPDATE local_payment_diary_payments SET reversed_date=?,reversed_by=?,reversal_reason=?,reversal_request_id=?,reversal_payment_entry_id=?,reversal_discount_entry_id=? WHERE id=?`,[reversalDate,actor,reason,key,paymentEntry,discountEntry,id]);
      return {id};
    });
  }
  async function list(query={}) {
    const year=Number(query.year||fy(today()));
    if(!Number.isInteger(year)||year<2000||year>2099) fail('Invalid financial year.');
    const start=`${year}-04-01`,end=`${year+1}-03-31`,asOf=end<today()?end:today();
    const params=[asOf,asOf,asOf,asOf,start,end,start,end,asOf,end];
    let where='d.bill_date<=?';
    if(query.scope) {where+=' AND d.account_scope=?';params.push(scope(query.scope));}
    if(query.from) {where+=` AND (${reminderSql})>=?`;params.push(date(query.from));}
    if(query.to) {where+=` AND (${reminderSql})<=?`;params.push(date(query.to));}
    if(query.search) {where+=' AND (d.account_name LIKE ? OR d.bill_no LIKE ?)';const search=`%${text(query.search,180,'Search')}%`;params.push(search,search);}
    const [rows]=await pool.query(`SELECT d.*,DATE_FORMAT(d.bill_date,'%Y-%m-%d') AS bill_date,DATE_FORMAT(d.due_date,'%Y-%m-%d') AS due_date,COALESCE(p.paid,0) AS paid_amount,COALESCE(p.discount,0) AS discount_amount,
      COALESCE(p.activity,0) AS period_activity,COALESCE(h.version,0) AS version,
      (COALESCE(h.deleted,0)>COALESCE(h.restored,0)) AS is_deleted
      FROM local_payment_diary d LEFT JOIN (
      SELECT diary_id,SUM(CASE WHEN payment_date<=? AND (reversed_date IS NULL OR reversed_date>?) THEN paid_amount ELSE 0 END) AS paid,
      SUM(CASE WHEN payment_date<=? AND (reversed_date IS NULL OR reversed_date>?) THEN discount_amount ELSE 0 END) AS discount,
      SUM(CASE WHEN payment_date BETWEEN ? AND ? OR reversed_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS activity
      FROM local_payment_diary_payments GROUP BY diary_id) p ON p.diary_id=d.id
      LEFT JOIN (SELECT diary_id,MAX(id) AS version,
      MAX(CASE WHEN change_type='DELETE' THEN id ELSE 0 END) AS deleted,
      MAX(CASE WHEN change_type='RESTORE' THEN id ELSE 0 END) AS restored
      FROM local_payment_diary_changes WHERE event_date<=? GROUP BY diary_id) h ON h.diary_id=d.id
      WHERE ${where} ORDER BY (${reminderSql}),d.account_name,d.id`,params);
    const all=rows.map(row=>{const pending=Math.max(0,Math.round(Number(row.amount)*100)-Math.round(Number(row.paid_amount)*100)-Math.round(Number(row.discount_amount)*100))/100;
      return {...row,reminder_date:reminderDate(row.due_date),version:Number(row.version||0),is_deleted:Boolean(Number(row.is_deleted)),pending_amount:pending,carried_forward:row.bill_date<start,status:pending===0?'PAID':Number(row.paid_amount)+Number(row.discount_amount)>0?'PART_PAID':'PENDING'};
    }).filter(row=>row.bill_date>=start||row.pending_amount>0||Number(row.period_activity)>0);
    const summary={pending:0,due:0,upcoming:0,paid:0,discount:0};
    all.filter(row=>!row.is_deleted).forEach(row=>{summary.pending+=row.pending_amount;summary[row.reminder_date<=today()?'due':'upcoming']+=row.pending_amount;summary.paid+=Number(row.paid_amount);summary.discount+=Number(row.discount_amount);});
    const [closed]=await pool.query('SELECT * FROM local_payment_diary_years ORDER BY year_start DESC');
    const [years]=await pool.query("SELECT DATE_FORMAT(MIN(bill_date),'%Y-%m-%d') AS earliest FROM local_payment_diary");
    return {year,active_year:fy(today()),today:today(),start,end,as_of:asOf,closed_years:closed,
      earliest_year:years[0]?.earliest?fy(years[0].earliest):fy(today()),summary,
      rows:all.filter(row=>query.status==='DELETED'?row.is_deleted:!row.is_deleted&&(query.status==='PAID'?row.status==='PAID':query.status==='ALL'?true:row.pending_amount>0))};
  }
  async function accounts(query) {
    const name=text(query.search,180,'Search');if(name.length<3)return [];
    const s=scope(query.scope);
    const [rows]=await pool.query(`SELECT account_name FROM (
      SELECT account_name FROM local_account_ledgers WHERE account_scope=?
      UNION SELECT account_name FROM local_account_entries WHERE account_scope=?) a
      WHERE account_name LIKE ? ORDER BY account_name LIMIT 20`,[s,s,`%${name}%`]);return rows;
  }
  async function history(id) {const [rows]=await pool.query("SELECT *,DATE_FORMAT(payment_date,'%Y-%m-%d') AS payment_date,DATE_FORMAT(reversed_date,'%Y-%m-%d') AS reversed_date FROM local_payment_diary_payments WHERE diary_id=? ORDER BY payment_date,id",[id]);return rows;}
  async function changes(id) {const [rows]=await pool.query("SELECT *,DATE_FORMAT(event_date,'%Y-%m-%d') AS event_date FROM local_payment_diary_changes WHERE diary_id=? ORDER BY id",[id]);return rows;}
  async function modify(id,body,actor,type='EDIT') {
    const key=requestId(body.request_id),reason=text(body.reason,255,'Reason',true);
    const intent={id,type,body},hash=fingerprint(intent);
    return transaction(async c=>{
      const [rows]=await c.query("SELECT *,DATE_FORMAT(bill_date,'%Y-%m-%d') AS bill_date,DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM local_payment_diary WHERE id=? FOR UPDATE",[id]);
      if(!rows.length)fail('Reminder not found.',404);const old=rows[0];
      const [prior]=await c.query('SELECT id,request_hash FROM local_payment_diary_changes WHERE request_id=?',[key]);
      if(prior.length){if(prior[0].request_hash!==hash)fail('This change request was already used for different details.',409);return {id,duplicate:true};}
      const state=await changeState(c,id);
      if(Number(body.version||0)!==state.version)fail('This reminder changed on another screen. Refresh before editing or deleting it.',409);
      await openDate(c,today());
      if(type==='RESTORE'&&!state.deleted)fail('This reminder is not deleted.',409);
      if(type!=='RESTORE'&&state.deleted)fail('Restore this reminder before editing it.',409);
      const [paid]=await c.query('SELECT COALESCE(SUM(paid_amount+discount_amount),0) AS settled FROM local_payment_diary_payments WHERE diary_id=? AND reversed_date IS NULL',[id]);
      const settled=Number(paid[0].settled);
      let next={...old};
      if(type==='DELETE'&&settled>0)fail('Payments or discounts are posted to the ledger. Reverse them in History before deleting this reminder.');
      if(type==='EDIT'){
        next={account_scope:scope(body.account_scope),account_name:text(body.account_name,180,'Account',true).toUpperCase(),
          bill_no:text(body.bill_no,100,'Invoice number').toUpperCase()||old.bill_no,
          bill_date:date(body.bill_date,'Bill date'),due_date:date(body.due_date,'Due date'),
          amount:money(body.amount,'Bill amount')/100,notes:text(body.notes,500,'Notes')};
        if(next.amount<=0||next.bill_date>today()||next.due_date<next.bill_date)fail('Check the amount, bill date and due date.');
        const financialChange=['account_scope','account_name','bill_no','bill_date'].some(field=>next[field]!==old[field])||Number(next.amount)!==Number(old.amount);
        if(financialChange&&settled>0)fail('Payments or discounts are already posted. Reverse them in History before changing the account, invoice, bill date or amount.');
        if(financialChange&&fy(old.bill_date)!==fy(today()))fail('A previous-year reminder can only have its due date and remarks changed.');
        if(financialChange&&fy(next.bill_date)!==fy(today()))fail('Use an active financial year bill date for the corrected reminder.');
        await accountExists(c,next.account_scope,next.account_name);
        await c.query(`UPDATE local_payment_diary SET account_scope=?,account_name=?,bill_no=?,bill_date=?,due_date=?,amount=?,notes=? WHERE id=?`,
          [next.account_scope,next.account_name,next.bill_no,next.bill_date,next.due_date,next.amount,next.notes,id]);
      }
      await c.query(`INSERT INTO local_payment_diary_changes
        (diary_id,change_type,event_date,reason,changes_json,request_id,request_hash,created_by) VALUES(?,?,?,?,?,?,?,?)`,
        [id,type,today(),reason,JSON.stringify({before:old,after:type==='EDIT'?next:{is_deleted:type==='DELETE'}}),key,hash,actor]);
      return {id};
    });
  }
  async function closeYear(body,actor) {
    const year=Number(body.year);if(!Number.isInteger(year)||year<2000||year>=fy(today()))fail('Only a completed financial year can be closed after 31 March.');
    await pool.query('INSERT IGNORE INTO local_payment_diary_years(year_start,closed_by) VALUES(?,?)',[year,actor]);return {year,next_year:year+1};
  }
  return {add,pay,reverse,list,accounts,history,changes,modify,closeYear};
}
module.exports={ensureSchema,createService,todayIndia,date,money,fy};

module.exports.reminderDate = reminderDate;
