/**
 * BaseStore implementation — the single safe path for structured mutations
 * to base.yaml.
 *
 * All scenarios must go through this rather than touching baseRepo directly,
 * because:
 *   - YAML round-trip must use the Document AST (preserves comments + order)
 *   - Writes must be guarded by ETag concurrency
 *   - Writes must re-parse + (in future) re-validate before committing
 */

import { parseDocument, type Document } from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase, setBase } from '@/lib/repos/baseRepo';
import { computeEtag } from '@/lib/services/baseService';
import { preflightProfileConfig } from '@/lib/services/configPreflight';
import { nowSeconds } from '@/lib/services/rulesService';
import type { BaseReadResult, BaseStore } from './types';

export function createBaseStore(profileId: string): BaseStore {
  return {
    async read(): Promise<BaseReadResult> {
      const base = await getBase(profileId);
      if (!base) {
        throw ProblemDetailsError.unprocessable(
          'Base config has not been initialized. Set base before mutating.',
        );
      }
      const doc = parseDocument(base.content);
      if (doc.errors.length > 0) {
        throw ProblemDetailsError.unprocessable(
          `Stored base.yaml does not parse: ${doc.errors[0].message}`,
        );
      }
      return { doc, etag: base.etag, updated_at: base.updated_at };
    },

    async withDocument<T>(
      mutate: (doc: Document) => T | Promise<T>,
    ): Promise<{ result: T; etag: string }> {
      const { doc, etag: expectedEtag } = await this.read();
      const result = await mutate(doc);

      const newContent = doc.toString();
      // Re-parse to populate fresh anchors/policies for the meta record. The
      // existing parser also validates structural shape; failures here mean
      // the mutation produced corrupt YAML and should not be committed.
      const parsed = parseBase(newContent);
      const checked = await preflightProfileConfig(profileId, () => ({
        baseContent: newContent,
      }));

      const newEtag = computeEtag(newContent);
      const writeResult = await setBase(
        profileId,
        newContent,
        {
          anchors: parsed.anchors,
          policies: parsed.policies,
          etag: newEtag,
          updated_at: nowSeconds(),
        },
        expectedEtag,
        checked.configVersion,
      );

      if (!writeResult.ok) {
        if (writeResult.conflict === 'config-version') {
          throw ProblemDetailsError.preconditionFailed(
            '配置在保存前校验期间被其他写入修改,请刷新后重试。',
          );
        }
        throw ProblemDetailsError.preconditionFailed(
          `base.yaml was modified concurrently (etag mismatch — current ${writeResult.currentEtag ?? '(none)'}).`,
        );
      }

      return { result, etag: newEtag };
    },
  };
}
