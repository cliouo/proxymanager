'use client';

import { useParams } from 'next/navigation';
import { OperatorWorkbench } from '../../../_pipeline/OperatorWorkbench';

export default function CollectionPipelinePage() {
  const { id } = useParams<{ id: string }>();
  const loadPath = `/api/v1/collections/${id}`;
  return (
    <OperatorWorkbench
      entityId={id}
      loadPath={loadPath}
      previewPath={`${loadPath}/preview`}
      savePath={loadPath}
      backHref="/subscriptions"
      crumbPrefix="订阅源 / 聚合订阅"
      introNoun="聚合订阅"
      aggregate
      pickLabel={(d) => d.name ?? ''}
    />
  );
}
