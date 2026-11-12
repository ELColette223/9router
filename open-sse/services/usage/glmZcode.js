/**
 * ZCode billing API client (GLM Zcode coding plan): claim preview, claim, plan balance,
 * coding-plan reset (status/use/opportunity).
 * Envelope + header contracts extracted from the official ZCode client.
 */

import { PROVIDER_OAUTH } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber, parseResetTime } from "./shared.js";

export const ZCODE_APP_VERSION = "3.18.0";

// ZCode origin from registry oauth.zcodeApiBaseUrl — never hardcode
const ZCODE_ORIGIN = PROVIDER_OAUTH.glm.zcodeApiBaseUrl;
const ZCODE_PLATFORM = `${process.platform}-${process.arch}`;
const ZCODE_TIMEOUT_MS = 15000;

export class ZcodeApiError extends Error {
  constructor(message, { kind = "transport", code = null, status = null } = {}) {
    super(message);
    this.name = "ZcodeApiError";
    this.kind = kind; // "auth" | "throttled" | "business" | "transport"
    this.code = code;
    this.status = status;
  }
}

/**
 * Unwrap the ZCode response envelope. The business `code` is authoritative even
 * on HTTP 4xx; numeric-string codes are normalized. A parseable envelope is an
 * object whose `code` is a number or numeric string — without one, fall back to
 * HTTP status rules (401/403 → auth, other !ok → transport).
 */
export function unwrapZcodeEnvelope(json, httpStatus, { acceptedCodes = [] } = {}) {
  const rawCode = json && typeof json === "object" ? json.code : undefined;
  let code = null;
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    code = rawCode;
  } else if (typeof rawCode === "string" && rawCode.trim() !== "" && Number.isFinite(Number(rawCode))) {
    code = Number(rawCode);
  }

  if (code !== null) {
    if (code !== 0 && !acceptedCodes.includes(code)) {
      const detail = json.message ?? json.msg;
      const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";
      throw new ZcodeApiError(`ZCode API business error ${code}${suffix}`, {
        kind: "business",
        code,
        status: httpStatus ?? null,
      });
    }
    return { code, data: json.data ?? null };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    throw new ZcodeApiError(`ZCode API unauthorized (${httpStatus})`, {
      kind: "auth",
      status: httpStatus,
    });
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new ZcodeApiError(`ZCode API error (${httpStatus})`, {
      kind: "transport",
      status: httpStatus,
    });
  }
  return { code: null, data: json ?? null };
}

function zcodeAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Platform": ZCODE_PLATFORM,
    Accept: "application/json",
  };
}

async function zcodeRequest(url, { method = "GET", headers, body = null }, proxyOptions) {
  let response;
  try {
    response = await proxyAwareFetch(
      url,
      { method, headers, body, signal: AbortSignal.timeout(ZCODE_TIMEOUT_MS) },
      proxyOptions,
    );
  } catch (error) {
    throw new ZcodeApiError(`ZCode request failed: ${error.message}`, { kind: "transport" });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new ZcodeApiError("ZCode API returned invalid JSON", {
      kind: "transport",
      status: response.status,
    });
  }
  return { json, status: response.status };
}

/**
 * GET billing/preview — plans claimable with the ZCode OAuth JWT.
 * serverTime passes through data.server_time raw (seconds).
 */
export async function fetchZcodeClaimPreview({ zcodeJwt, proxyOptions = null }) {
  const query = new URLSearchParams({ app_version: ZCODE_APP_VERSION, platform: ZCODE_PLATFORM });
  const { json, status } = await zcodeRequest(
    `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview?${query}`,
    { headers: zcodeAuthHeaders(zcodeJwt) },
    proxyOptions,
  );
  const { data } = unwrapZcodeEnvelope(json, status);
  const plans = Array.isArray(data?.plans) ? data.plans : [];

  return {
    serverTime: data?.server_time ?? null,
    plans: plans.map((plan) => ({
      planId: plan?.plan_id ?? null,
      name: plan?.name ?? null,
      description: plan?.description ?? null,
      priority: plan?.priority ?? null,
      entitlements: (Array.isArray(plan?.entitlements) ? plan.entitlements : []).map((entitlement) => ({
        entitlementId: entitlement?.entitlement_id ?? null,
        showName: entitlement?.show_name ?? null,
        grantUnits: entitlement?.grant_units ?? null,
        period: entitlement?.period ?? null,
      })),
    })),
  };
}

