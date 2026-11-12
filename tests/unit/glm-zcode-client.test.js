import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  ZCODE_APP_VERSION,
  ZCODE_RESET_TYPES,
  ZcodeApiError,
  unwrapZcodeEnvelope,
  fetchZcodeClaimPreview,
  claimZcodePlan,
  fetchZcodePlanBalance,
  fetchZcodeResetStatus,
  useZcodeReset,
  requestZcodeResetOpportunity,
} from "../../open-sse/services/usage/glmZcode.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PLATFORM = `${process.platform}-${process.arch}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unwrapZcodeEnvelope", () => {
  it('accepts code 0 and numeric-string "0"', () => {
    expect(unwrapZcodeEnvelope({ code: 0, data: { ok: 1 } }, 200)).toEqual({
      code: 0,
      data: { ok: 1 },
    });
    expect(unwrapZcodeEnvelope({ code: "0", data: { ok: 2 } }, 200)).toEqual({
      code: 0,
      data: { ok: 2 },
    });
  });

  it("throws business error on code 1003 even with HTTP 200", () => {
    let error = null;
    try {
      unwrapZcodeEnvelope({ code: 1003, msg: "already claimed" }, 200);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(error.code).toBe(1003);
  });

  it("reads business code before HTTP status", () => {
    const result = unwrapZcodeEnvelope({ code: 3301, data: { throttled: true } }, 429, {
      acceptedCodes: [3301],
    });
    expect(result.code).toBe(3301);
    expect(result.data).toEqual({ throttled: true });
  });

  it("business envelope wins over HTTP 4xx auth status", () => {
    let error = null;
    try {
      unwrapZcodeEnvelope({ code: 1003 }, 401);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(error.code).toBe(1003);
  });

  it("maps HTTP 401 without envelope to auth", () => {
    for (const status of [401, 403]) {
      let error = null;
      try {
        unwrapZcodeEnvelope({ error: "unauthorized" }, status);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ZcodeApiError);
      expect(error.kind).toBe("auth");
      expect(error.status).toBe(status);
    }
  });

  it("maps HTTP 500 without envelope to transport", () => {
    let error = null;
    try {
      unwrapZcodeEnvelope({ error: "boom" }, 500);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("transport");
    expect(error.status).toBe(500);
  });
});

describe("fetchZcodeClaimPreview", () => {
  it("normalizes plans and sends bearer + app_version + platform", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          server_time: 1700000000,
          plans: [
            {
              plan_id: "weekend-plan-e2e",
              name: "ZCode Weekend Build",
              priority: 100,
              entitlements: [
                {
                  entitlement_id: "e1",
                  show_name: "GLM-5.3-Flash",
                  grant_units: 300000000,
                  period: "one_time",
                },
              ],
            },
          ],
        },
      })
    );

    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8888" };
    const result = await fetchZcodeClaimPreview({ zcodeJwt: "jwt-x", proxyOptions });

    expect(ZCODE_APP_VERSION).toBe("3.18.0");
    expect(result.serverTime).toBe(1700000000);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].planId).toBe("weekend-plan-e2e");
    expect(result.plans[0].name).toBe("ZCode Weekend Build");
    expect(result.plans[0].priority).toBe(100);
    expect(result.plans[0].entitlements[0].entitlementId).toBe("e1");
    expect(result.plans[0].entitlements[0].showName).toBe("GLM-5.3-Flash");
    expect(result.plans[0].entitlements[0].grantUnits).toBe(300000000);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, passedProxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/zcode-plan/billing/preview");
    expect(url).toContain("app_version=3.18.0");
    expect(url).toContain(`platform=${PLATFORM}`);
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer jwt-x",
      "X-ZCode-App-Version": "3.18.0",
      "X-Platform": PLATFORM,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(passedProxyOptions).toBe(proxyOptions);
  });
});

