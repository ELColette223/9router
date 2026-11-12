// GLM Zcode maintenance: piggybacks on usage polling (no scheduler). Requests reset
// opportunities and auto-claims weekend plans when epoch gates are due, and enriches
// the quota response with weekend buckets + reset/claim state. Fail-open: any error
// degrades the enrichment, never breaks the quota response.
import { randomUUID } from "node:crypto";

import { getProviderConnectionById, updateProviderConnection, getSettings } from "@/lib/localDb";
import {
  ZcodeApiError,
  fetchZcodeResetStatus,
  fetchZcodePlanBalance,
  requestZcodeResetOpportunity,
  fetchZcodeClaimPreview,
  claimZcodePlan,
} from "open-sse/services/usage/glmZcode.js";
import { parseResetTime } from "open-sse/services/usage/shared.js";
import { GLM_ZCODE_CONFIG } from "@/shared/constants/config";

const C = GLM_ZCODE_CONFIG;
const WEEKEND_PLAN_RE = /weekend/i;

// Survive Next.js hot reload; cache + in-flight dedupe are memory-only.
const g = (globalThis.__glmZcodeMaintenance ??= {
  cache: new Map(),    // connectionId → { at, enrichment }
  inFlight: new Map(), // connectionId → Promise<enrichment>
});

const DEFAULT_CLAIM_STATE = {
  available: false,
  planId: null,
  planName: null,
  lastClaimedAt: null,
  lastError: null,
  endsAt: null,
};

export function isGlmZcodeEligible(connection) {
  return connection?.provider === "glm"
    && connection?.authType === "oauth"
    && Boolean(connection?.providerSpecificData?.zcodeJwtToken);
}

export async function runGlmZcodeMaintenance(connection, proxyOptions = null, { force = false } = {}) {
  if (!isGlmZcodeEligible(connection)) return null;
  const id = connection.id;

  const pending = g.inFlight.get(id);
  if (pending) return pending;

  const cached = g.cache.get(id);
  if (!force && cached && Date.now() - cached.at < C.enrichCacheTtlMs) return cached.enrichment;

  const promise = runMaintenance(connection, proxyOptions)
    .catch((error) => {
      // runMaintenance is fail-open internally; last-resort guard so the quota
      // response can never break.
      console.warn(`[ZcodeMaintenance] ${id}: unexpected failure: ${error?.message}`);
      return emptyEnrichment(connection.providerSpecificData);
    })
    .finally(() => {
      g.inFlight.delete(id);
    });
  g.inFlight.set(id, promise);
  return promise;
}

function isAuthError(error) {
  return error instanceof ZcodeApiError && error.kind === "auth";
}

