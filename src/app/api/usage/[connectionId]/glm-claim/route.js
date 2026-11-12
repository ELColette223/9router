// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { isGlmZcodeEligible } from "@/shared/services/glmZcodeMaintenance";
import { ZcodeApiError, fetchZcodeClaimPreview, claimZcodePlan } from "open-sse/services/usage/glmZcode.js";
import { GLM_ZCODE_CONFIG } from "@/shared/constants/config";
import { refreshAndUpdateCredentials } from "../route.js";

const WEEKEND_PLAN_RE = /weekend/i;

// Manually claim a GLM Zcode weekend plan. Business failures return 200 with the
// server copy (the UI distinguishes via the success flag); only "no weekend plan
// available" is 409. On success the claim epoch is bumped so the auto-claim gate
// in usage maintenance backs off.
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const { planId: requestedPlanId } = await request.json().catch(() => ({}));

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (!isGlmZcodeEligible(connection)) {
      return Response.json({ error: "Plan claim is only available for GLM Zcode OAuth connections." }, { status: 400 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const zcodeJwt = connection.providerSpecificData?.zcodeJwtToken;

    // Without an explicit planId, pick the first weekend plan from the preview.
    let planId = requestedPlanId;
    let weekendName;
    if (!planId) {
      const preview = await fetchZcodeClaimPreview({ zcodeJwt, proxyOptions });
      const weekend = (Array.isArray(preview?.plans) ? preview.plans : [])
        .filter((plan) => WEEKEND_PLAN_RE.test(plan?.name || ""));
      if (weekend.length === 0) {
        return Response.json({ success: false, message: "No weekend plan available to claim" }, { status: 409 });
      }
      planId = weekend[0].planId;
      weekendName = weekend[0].name;
    }

    const result = await claimZcodePlan({ zcodeJwt, planId, proxyOptions });

    if (result.success) {
      // Re-read before merging so concurrent providerSpecificData updates survive.
      const fresh = (await getProviderConnectionById(connectionId)) ?? connection;
      const psd = fresh.providerSpecificData || {};
      await updateProviderConnection(connectionId, {
        providerSpecificData: {
          ...psd,
          zcodeNextClaimCheckAt: Date.now() + GLM_ZCODE_CONFIG.claimSuccessMs,
          zcodeClaimState: {
            ...(psd.zcodeClaimState || {}),
            available: false,
            lastClaimedAt: new Date().toISOString(),
            lastError: null,
            planName: result.plan?.name ?? weekendName,
            endsAt: result.plan?.endsAt ?? psd.zcodeClaimState?.endsAt ?? null,
          },
        },
      });
    }

    return Response.json(result);
  } catch (error) {
    if (error instanceof ZcodeApiError && error.kind === "auth") {
      return Response.json({ error: error.message }, { status: 401 });
    }
    console.warn(`[GLM Claim] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
