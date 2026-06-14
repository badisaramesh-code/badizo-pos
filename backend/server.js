const express = require('express');
const cors = require('cors');
const { mountRoutes } = require('./routes');
const { scheduleDailyBackup } = require('./services/backupService');

const app = express();

app.use(cors());
app.use(express.json({ limit: '250mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

mountRoutes(app);

const PORT = process.env.PORT || 5000;

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`BADIZO POS API running on port ${port}`);
      scheduleDailyBackup();
      resolve(server);
    });

    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