async function runMaintenance(connection, proxyOptions) {
  const id = connection.id;
  const psd = connection.providerSpecificData || {};
  const zcodeJwt = psd.zcodeJwtToken;
  const businessToken = psd.zaiBusinessToken ?? null;
  const now = Date.now();

  let autoClaim = true;
  let sessionExpired = psd.zcodeSessionExpired === true;
  let claimState = psd.zcodeClaimState ?? null;
  let nextOpportunityAt = psd.zcodeNextOpportunityAt ?? null;
  let nextClaimCheckAt = psd.zcodeNextClaimCheckAt ?? null;
  let status = null;
  let balance = null;

  try {
    const settings = await getSettings();
    autoClaim = settings?.glmAutoClaim?.connections?.[id] !== false;
  } catch (error) {
    console.warn(`[ZcodeMaintenance] ${id}: settings read failed: ${error?.message}`);
  }

  // Display: available resets. A successful call clears the expired-session flag;
  // an auth failure sets it and parks the JWT gates below.
  try {
    status = await fetchZcodeResetStatus({ zcodeJwt, businessToken, proxyOptions });
    sessionExpired = false;
  } catch (error) {
    console.warn(`[ZcodeMaintenance] ${id}: reset status failed: ${error?.message}`);
    if (isAuthError(error)) sessionExpired = true;
  }

  // Display: weekend buckets come from the coding-plan API key balance.
  // Balance authenticates with the API key, not the OAuth JWT, so it neither
  // sets nor clears the expired-session flag.
  try {
    balance = await fetchZcodePlanBalance({ apiKey: connection.accessToken, proxyOptions });
  } catch (error) {
    console.warn(`[ZcodeMaintenance] ${id}: plan balance failed: ${error?.message}`);
  }

  // Gate 1: request reset opportunities (one call covers both reset types).
  if (!sessionExpired && now >= (nextOpportunityAt ?? 0)) {
    try {
      const result = await requestZcodeResetOpportunity({
        zcodeJwt,
        businessToken,
        idempotencyKey: randomUUID(),
        proxyOptions,
      });
      sessionExpired = false;
      if (result?.granted) {
        nextOpportunityAt = now + C.opportunityGrantedMs;
        // Refresh the display so the new grants show up in this enrichment.
        try {
          status = await fetchZcodeResetStatus({ zcodeJwt, businessToken, proxyOptions });
        } catch (error) {
          console.warn(`[ZcodeMaintenance] ${id}: status re-fetch failed: ${error?.message}`);
          if (isAuthError(error)) sessionExpired = true;
        }
      } else {
        const serverNext = Number.isFinite(result?.nextTryAt) ? result.nextTryAt : 0;
        nextOpportunityAt = Math.max(serverNext, now + C.opportunityMinRetryMs);
      }
    } catch (error) {
      console.warn(`[ZcodeMaintenance] ${id}: reset opportunity failed: ${error?.message}`);
      if (isAuthError(error)) {
        nextOpportunityAt = now + C.authCooldownMs;
        sessionExpired = true;
      } else if (error instanceof ZcodeApiError && error.kind === "transport") {
        nextOpportunityAt = now + C.opportunityTransientRetryMs;
      } else {
        // Throttled or stable business error.
        nextOpportunityAt = now + C.opportunityErrorCooldownMs;
      }
    }
  }

  // Gate 2: auto-claim weekend plans (default ON for OAuth connections).
  if (autoClaim && !sessionExpired && now >= (nextClaimCheckAt ?? 0)) {
    try {
      const preview = await fetchZcodeClaimPreview({ zcodeJwt, proxyOptions });
      sessionExpired = false;
      const weekendPlans = (Array.isArray(preview?.plans) ? preview.plans : [])
        .filter((plan) => WEEKEND_PLAN_RE.test(plan?.name || ""));

      // Refresh claim state on every preview run so the UI keeps state between gates.
      claimState = {
        ...DEFAULT_CLAIM_STATE,
        ...(claimState || {}),
        available: weekendPlans.length > 0,
        planId: weekendPlans[0]?.planId ?? null,
        planName: weekendPlans[0]?.name ?? null,
      };

      if (weekendPlans.length === 0) {
        nextClaimCheckAt = now + C.claimEmptyPreviewMs;
      } else {
        let claimed = false;
        for (const plan of weekendPlans) {
          try {
            const result = await claimZcodePlan({ zcodeJwt, planId: plan.planId, proxyOptions });
            if (result?.success) {
              claimed = true;
              claimState = {
                ...claimState,
                available: false,
                planId: result.plan?.planId ?? plan.planId ?? null,
                planName: plan.name ?? null,
                lastClaimedAt: new Date(now).toISOString(),
                lastError: null,
                endsAt: result.plan?.endsAt ?? null,
              };
            } else {
              claimState = { ...claimState, lastError: result?.message || null };
            }
          } catch (error) {
            console.warn(`[ZcodeMaintenance] ${id}: claim ${plan?.planId} failed: ${error?.message}`);
            if (isAuthError(error)) {
              sessionExpired = true;
              nextClaimCheckAt = now + C.authCooldownMs;
              break;
            }
            claimState = { ...claimState, lastError: error?.message || null };
          }
        }
        if (!sessionExpired) {
          nextClaimCheckAt = claimed ? now + C.claimSuccessMs : now + C.claimFailureMs;
        }
      }
    } catch (error) {
      console.warn(`[ZcodeMaintenance] ${id}: claim preview failed: ${error?.message}`);
      if (isAuthError(error)) {
        sessionExpired = true;
        nextClaimCheckAt = now + C.authCooldownMs;
      } else {
        nextClaimCheckAt = now + C.claimFailureMs;
      }
    }
  }

  // Persist only changed fields; re-read the connection so concurrent updates
  // to providerSpecificData are merged, not clobbered.
  const patch = {};
  if (nextOpportunityAt !== (psd.zcodeNextOpportunityAt ?? null)) patch.zcodeNextOpportunityAt = nextOpportunityAt;
  if (nextClaimCheckAt !== (psd.zcodeNextClaimCheckAt ?? null)) patch.zcodeNextClaimCheckAt = nextClaimCheckAt;
  if (sessionExpired !== (psd.zcodeSessionExpired === true)) patch.zcodeSessionExpired = sessionExpired;
  if (JSON.stringify(claimState) !== JSON.stringify(psd.zcodeClaimState ?? null)) patch.zcodeClaimState = claimState;

  if (Object.keys(patch).length > 0) {
    try {
      const fresh = await getProviderConnectionById(id);
      if (fresh) {
        await updateProviderConnection(id, {
          providerSpecificData: { ...(fresh.providerSpecificData || {}), ...patch },
        });
      }
    } catch (error) {
      console.warn(`[ZcodeMaintenance] ${id}: persist failed: ${error?.message}`);
    }
  }

  const enrichment = buildEnrichment({ balance, status, claimState, sessionExpired, autoClaim });
  g.cache.set(id, { at: Date.now(), enrichment });
  return enrichment;
}

