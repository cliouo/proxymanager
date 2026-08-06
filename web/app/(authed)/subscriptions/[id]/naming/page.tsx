'use client';

import { useParams } from 'next/navigation';
import { NamingWorkspace } from '../../_pipeline/NamingWorkspace';

export default function SubscriptionNamingPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <NamingWorkspace
      workspacePath={`/api/v1/naming/subscription/${id}`}
      backHref="/subscriptions"
      crumbPrefix="订阅源"
    />
  );
}
