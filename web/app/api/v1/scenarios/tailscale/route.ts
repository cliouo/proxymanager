import { withProblemDetails } from '@/lib/http/handler';
import { resolveScopeProfile } from '@/lib/profileScope';
import { summariseTailscale } from '@/lib/scenarios/tailscale/scenario';
import { listProfileDevices, publicDevice } from '@/lib/services/deviceService';

export const dynamic = 'force-dynamic';

/**
 * Device-scoped Tailscale overview. Legacy shared artifacts remain visible so
 * operators know why device preflight is blocked, but this endpoint no longer
 * drives a wizard that writes new shared nodes. No auth key leaves the server.
 */
export const GET = withProblemDetails(async (request: Request) => {
  const profile = await resolveScopeProfile(request);
  const [legacy, devices] = await Promise.all([
    summariseTailscale(profile.id),
    listProfileDevices(profile.id),
  ]);
  return Response.json({
    data: {
      profile: { id: profile.id, name: profile.name, kind: profile.kind },
      legacy,
      devices: devices.map((device) => {
        const safe = publicDevice(device);
        return {
          id: safe.id,
          name: safe.name,
          display_name: safe.display_name,
          basePatchCount: Object.keys(safe.base_patch).length,
          features: safe.features,
        };
      }),
    },
  });
});
