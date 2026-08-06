'use client';

import type { RenameTemplateOp } from '@/schemas/operator';
import styles from './pipeline.module.css';

/**
 * Managed rename-template row — IMMUTABLE read-only summary in the generic
 * workbench. Only the real current managed row (isCurrentRenameTemplateOperator)
 * reaches this component; historical / duplicate / parked rename-shaped rows
 * are classified upstream and never passed here. The managed row is created/
 * edited/toggled/deleted exclusively through the dedicated naming workspace
 * (server authority: operatorMutationPolicy rejects every generic managed
 * mutation). No textarea, no alias editor, no AI control, no generic
 * mutation control lives here.
 */
export function RenameTemplateEditor({
  op,
  entityType,
  entityId,
}: {
  op: RenameTemplateOp;
  entityType: 'subscription' | 'collection';
  entityId: string;
}) {
  const aliasCount = Object.keys(op.sourceAliases ?? {}).length;
  const ruleCount = op.recognitionRules?.length ?? 0;
  const href =
    entityType === 'subscription'
      ? `/subscriptions/${entityId}/naming`
      : `/subscriptions/collection/${entityId}/naming`;

  return (
    <div className={styles.rtFields}>
      <p className={styles.note}>
        「名称统一」由智能命名工作台统一管理 —— 这里只读展示，请前往工作台修改、启停或回滚。
      </p>
      <div className={styles.managedSummary}>
        <p className={`mono ${styles.managedTemplate}`}>{op.template}</p>
        <ul className={styles.managedFacts}>
          <li>{op.tw2cn === true ? '台湾节点用中国旗（🇨🇳）' : '台湾节点用台湾旗（🇹🇼）'}</li>
          <li>
            来源别名 {aliasCount} 条{aliasCount > 0 ? '（别名需在工作台修改）' : ''}
          </li>
          <li>
            识别规则 {ruleCount} 条{ruleCount > 0 ? '（规则需在工作台修改）' : ''}
          </li>
          {op.disabled === true && <li>当前已停用</li>}
        </ul>
        <a className={styles.managedLink} href={href}>
          打开智能命名工作台 →
        </a>
      </div>
    </div>
  );
}
