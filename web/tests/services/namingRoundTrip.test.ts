import { beforeAll, describe, expect, it } from 'vitest';
import { restoreUnchangedNamingRows } from '@/lib/services/namingRoundTrip';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { installTestHandleSecret } from '../helpers/handleSecret';

beforeAll(() => installTestHandleSecret());

const stored = [
  { id: 'f1', kind: 'filter-regex', mode: 'drop', pattern: '剩余' },
  {
    id: 'naming-plan',
    kind: 'rename-template',
    template: '${region}${?source: · ${source}}',
    sourceAliases: { nebula: '星云' },
    recognitionRules: [],
  },
];

/** What GET hands the client for the same rows. */
function asServed(sourceKeys: string[]) {
  return JSON.parse(
    JSON.stringify(
      stored.map((row) =>
        row.kind === 'rename-template'
          ? { ...row, sourceAliases: projectAliasKeysToHandles(row.sourceAliases, sourceKeys) }
          : row,
      ),
    ),
  );
}

describe('restoreUnchangedNamingRows', () => {
  it('maps an untouched, handle-projected naming row back to the stored row', () => {
    const served = asServed(['nebula']);
    expect(Object.keys(served[1].sourceAliases)[0]).toMatch(/^src-/);
    // the client edits another step and echoes the naming row verbatim
    served[0].pattern = '剩余|到期';
    const body = restoreUnchangedNamingRows({ operators: served }, stored, ['nebula']) as {
      operators: Array<Record<string, unknown>>;
    };
    expect(body.operators[0]).toEqual({ ...stored[0], pattern: '剩余|到期' });
    expect(body.operators[1]).toBe(stored[1]);
  });

  it('leaves a changed naming row as sent so the policy can reject it', () => {
    const served = asServed(['nebula']);
    const handle = Object.keys(served[1].sourceAliases)[0];
    served[1].sourceAliases[handle] = '改名';
    const body = restoreUnchangedNamingRows({ operators: served }, stored, ['nebula']) as {
      operators: Array<Record<string, unknown>>;
    };
    expect(body.operators[1]).not.toBe(stored[1]);
    expect(body.operators[1]).toEqual(served[1]);
  });

  it('ignores bodies without operators and pipelines without a naming row', () => {
    const plain = { display_name: 'x' };
    expect(restoreUnchangedNamingRows(plain, stored, ['nebula'])).toBe(plain);
    const noNaming = { operators: [stored[0]] };
    expect(restoreUnchangedNamingRows(noNaming, [stored[0]], ['nebula'])).toBe(noNaming);
  });
});
