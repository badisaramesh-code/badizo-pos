'use strict';

// Planning only: no SQL, uploads, log rotation, replay or checkpoint writes.
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
function coordinate(value) {
  if (!value || !/^([A-Za-z0-9_-]+)\.(\d{6})$/.test(value.file || '') ||
      !Number.isSafeInteger(value.position) || value.position < 4) throw Error('Invalid binary-log coordinate.');
  const [, prefix, number] = value.file.match(/^([A-Za-z0-9_-]+)\.(\d{6})$/);
  return { ...value, prefix, number: Number(number) };
}
function planDeltaArchive({ sourceUuid, baseline, checkpoint, logs, current }) {
  if (!baseline || baseline.restoreVerified !== true || !hash(baseline.sha256)) {
    throw Error('A checksum-verified baseline with an isolated restore check is required.');
  }
  if (!sourceUuid || baseline.sourceUuid !== sourceUuid) throw Error('Baseline belongs to a different MySQL source.');
  const initial = coordinate(baseline.coordinate);
  const live = coordinate(current);
  let start = initial;
  if (checkpoint) {
    if (checkpoint.sourceUuid !== sourceUuid || checkpoint.baselineSha256 !== baseline.sha256 || checkpoint.durable !== true) {
      throw Error('Checkpoint is not a durable upload checkpoint for this source and baseline.');
    }
    start = coordinate(checkpoint.coordinate);
    if (start.prefix !== initial.prefix || start.number < initial.number ||
        (start.number === initial.number && start.position < initial.position)) throw Error('Checkpoint precedes its baseline.');
  }
  if (start.prefix !== live.prefix || start.number > live.number) throw Error('Source log sequence differs from the checkpoint.');
  const byName = new Map();
  for (const row of logs || []) {
    const parsed = coordinate({ file: row.file, position: 4 });
    if (!Number.isSafeInteger(row.size) || row.size < 4 || byName.has(row.file)) throw Error('Invalid or duplicate log inventory.');
    byName.set(row.file, { ...row, ...parsed });
  }
  const segments = [];
  for (let number = start.number; number <= live.number; number++) {
    const file = `${start.prefix}.${String(number).padStart(6, '0')}`;
    const row = byName.get(file);
    if (!row) throw Error(`Binary-log gap: ${file}. A fresh baseline or the missing archived segment is required.`);
    const from = number === start.number ? start.position : 4;
    const end = number === live.number ? live.position : row.size;
    if (from > end || end > row.size) throw Error(`Coordinate exceeds the available log: ${file}.`);
    // Never copy the file MySQL is still writing. Rotation is an activation-time operation.
    if (number < live.number && from < end) segments.push({ file, from, to: end, fileBytes: row.size });
  }
  return {
    status: segments.length ? 'CLOSED_LOGS_AVAILABLE' : 'WAITING_FOR_ROTATION',
    sourceUuid, baselineSha256: baseline.sha256, segments,
    activeLogExcluded: live.file,
    plannedBytes: segments.reduce((sum, row) => sum + row.fileBytes, 0),
    checkpointChanged: false
  };
}
module.exports = { coordinate, planDeltaArchive };