function summarizeResets(resets) {
  const list = Array.isArray(resets) ? resets : [];
  const expires = list.map((reset) => reset?.expireAt).filter((value) => Number.isFinite(value));
  return {
    count: list.length,
    soonestExpireAt: expires.length > 0 ? Math.min(...expires) : null,
  };
}

function buildEnrichment({ balance, status, claimState, sessionExpired, autoClaim }) {
  const weekendPlanIds = new Set(
    (Array.isArray(balance?.plans) ? balance.plans : [])
      .filter((plan) => plan?.planId != null && WEEKEND_PLAN_RE.test(plan?.name || ""))
      .map((plan) => plan.planId),
  );

  const quotas = {};
  for (const bucket of Array.isArray(balance?.balances) ? balance.balances : []) {
    if (!weekendPlanIds.has(bucket?.planId)) continue;
    const total = bucket?.totalUnits ?? 0;
    const remaining = bucket?.remainingUnits ?? 0;
    quotas[`Weekend · ${bucket?.showName}`] = {
      used: bucket?.usedUnits ?? 0,
      total,
      remaining,
      remainingPercentage: total > 0 ? (remaining / total) * 100 : 0,
      resetAt: parseResetTime(bucket?.expiresAt),
      unlimited: false,
      // Weekend grants are one-time: resetAt is a hard expiry, so the UI
      // words it as "expires in" instead of a recurring reset countdown.
      recurring: false,
    };
  }

  return {
    quotas,
    zcode: {
      resets: {
        fiveHour: summarizeResets(status?.fiveHour),
        week: summarizeResets(status?.week),
      },
      claim: { ...DEFAULT_CLAIM_STATE, ...(claimState || {}), autoClaim },
      sessionExpired,
    },
  };
}

function emptyEnrichment(psd = {}) {
  return buildEnrichment({
    balance: null,
    status: null,
    claimState: psd?.zcodeClaimState ?? null,
    sessionExpired: psd?.zcodeSessionExpired === true,
    autoClaim: true,
  });
}