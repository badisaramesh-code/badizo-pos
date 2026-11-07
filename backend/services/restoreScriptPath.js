const fs = require('node:fs');
const path = require('node:path');

const packaged = path.resolve(__dirname, '../scripts/restore-staged.py');
module.exports = fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../tools/fleet/restore-staged.py');
