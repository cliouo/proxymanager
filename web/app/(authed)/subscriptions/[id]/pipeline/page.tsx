'use client';

import { useParams } from 'next/navigation';
import { OperatorWorkbench } from '../../_pipeline/OperatorWorkbench';

export default function PipelinePage() {
  const { id } = useParams<{ id: string }>();
  const loadPath = `/api/v1/subscriptions/${id}`;
  return (
    <OperatorWorkbench
      entityId={id}
      loadPath={loadPath}
      previewPath={`${loadPath}/preview`}
      savePath={loadPath}
      backHref="/subscriptions"
      crumbPrefix="订阅源"
      introNoun="订阅源"
      aggregate={false}
      pickLabel={(d) => d.display_name || d.name || ''}
    />
  );
}
