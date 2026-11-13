'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planDeltaArchive } = require('./delta-plan.cjs');
const sha256 = 'a'.repeat(64);
function input() {
  return {
    sourceUuid: 'shop-source',
    baseline: { sourceUuid: 'shop-source', sha256, restoreVerified: true, coordinate: { file: 'binlog.000112', position: 50 } },
    current: { file: 'binlog.000114', position: 120 },
    logs: [{ file: 'binlog.000112', size: 100 }, { file: 'binlog.000113', size: 150 }, { file: 'binlog.000114', size: 125 }]
  };
}
test('plans only closed logs, retaining the precise baseline position', () => {
  const plan = planDeltaArchive(input());
  assert.deepEqual(plan.segments, [{ file: 'binlog.000112', from: 50, to: 100, fileBytes: 100 }, { file: 'binlog.000113', from: 4, to: 150, fileBytes: 150 }]);
  assert.equal(plan.activeLogExcluded, 'binlog.000114');
  assert.equal(plan.checkpointChanged, false);
});
test('does not invent a baseline or accept an unverified restore', () => {
  for (const baseline of [null, { ...input().baseline, restoreVerified: false }, { ...input().baseline, sha256: '' }]) {
    assert.throws(() => planDeltaArchive({ ...input(), baseline }), /baseline/);
  }
});
test('fails on a missing middle segment or an expired starting log', () => {
  for (const missing of ['binlog.000112', 'binlog.000113']) {
    const data = input(); data.logs = data.logs.filter(row => row.file !== missing);
    assert.throws(() => planDeltaArchive(data), /gap/);
  }
});
test('rejects a different source, rewound checkpoint and unconfirmed upload', () => {
  assert.throws(() => planDeltaArchive({ ...input(), sourceUuid: 'other' }), /different MySQL source/);
  const checkpoint = { sourceUuid: 'shop-source', baselineSha256: sha256, durable: true, coordinate: { file: 'binlog.000112', position: 49 } };
  assert.throws(() => planDeltaArchive({ ...input(), checkpoint }), /precedes/);
  assert.throws(() => planDeltaArchive({ ...input(), checkpoint: { ...checkpoint, durable: false } }), /durable/);
});
test('resumes after a durable uploaded segment without planning it twice', () => {
  const checkpoint = { sourceUuid: 'shop-source', baselineSha256: sha256, durable: true, coordinate: { file: 'binlog.000113', position: 150 } };
  const result = planDeltaArchive({ ...input(), checkpoint });
  assert.deepEqual(result.segments, []);
  assert.equal(result.status, 'WAITING_FOR_ROTATION');
});
test('rejects inconsistent positions and unsafe file names', () => {
  assert.throws(() => planDeltaArchive({ ...input(), current: { file: 'binlog.000114', position: 1000 } }), /exceeds/);
  assert.throws(() => planDeltaArchive({ ...input(), current: { file: '../binlog.000114', position: 4 } }), /Invalid/);
});
