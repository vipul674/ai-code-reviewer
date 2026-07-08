import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const originalWarn = console.warn;
console.warn = () => {};

const STORE_PATH = path.join(import.meta.dirname, '..', 'analytics_trends.json');
const BACKUP_PATH = STORE_PATH + '.backup';
const TMP_PATH = STORE_PATH + '.tmp';
const TEST_BACKUP_PATH = STORE_PATH + '.test_backup';
const TEST_BACKUP_BACKUP_PATH = BACKUP_PATH + '.test_backup';

async function withSafeStore(fn) {
  const storeExists = fs.existsSync(STORE_PATH);
  const backupExists = fs.existsSync(BACKUP_PATH);
  
  if (storeExists) fs.renameSync(STORE_PATH, TEST_BACKUP_PATH);
  if (backupExists) fs.renameSync(BACKUP_PATH, TEST_BACKUP_BACKUP_PATH);
  
  try {
    await fn();
  } finally {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
    if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
    if (storeExists) fs.renameSync(TEST_BACKUP_PATH, STORE_PATH);
    if (backupExists) fs.renameSync(TEST_BACKUP_BACKUP_PATH, BACKUP_PATH);
  }
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function writeBackup(data) {
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(data, null, 2));
}

function corruptStore() {
  fs.writeFileSync(STORE_PATH, '{not an array}');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('recordAnalysis and getTrends are exported functions', async () => {
  const mod = await import('../utils/analyticsStore.js');
  assert.equal(typeof mod.recordAnalysis, 'function', 'recordAnalysis should be exported');
  assert.equal(typeof mod.getTrends, 'function', 'getTrends should be exported');
});

test('getTrends returns empty array when no store file exists', async () => {
  await withSafeStore(async () => {
    const { getTrends } = await import('../utils/analyticsStore.js');
    const result = getTrends();
    assert.deepEqual(result, [], 'should return empty array when no file exists');
  });
});

test('getTrends returns parsed array when store file is valid JSON', async () => {
  await withSafeStore(async () => {
    writeStore([{ timestamp: '2026-01-01', repoName: 'test', totalLines: 100,
      bugs: 0, security: 0, optimization: 0, styling: 0, filesCount: 1 }]);
    const { getTrends } = await import('../utils/analyticsStore.js');
    const result = getTrends();
    assert.equal(result.length, 1);
    assert.equal(result[0].repoName, 'test');
  });
});

test('getTrends recovers from backup when main file is not an array', async () => {
  await withSafeStore(async () => {
    corruptStore();
    writeBackup([{ timestamp: '2026-01-01', repoName: 'backup-repo',
      totalLines: 0, bugs: 0, security: 0, optimization: 0, styling: 0, filesCount: 0 }]);
    const { getTrends } = await import('../utils/analyticsStore.js');
    const result = getTrends();
    assert.equal(result.length, 1);
    assert.equal(result[0].repoName, 'backup-repo');
  });
});

test('getTrends returns empty array when both main and backup are corrupt', async () => {
  await withSafeStore(async () => {
    corruptStore();
    fs.writeFileSync(BACKUP_PATH, '{also broken}');
    const { getTrends } = await import('../utils/analyticsStore.js');
    const result = getTrends();
    assert.deepEqual(result, [], 'should return empty array when recovery fails');
  });
});

test('recordAnalysis appends a record with auto-set timestamp', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    await mod.recordAnalysis({ repoName: 'test-repo', totalLines: 500, bugs: 2, security: 1 });
    const result = mod.getTrends();
    assert.equal(result.length, 1);
    assert.equal(result[0].repoName, 'test-repo');
    assert.equal(result[0].totalLines, 500);
    assert.equal(result[0].bugs, 2);
    assert.equal(result[0].security, 1);
    assert.ok(result[0].timestamp, 'timestamp should be auto-set');
    assert.match(result[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

test('recordAnalysis normalizes missing fields to defaults', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    await mod.recordAnalysis({ repoName: 'partial-repo' });
    const result = mod.getTrends();
    assert.equal(result.length, 1);
    assert.equal(result[0].repoName, 'partial-repo');
    assert.equal(result[0].totalLines, 0);
    assert.equal(result[0].bugs, 0);
    assert.equal(result[0].security, 0);
    assert.equal(result[0].optimization, 0);
    assert.equal(result[0].styling, 0);
    assert.equal(result[0].filesCount, 0);
  });
});

test('recordAnalysis normalizes falsy fields to defaults', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    await mod.recordAnalysis({ repoName: 'zero-repo', totalLines: 0, bugs: 0, security: 0 });
    const result = mod.getTrends();
    assert.equal(result[0].totalLines, 0, '0 is a valid value, not a default');
    assert.equal(result[0].bugs, 0);
  });
});

test('recordAnalysis trims to MAX_RECORDS (200)', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    // Pre-populate 200 records
    const existing = Array.from({ length: 200 }, (_, i) => ({
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      repoName: `old-repo-${i}`,
      totalLines: i, bugs: 0, security: 0, optimization: 0, styling: 0, filesCount: 0,
    }));
    writeStore(existing);

    await mod.recordAnalysis({ repoName: 'new-repo', totalLines: 999 });

    const result = mod.getTrends();
    assert.equal(result.length, 200, 'store should be trimmed to MAX_RECORDS');
    assert.equal(result[result.length - 1].repoName, 'new-repo', 'new record at end');
    assert.equal(result[0].repoName, 'old-repo-1', 'old-repo-0 should be trimmed');
  });
});

test('recordAnalysis writes backup after appending', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    await mod.recordAnalysis({ repoName: 'backup-test', totalLines: 42 });

    assert.ok(fs.existsSync(BACKUP_PATH), 'backup file should exist');
    const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf-8'));
    assert.equal(backup.length, 1);
    assert.equal(backup[0].repoName, 'backup-test');
  });
});

test('getTrends called after recordAnalysis reflects the new record', async () => {
  await withSafeStore(async () => {
    const mod = await import('../utils/analyticsStore.js');
    const before = mod.getTrends();
    assert.equal(before.length, 0);

    await mod.recordAnalysis({ repoName: 'after-record', totalLines: 10 });
    const after = mod.getTrends();
    assert.equal(after.length, 1);
    assert.equal(after[0].repoName, 'after-record');
  });
});

console.warn = originalWarn;