describe("claimZcodePlan", () => {
  const CLAIM_PLAN = {
    user_plan_id: "up1",
    plan_id: "weekend-plan-e2e",
    status: "active",
    starts_at: 1,
    ends_at: 2,
  };

  it("success requires code 0 and data.plan", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { plan: CLAIM_PLAN } }));

    const result = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "weekend-plan-e2e" });

    expect(result.success).toBe(true);
    expect(result.code).toBe(0);
    expect(result.plan.userPlanId).toBe("up1");
    expect(result.plan.planId).toBe("weekend-plan-e2e");
    expect(result.plan.status).toBe("active");
    expect(result.plan.startsAt).toBe(new Date(1000).toISOString());
    expect(result.plan.endsAt).toBe(new Date(2000).toISOString());

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/zcode-plan/billing/claim");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ plan_id: "weekend-plan-e2e" });
    expect(options.headers).toMatchObject({
      Authorization: "Bearer jwt-x",
      "X-ZCode-App-Version": "3.18.0",
      "X-Platform": PLATFORM,
    });
  });

  it('numeric-string code "0" is success', async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: "0", data: { plan: CLAIM_PLAN } }));

    const result = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "weekend-plan-e2e" });

    expect(result.success).toBe(true);
    expect(result.code).toBe(0);
    expect(result.plan.userPlanId).toBe("up1");
  });

  it("failure surfaces data.message not msg", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 1003, msg: "internal", data: { message: "Já resgatado" } })
    );

    const result = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "weekend-plan-e2e" });

    expect(result.success).toBe(false);
    expect(result.code).toBe(1003);
    expect(result.message).toBe("Já resgatado");
    expect(result.plan).toBeNull();
  });

  it("missing code is failure", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ data: { plan: CLAIM_PLAN } }));

    const result = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "weekend-plan-e2e" });

    expect(result.success).toBe(false);
    expect(result.plan).toBeNull();
  });

  it("missing data.plan is failure", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));

    const result = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "weekend-plan-e2e" });

    expect(result.success).toBe(false);
    expect(result.message).toBe("");
    expect(result.plan).toBeNull();
  });

  it("HTTP 401 throws auth error", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const error = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "p" }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
  });

  it("HTTP 500 without envelope throws transport error", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    const error = await claimZcodePlan({ zcodeJwt: "jwt-x", planId: "p" }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("transport");
    expect(error.status).toBe(500);
  });
});

describe("fetchZcodePlanBalance", () => {
  it("keeps active plans and normalizes string units", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          plans: [
            { plan_id: "p1", name: "ZCode Weekend Build", status: "active" },
            { plan_id: "p2", status: "expired" },
          ],
          balances: [
            {
              plan_id: "p1",
              show_name: "GLM-5.3-Flash",
              total_units: "300000000",
              used_units: "1000",
              remaining_units: "299999000",
              expires_at: 1700086400,
            },
          ],
        },
      })
    );

    const result = await fetchZcodePlanBalance({ apiKey: "key-x" });

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].planId).toBe("p1");
    expect(result.plans[0].name).toBe("ZCode Weekend Build");
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0].planId).toBe("p1");
    expect(result.balances[0].showName).toBe("GLM-5.3-Flash");
    expect(result.balances[0].totalUnits).toBe(300000000);
    expect(result.balances[0].usedUnits).toBe(1000);
    expect(result.balances[0].remainingUnits).toBe(299999000);
    expect(result.balances[0].expiresAt).toBe(new Date(1700086400 * 1000).toISOString());

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/zcode-plan/billing/balance");
    expect(url).toContain("app_version=3.18.0");
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({ Authorization: "Bearer key-x" });
  });

  it("falls back remaining to available then total-used", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          plans: [],
          balances: [
            { plan_id: "p1", total_units: "1000", used_units: "200", available_units: "500" },
            { plan_id: "p1", total_units: "1000", used_units: "200" },
          ],
        },
      })
    );

    const result = await fetchZcodePlanBalance({ apiKey: "key-x" });

    expect(result.balances[0].remainingUnits).toBe(500);
    expect(result.balances[1].remainingUnits).toBe(800);
  });

  it("empty data yields empty arrays", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: null }));

    const result = await fetchZcodePlanBalance({ apiKey: "key-x" });

    expect(result.plans).toEqual([]);
    expect(result.balances).toEqual([]);
    expect(result.serverTime).toBeNull();
  });
});

