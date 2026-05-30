const express = require('express');
const cors = require('cors');
const auditRouter = require('./routes/audit');
const authRouter = require('./routes/auth');
const backupRouter = require('./routes/backup');
const booksRouter = require('./routes/books');
const productsRouter = require('./routes/products');
const billingRouter = require('./routes/billing');
const counterClosingRouter = require('./routes/counterClosing');
const customersRouter = require('./routes/customers');
const inwardRouter = require('./routes/inward');
const settingsRouter = require('./routes/settings');
const reportsRouter = require('./routes/reports');
const usersRouter = require('./routes/users');
const { scheduleDailyBackup } = require('./services/backupService');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/audit', auditRouter);
app.use('/api/backup', backupRouter);
app.use('/api/books', booksRouter);
app.use('/api/products', productsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/counter-closing', counterClosingRouter);
app.use('/api/customers', customersRouter);
app.use('/api/inward', inwardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/users', usersRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`BADIZO POS API running on port ${PORT}`);
  scheduleDailyBackup();
});
