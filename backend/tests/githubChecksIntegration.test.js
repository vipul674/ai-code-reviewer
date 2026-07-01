import test from 'node:test';
import assert from 'node:assert/strict';
import {
  severityToGitHubLevel,
  formatAnnotations,
  batchAnnotations,
} from '../utils/githubChecksIntegration.js';

test('severityToGitHubLevel maps error to failure', () => {
  assert.equal(severityToGitHubLevel('error'), 'failure');
});

test('severityToGitHubLevel maps warning to neutral', () => {
  assert.equal(severityToGitHubLevel('warning'), 'neutral');
});

test('severityToGitHubLevel maps info to notice', () => {
  assert.equal(severityToGitHubLevel('info'), 'notice');
});

test('severityToGitHubLevel returns notice for unknown severity', () => {
  assert.equal(severityToGitHubLevel('unknown'), 'notice');
});

test('severityToGitHubLevel returns notice for null severity', () => {
  assert.equal(severityToGitHubLevel(null), 'notice');
});

test('severityToGitHubLevel returns notice for undefined severity', () => {
  assert.equal(severityToGitHubLevel(undefined), 'notice');
});

test('formatAnnotations transforms findings to GitHub annotation format', () => {
  const findings = [
    {
      file: 'src/utils/helper.js',
      line: 10,
      severity: 'error',
      message: 'Unused variable detected',
      rule_id: 'no-unused-vars',
    },
  ];
  const result = formatAnnotations(findings);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'src/utils/helper.js');
  assert.equal(result[0].start_line, 10);
  assert.equal(result[0].end_line, 10);
  assert.equal(result[0].annotation_level, 'failure');
  assert.equal(result[0].message, 'Unused variable detected');
  assert.equal(result[0].title, 'no-unused-vars');
});

test('formatAnnotations maps different severity levels correctly', () => {
  const findings = [
    { file: 'a.js', line: 1, severity: 'error', message: 'err', rule_id: 'r1' },
    { file: 'b.js', line: 2, severity: 'warning', message: 'warn', rule_id: 'r2' },
    { file: 'c.js', line: 3, severity: 'info', message: 'inf', rule_id: 'r3' },
  ];
  const result = formatAnnotations(findings);
  assert.equal(result[0].annotation_level, 'failure');
  assert.equal(result[1].annotation_level, 'neutral');
  assert.equal(result[2].annotation_level, 'notice');
});

test('formatAnnotations handles unknown severity with notice level', () => {
  const findings = [
    { file: 'x.js', line: 1, severity: 'critical', message: 'crit', rule_id: 'r1' },
  ];
  const result = formatAnnotations(findings);
  assert.equal(result[0].annotation_level, 'notice');
});

test('formatAnnotations handles empty array', () => {
  assert.deepEqual(formatAnnotations([]), []);
});

test('batchAnnotations splits into batches of MAX_ANNOTATIONS_PER_REQUEST (50)', () => {
  const annotations = Array.from({ length: 120 }, (_, i) => ({
    path: `file${i}.js`,
    start_line: i,
    end_line: i,
    annotation_level: 'failure',
    message: `Finding ${i}`,
    title: `rule-${i}`,
  }));
  const batches = batchAnnotations(annotations);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 50);
  assert.equal(batches[1].length, 50);
  assert.equal(batches[2].length, 20);
});

test('batchAnnotations returns zero batches for empty array', () => {
  const batches = batchAnnotations([]);
  assert.equal(batches.length, 0);
});

test('batchAnnotations returns single batch for single item', () => {
  const annotations = [
    { path: 'a.js', start_line: 1, end_line: 1, annotation_level: 'failure', message: 'err', title: 'r1' },
  ];
  const batches = batchAnnotations(annotations);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test('batchAnnotations returns single batch for exactly batch size', () => {
  const annotations = Array.from({ length: 50 }, (_, i) => ({
    path: `file${i}.js`, start_line: i, end_line: i, annotation_level: 'failure', message: `f${i}`, title: `r${i}`,
  }));
  const batches = batchAnnotations(annotations);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 50);
});

test('batchAnnotations returns two batches for just over batch size', () => {
  const annotations = Array.from({ length: 51 }, (_, i) => ({
    path: `file${i}.js`, start_line: i, end_line: i, annotation_level: 'failure', message: `f${i}`, title: `r${i}`,
  }));
  const batches = batchAnnotations(annotations);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 50);
  assert.equal(batches[1].length, 1);
});
