const express = require('express');
const cors = require('cors');
const { mountRoutes } = require('./routes');
const { scheduleDailyBackup } = require('./services/backupService');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

mountRoutes(app);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`BADIZO POS API running on port ${PORT}`);
  scheduleDailyBackup();
});
