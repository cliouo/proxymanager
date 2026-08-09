import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));
const SCORER = fileURLToPath(new URL('../../scripts/skillopt/scorer.ts', import.meta.url));

interface ScoreResult {
  hard: number;
  checks: Array<{ name: string; ok: boolean; msg: string }>;
}

function runScorer(artifact: string): ScoreResult {
  const job = {
    artifact,
    spec: {
      type: 'regex_filter',
      node_fixture: ['HK', 'US'],
      must_match: ['HK'],
      must_not_match: ['US'],
    },
  };
  const stdout = execFileSync(process.execPath, [TSX_CLI, SCORER], {
    input: JSON.stringify(job),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as ScoreResult;
}

describe('SkillOpt scorer CLI', () => {
  it.each([
    ['filter', 'filter:\n  nested: invalid\ndummy: |\n  HK'],
    ['exclude-filter', JSON.stringify({ filter: 'HK', 'exclude-filter': { bad: true } })],
  ])('rejects a structured object with a non-string %s field', (_field, artifact) => {
    const result = runScorer(artifact);

    expect(result.hard).toBe(0);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'filter-fields-valid', ok: false }),
    );
  });

  it('still accepts a bare regex answer', () => {
    expect(runScorer('HK').hard).toBe(1);
  });
});
