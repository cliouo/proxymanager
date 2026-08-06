'use client';

import { useParams } from 'next/navigation';
import { NamingWorkspace } from '../../../_pipeline/NamingWorkspace';

export default function CollectionNamingPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <NamingWorkspace
      workspacePath={`/api/v1/naming/collection/${id}`}
      backHref="/subscriptions"
      crumbPrefix="订阅源 / 聚合订阅"
    />
  );
}
