import { listProfiles } from '@/lib/repos/profilesRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import {
  collectionIncludesSubscription,
  consumingProfilesOfCollection,
  consumingProfilesOfSubscription,
} from './nodePipelineSaveGate';
import { versionedRead } from './versionedRead';
import { ProblemDetailsError } from '@/lib/http/problem';

export async function sourceUsage(kind: 'subscription' | 'collection', id: string) {
  const snapshot = await versionedRead(async () => {
    const [profiles, subscriptions, collections] = await Promise.all([
      listProfiles(),
      listSubscriptions(),
      listCollections(),
    ]);
    const source = (kind === 'subscription' ? subscriptions : collections).find((s) => s.id === id);
    if (!source) throw ProblemDetailsError.notFound('来源不存在。');
    const storedSubscription = subscriptions.find((s) => s.id === id);
    // Show potential consumers of the enable/disable action, including tag
    // membership that becomes active when a disabled source is enabled.
    const subscription = storedSubscription ? { ...storedSubscription, enabled: true } : undefined;
    const enabledCandidate = subscriptions.map((s) =>
      s.id === id && subscription ? subscription : s,
    );
    const affected =
      kind === 'subscription'
        ? consumingProfilesOfSubscription(subscription!, collections, enabledCandidate, profiles)
        : consumingProfilesOfCollection(id, profiles);
    const members = subscription
      ? collections.filter((c) => collectionIncludesSubscription(c, subscription, enabledCandidate))
      : [];
    return {
      profiles: affected.map(({ id, name }) => ({ id, name })),
      collections: members.map(({ id, name }) => ({ id, name })),
    };
  });
  return { data: snapshot.data, meta: { configVersion: snapshot.configVersion } };
}