describe("fetchZcodeResetStatus", () => {
  it("maps available resets and histories", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          available_five_hour_resets: [{ expire_at: 1700000000000 }],
          available_week_resets: [],
          latest_five_hour_reset_history: { used_at: 1699999999000 },
          latest_week_reset_history: null,
          has_unread_history: false,
        },
      })
    );

    const result = await fetchZcodeResetStatus({ zcodeJwt: "jwt-x", businessToken: "biz-x" });

    expect(result.fiveHour[0].expireAt).toBe(1700000000000);
    expect(result.week).toEqual([]);
    expect(result.latestFiveHourUsedAt).toBe(1699999999000);
    expect(result.latestWeekUsedAt).toBeNull();
    expect(result.hasUnreadHistory).toBe(false);

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/coding-plan/reset/status");
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({ Authorization: "Bearer jwt-x" });
  });

  it("sends dual-auth headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));

    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8888" };
    await fetchZcodeResetStatus({ zcodeJwt: "jwt-x", businessToken: "biz-x", proxyOptions });

    const [, options, passedProxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(options.headers).toMatchObject({
      Authorization: "Bearer jwt-x",
      "X-Bigmodel-Authorization": "biz-x",
      "Bigmodel-Target-Type": "PERSONAL",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(passedProxyOptions).toBe(proxyOptions);
  });
});

describe("useZcodeReset", () => {
  it("posts idempotency key and reset type", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { used: true } }));

    const result = await useZcodeReset({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      resetType: "FIVE_HOUR",
      idempotencyKey: "key-1",
    });

    expect(ZCODE_RESET_TYPES).toEqual(["FIVE_HOUR", "WEEK"]);
    expect(result).toEqual({ used: true });

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/coding-plan/reset/use");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ idempotency_key: "key-1", reset_type: "FIVE_HOUR" });
    expect(options.headers).toMatchObject({
      Authorization: "Bearer jwt-x",
      "X-Bigmodel-Authorization": "biz-x",
      "Bigmodel-Target-Type": "PERSONAL",
      "Content-Type": "application/json",
    });
  });

  it("rejects invalid reset type", async () => {
    const error = await useZcodeReset({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      resetType: "DAY",
      idempotencyKey: "key-1",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized idempotency key", async () => {
    const error = await useZcodeReset({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      resetType: "FIVE_HOUR",
      idempotencyKey: "k".repeat(65),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects empty idempotency key", async () => {
    const error = await useZcodeReset({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      resetType: "FIVE_HOUR",
      idempotencyKey: "",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("business error throws", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 2007 }, 400));

    const error = await useZcodeReset({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      resetType: "WEEK",
      idempotencyKey: "key-1",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("business");
    expect(error.code).toBe(2007);
    expect(error.status).toBe(400);
  });
});

describe("requestZcodeResetOpportunity", () => {
  it("granted", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { granted: true } }));

    const result = await requestZcodeResetOpportunity({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ granted: true, nextTryAt: null });

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("/api/v1/coding-plan/reset/opportunity");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ idempotency_key: "key-1" });
    expect(options.headers).toMatchObject({
      Authorization: "Bearer jwt-x",
      "X-Bigmodel-Authorization": "biz-x",
      "Bigmodel-Target-Type": "PERSONAL",
      "Content-Type": "application/json",
    });
  });

  it("denied with next_try_at", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 3301, data: { granted: false, next_try_at: 1700000600000 } })
    );

    const result = await requestZcodeResetOpportunity({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ granted: false, nextTryAt: 1700000600000 });
  });

  it("3301 envelope on HTTP 429 returns denied, not throttled", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 3301, data: { granted: false, next_try_at: 1700000600000 } }, 429)
    );

    const result = await requestZcodeResetOpportunity({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ granted: false, nextTryAt: 1700000600000 });
  });

  it("HTTP 429 without envelope throws throttled", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 429));

    const error = await requestZcodeResetOpportunity({
      zcodeJwt: "jwt-x",
      businessToken: "biz-x",
      idempotencyKey: "key-1",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ZcodeApiError);
    expect(error.kind).toBe("throttled");
    expect(error.status).toBe(429);
  });
});