/**
 * POST billing/claim — claim a plan with the ZCode OAuth JWT.
 * Success requires code === 0 AND data.plan. Business failures return
 * { success:false, message: data.message }; auth/transport errors throw.
 */
export async function claimZcodePlan({ zcodeJwt, planId, proxyOptions = null }) {
  const { json, status } = await zcodeRequest(
    `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`,
    {
      method: "POST",
      headers: { ...zcodeAuthHeaders(zcodeJwt), "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: planId }),
    },
    proxyOptions,
  );

  let code;
  let data;
  try {
    ({ code, data } = unwrapZcodeEnvelope(json, status));
  } catch (error) {
    if (error instanceof ZcodeApiError && error.kind === "business") {
      return { success: false, code: error.code, message: json?.data?.message ?? "", plan: null };
    }
    throw error;
  }

  if (code !== 0 || !data?.plan) {
    return { success: false, code, message: data?.message ?? "", plan: null };
  }

  const plan = data.plan;
  return {
    success: true,
    code,
    message: data.message ?? "",
    plan: {
      userPlanId: plan.user_plan_id ?? null,
      planId: plan.plan_id ?? null,
      status: plan.status ?? null,
      startsAt: parseResetTime(plan.starts_at),
      endsAt: parseResetTime(plan.ends_at),
      entitlements: Array.isArray(plan.entitlements) ? plan.entitlements : [],
    },
  };
}

/**
 * GET billing/balance — active plans + per-bucket usage for a coding-plan API key.
 * Only status === "active" plans are kept; units normalized via toFiniteNumber.
 */
export async function fetchZcodePlanBalance({ apiKey, proxyOptions = null }) {
  const query = new URLSearchParams({ app_version: ZCODE_APP_VERSION });
  const { json, status } = await zcodeRequest(
    `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance?${query}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    proxyOptions,
  );
  const { data } = unwrapZcodeEnvelope(json, status);

  const plans = (Array.isArray(data?.plans) ? data.plans : [])
    .filter((plan) => plan?.status === "active")
    .map((plan) => ({
      userPlanId: plan.user_plan_id ?? null,
      planId: plan.plan_id ?? null,
      name: plan.name ?? null,
      status: plan.status ?? null,
      startsAt: parseResetTime(plan.starts_at),
      endsAt: parseResetTime(plan.ends_at),
      entitlements: Array.isArray(plan.entitlements) ? plan.entitlements : [],
    }));

  const balances = (Array.isArray(data?.balances) ? data.balances : []).map((balance) => {
    const totalUnits = toFiniteNumber(balance?.total_units);
    const usedUnits = toFiniteNumber(balance?.used_units);
    return {
      bucketId: balance?.bucket_id ?? null,
      userPlanId: balance?.user_plan_id ?? null,
      planId: balance?.plan_id ?? null,
      entitlementId: balance?.entitlement_id ?? null,
      showName: balance?.show_name ?? null,
      meter: balance?.meter ?? null,
      unitType: balance?.unit_type ?? null,
      capabilities: balance?.capabilities ?? null,
      totalUnits,
      usedUnits,
      remainingUnits: toFiniteNumber(
        balance?.remaining_units ?? balance?.available_units ?? totalUnits - usedUnits,
      ),
      periodStart: parseResetTime(balance?.period_start),
      periodEnd: parseResetTime(balance?.period_end),
      expiresAt: parseResetTime(balance?.expires_at),
    };
  });

  return { serverTime: data?.server_time ?? null, plans, balances };
}

export const ZCODE_RESET_TYPES = ["FIVE_HOUR", "WEEK"];

function zcodeResetHeaders(zcodeJwt, businessToken) {
  return {
    Authorization: `Bearer ${zcodeJwt}`,
    "X-Bigmodel-Authorization": businessToken,
    "Bigmodel-Target-Type": "PERSONAL",
  };
}

/**
 * GET coding-plan/reset/status — available resets + latest use histories.
 * expireAt/usedAt pass through as epoch ms numbers; null histories → null.
 */
export async function fetchZcodeResetStatus({ zcodeJwt, businessToken, proxyOptions = null }) {
  const { json, status } = await zcodeRequest(
    `${ZCODE_ORIGIN}/api/v1/coding-plan/reset/status`,
    { headers: zcodeResetHeaders(zcodeJwt, businessToken) },
    proxyOptions,
  );
  const { data } = unwrapZcodeEnvelope(json, status);

  const mapResets = (resets) =>
    (Array.isArray(resets) ? resets : []).map((reset) => ({ expireAt: reset?.expire_at ?? null }));

  return {
    fiveHour: mapResets(data?.available_five_hour_resets),
    week: mapResets(data?.available_week_resets),
    latestFiveHourUsedAt: data?.latest_five_hour_reset_history?.used_at ?? null,
    latestWeekUsedAt: data?.latest_week_reset_history?.used_at ?? null,
    hasUnreadHistory: data?.has_unread_history ?? false,
  };
}

/**
 * POST coding-plan/reset/use — consume one reset opportunity (irreversible).
 * resetType/idempotencyKey are validated BEFORE any network call; success
 * requires code === 0 AND data.used === true, anything else throws.
 */
export async function useZcodeReset({ zcodeJwt, businessToken, resetType, idempotencyKey, proxyOptions = null }) {
  if (!ZCODE_RESET_TYPES.includes(resetType)) {
    throw new ZcodeApiError(`Invalid ZCode reset type: ${resetType}`, { kind: "business" });
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 64) {
    throw new ZcodeApiError("ZCode idempotency key must be 1-64 characters", { kind: "business" });
  }

  const { json, status } = await zcodeRequest(
    `${ZCODE_ORIGIN}/api/v1/coding-plan/reset/use`,
    {
      method: "POST",
      headers: { ...zcodeResetHeaders(zcodeJwt, businessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: idempotencyKey, reset_type: resetType }),
    },
    proxyOptions,
  );
  const { code, data } = unwrapZcodeEnvelope(json, status);

  if (code !== 0 || data?.used !== true) {
    throw new ZcodeApiError("ZCode reset use was not confirmed by the server", {
      kind: "business",
      code,
      status,
    });
  }
  return { used: true };
}

/**
 * POST coding-plan/reset/opportunity — request reset grants (one call covers
 * both reset types; the server caps grants, repeated calls do not stack).
 * Code 3301 is the server cooldown boundary → { granted:false, nextTryAt };
 * HTTP 429 without a 3301 envelope → ZcodeApiError kind "throttled".
 */
export async function requestZcodeResetOpportunity({ zcodeJwt, businessToken, idempotencyKey, proxyOptions = null }) {
  try {
    const { json, status } = await zcodeRequest(
      `${ZCODE_ORIGIN}/api/v1/coding-plan/reset/opportunity`,
      {
        method: "POST",
        headers: { ...zcodeResetHeaders(zcodeJwt, businessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      },
      proxyOptions,
    );
    const { code, data } = unwrapZcodeEnvelope(json, status, { acceptedCodes: [3301] });

    if (code === 3301) {
      return { granted: false, nextTryAt: data?.next_try_at ?? null };
    }
    return { granted: true, nextTryAt: null };
  } catch (error) {
    if (error instanceof ZcodeApiError && error.status === 429) {
      throw new ZcodeApiError(error.message, { kind: "throttled", code: error.code, status: error.status });
    }
    throw error;
  }
}
