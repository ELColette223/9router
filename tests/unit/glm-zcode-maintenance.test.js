import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep ZcodeApiError real so instanceof/kind checks work in the maintenance module.
vi.mock("open-sse/services/usage/glmZcode.js", async () => {
  const { ZcodeApiError } = await vi.importActual("open-sse/services/usage/glmZcode.js");
  return {
    ZcodeApiError,
    fetchZcodeClaimPreview: vi.fn(),
    claimZcodePlan: vi.fn(),
    fetchZcodePlanBalance: vi.fn(),
    fetchZcodeResetStatus: vi.fn(),
    requestZcodeResetOpportunity: vi.fn(),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
}));

const NOW = 1700000000000;

function makeConnection(psdOverrides = {}, connOverrides = {}) {
  return {
    id: "c1",
    provider: "glm",
    authType: "oauth",
    accessToken: "ak.sk",
    providerSpecificData: { zcodeJwtToken: "jwt", zaiBusinessToken: "biz", ...psdOverrides },
    ...connOverrides,
  };
}

const emptyStatus = () => ({
  fiveHour: [],
  week: [],
  latestFiveHourUsedAt: null,
  latestWeekUsedAt: null,
  hasUnreadHistory: false,
});
const emptyBalance = () => ({ serverTime: null, plans: [], balances: [] });

describe("glm zcode maintenance", () => {
  let db;
  let isGlmZcodeEligible;
  let runGlmZcodeMaintenance;
  let ZcodeApiError;
  let fetchZcodeClaimPreview;
  let claimZcodePlan;
  let fetchZcodePlanBalance;
  let fetchZcodeResetStatus;
  let requestZcodeResetOpportunity;
  let getProviderConnectionById;
  let updateProviderConnection;
  let getSettings;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    delete globalThis.__glmZcodeMaintenance;

    ({
      ZcodeApiError,
      fetchZcodeClaimPreview,
      claimZcodePlan,
      fetchZcodePlanBalance,
      fetchZcodeResetStatus,
      requestZcodeResetOpportunity,
    } = await import("open-sse/services/usage/glmZcode.js"));
    ({ getProviderConnectionById, updateProviderConnection, getSettings } = await import("@/lib/localDb"));
    ({ isGlmZcodeEligible, runGlmZcodeMaintenance } = await import("@/shared/services/glmZcodeMaintenance.js"));

    // In-memory DB: connection row + settings, merged on update like the real repo.
    db = { connection: makeConnection(), settings: {} };
    getProviderConnectionById.mockImplementation(async (id) =>
      id === db.connection.id ? structuredClone(db.connection) : null,
    );
    updateProviderConnection.mockImplementation(async (id, data) => {
      db.connection = { ...db.connection, ...data };
      return db.connection;
    });
    getSettings.mockImplementation(async () => db.settings);

    fetchZcodeResetStatus.mockResolvedValue(emptyStatus());
    fetchZcodePlanBalance.mockResolvedValue(emptyBalance());
    requestZcodeResetOpportunity.mockResolvedValue({ granted: false, nextTryAt: null });
    fetchZcodeClaimPreview.mockResolvedValue({ serverTime: null, plans: [] });
    claimZcodePlan.mockResolvedValue({ success: true, code: 0, message: "", plan: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for apikey / glm-cn / missing jwt connections", async () => {
    const fixtures = [
      makeConnection({}, { authType: "apikey" }),
      makeConnection({}, { provider: "glm-cn" }),
      makeConnection({ zcodeJwtToken: "" }),
    ];
    for (const conn of fixtures) {
      expect(isGlmZcodeEligible(conn)).toBe(false);
      await expect(runGlmZcodeMaintenance(conn)).resolves.toBeNull();
    }
    expect(fetchZcodeResetStatus).not.toHaveBeenCalled();
    expect(fetchZcodePlanBalance).not.toHaveBeenCalled();
  });

  it("enriches quotas with weekend buckets and reset counts", async () => {
    fetchZcodePlanBalance.mockResolvedValue({
      serverTime: null,
      plans: [
        { planId: "p1", name: "ZCode Weekend Build", status: "active" },
        { planId: "p2", name: "Pro Upgrade", status: "active" },
      ],
      balances: [
        { planId: "p1", showName: "GLM-5.3-Flash", totalUnits: 300000000, usedUnits: 1000, remainingUnits: 299999000, expiresAt: 1700086400 },
        { planId: "p2", showName: "GLM-5.3", totalUnits: 100, usedUnits: 10, remainingUnits: 90, expiresAt: 1700086400 },
      ],
    });
    fetchZcodeResetStatus.mockResolvedValue({ ...emptyStatus(), fiveHour: [{ expireAt: 1700000000000 }] });

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(Object.keys(result.quotas)).toEqual(["Weekend · GLM-5.3-Flash"]);
    expect(result.quotas["Weekend · GLM-5.3-Flash"]).toEqual({
      used: 1000,
      total: 300000000,
      remaining: 299999000,
      remainingPercentage: (299999000 / 300000000) * 100,
      resetAt: new Date(1700086400 * 1000).toISOString(),
      unlimited: false,
    });
    expect(result.zcode.resets.fiveHour).toEqual({ count: 1, soonestExpireAt: 1700000000000 });
    expect(result.zcode.resets.week).toEqual({ count: 0, soonestExpireAt: null });
    expect(result.zcode.claim.autoClaim).toBe(true);
    expect(result.zcode.sessionExpired).toBe(false);
  });

  it("skips opportunity before epoch, calls when due", async () => {
    db.connection = makeConnection({ zcodeNextOpportunityAt: NOW + 1, zcodeNextClaimCheckAt: NOW + 10000000 });
    requestZcodeResetOpportunity.mockResolvedValue({ granted: true, nextTryAt: null });

    await runGlmZcodeMaintenance(db.connection);
    expect(requestZcodeResetOpportunity).not.toHaveBeenCalled();

    // Advance past both the opportunity epoch and the enrichment cache TTL.
    vi.advanceTimersByTime(61000);
    const now2 = Date.now();
    await runGlmZcodeMaintenance(db.connection);

    expect(requestZcodeResetOpportunity).toHaveBeenCalledTimes(1);
    const arg = requestZcodeResetOpportunity.mock.calls[0][0];
    expect(arg.zcodeJwt).toBe("jwt");
    expect(arg.businessToken).toBe("biz");
    expect(typeof arg.idempotencyKey).toBe("string");
    expect(arg.idempotencyKey.length).toBeGreaterThan(0);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(now2 + 600000);
    const payload = updateProviderConnection.mock.calls.at(-1)[1];
    expect(payload.providerSpecificData.zcodeNextOpportunityAt).toBe(now2 + 600000);
    expect(payload.providerSpecificData.zcodeJwtToken).toBe("jwt");
    // Granted → status re-fetched: run 1 once, run 2 initial + re-fetch.
    expect(fetchZcodeResetStatus).toHaveBeenCalledTimes(3);
  });

  it("denied honors next_try_at floor", async () => {
    requestZcodeResetOpportunity.mockResolvedValue({ granted: false, nextTryAt: NOW + 999999999 });
    await runGlmZcodeMaintenance(db.connection);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 999999999);
  });

  it("denied falls back to min retry when next_try_at is in the past", async () => {
    requestZcodeResetOpportunity.mockResolvedValue({ granted: false, nextTryAt: NOW - 5000 });
    await runGlmZcodeMaintenance(db.connection);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 300000);
  });

  it("throttled opportunity backs off 10min", async () => {
    requestZcodeResetOpportunity.mockRejectedValue(new ZcodeApiError("429", { kind: "throttled", status: 429 }));
    const result = await runGlmZcodeMaintenance(db.connection);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 600000);
    expect(result.zcode.sessionExpired).toBe(false);
  });

  it("transport opportunity failure retries in 5min", async () => {
    requestZcodeResetOpportunity.mockRejectedValue(new ZcodeApiError("network down", { kind: "transport" }));
    await runGlmZcodeMaintenance(db.connection);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 300000);
  });

  it("auth opportunity failure marks session expired and backs off 24h", async () => {
    requestZcodeResetOpportunity.mockRejectedValue(new ZcodeApiError("401", { kind: "auth", status: 401 }));
    const result = await runGlmZcodeMaintenance(db.connection);
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 86400000);
    expect(db.connection.providerSpecificData.zcodeSessionExpired).toBe(true);
    expect(result.zcode.sessionExpired).toBe(true);
    // Claim gate is skipped once the session is expired.
    expect(fetchZcodeClaimPreview).not.toHaveBeenCalled();
  });

  it("auto-claim claims only weekend plans", async () => {
    fetchZcodeClaimPreview.mockResolvedValue({
      serverTime: null,
      plans: [
        { name: "ZCode Weekend Build", planId: "w1" },
        { name: "Pro Upgrade", planId: "p1" },
      ],
    });
    claimZcodePlan.mockResolvedValue({
      success: true,
      code: 0,
      message: "",
      plan: { planId: "w1", status: "active", startsAt: null, endsAt: "2026-11-16T00:00:00.000Z", entitlements: [] },
    });

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(claimZcodePlan).toHaveBeenCalledTimes(1);
    expect(claimZcodePlan.mock.calls[0][0]).toMatchObject({ zcodeJwt: "jwt", planId: "w1" });
    expect(db.connection.providerSpecificData.zcodeNextClaimCheckAt).toBe(NOW + 21600000);
    const claimState = db.connection.providerSpecificData.zcodeClaimState;
    expect(claimState.lastClaimedAt).toBeTruthy();
    expect(claimState.planId).toBe("w1");
    expect(claimState.endsAt).toBe("2026-11-16T00:00:00.000Z");
    expect(result.zcode.claim.lastClaimedAt).toBeTruthy();
    expect(result.zcode.claim.available).toBe(false);
  });

  it("auto-claim disabled by settings", async () => {
    db.settings = { glmAutoClaim: { connections: { c1: false } } };
    const result = await runGlmZcodeMaintenance(db.connection);
    expect(fetchZcodeClaimPreview).not.toHaveBeenCalled();
    expect(claimZcodePlan).not.toHaveBeenCalled();
    expect(result.zcode.claim.autoClaim).toBe(false);
  });

  it("empty preview backs off 30min", async () => {
    const result = await runGlmZcodeMaintenance(db.connection);
    expect(claimZcodePlan).not.toHaveBeenCalled();
    expect(db.connection.providerSpecificData.zcodeNextClaimCheckAt).toBe(NOW + 1800000);
    expect(db.connection.providerSpecificData.zcodeClaimState.available).toBe(false);
    expect(result.zcode.claim.available).toBe(false);
  });

  it("failed claim keeps the server message and backs off 30min", async () => {
    fetchZcodeClaimPreview.mockResolvedValue({
      serverTime: null,
      plans: [{ name: "ZCode Weekend Build", planId: "w1" }],
    });
    claimZcodePlan.mockResolvedValue({ success: false, code: 1003, message: "already claimed", plan: null });

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(db.connection.providerSpecificData.zcodeNextClaimCheckAt).toBe(NOW + 1800000);
    expect(db.connection.providerSpecificData.zcodeClaimState.lastError).toBe("already claimed");
    expect(result.zcode.claim.lastError).toBe("already claimed");
  });

  it("fail-open on client errors", async () => {
    // Both display calls down and both gates parked → defaults, never null or throw.
    db.connection = makeConnection({ zcodeNextOpportunityAt: NOW + 10000000, zcodeNextClaimCheckAt: NOW + 10000000 });
    fetchZcodeResetStatus.mockRejectedValue(new ZcodeApiError("down", { kind: "transport" }));
    fetchZcodePlanBalance.mockRejectedValue(new ZcodeApiError("down", { kind: "transport" }));

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(result).toEqual({
      quotas: {},
      zcode: {
        resets: {
          fiveHour: { count: 0, soonestExpireAt: null },
          week: { count: 0, soonestExpireAt: null },
        },
        claim: {
          available: false,
          planId: null,
          planName: null,
          autoClaim: true,
          lastError: null,
          lastClaimedAt: null,
          endsAt: null,
        },
        sessionExpired: false,
      },
    });
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("balance failure still returns status enrichment", async () => {
    fetchZcodeResetStatus.mockResolvedValue({ ...emptyStatus(), week: [{ expireAt: NOW + 5000 }, { expireAt: NOW + 1000 }] });
    fetchZcodePlanBalance.mockRejectedValue(new Error("boom"));

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(result.quotas).toEqual({});
    expect(result.zcode.resets.week).toEqual({ count: 2, soonestExpireAt: NOW + 1000 });
  });

  it("dedupes concurrent runs", async () => {
    let resolveStatus;
    let statusStarted;
    const started = new Promise((resolve) => { statusStarted = resolve; });
    fetchZcodeResetStatus.mockImplementation(() => {
      const pending = new Promise((resolve) => { resolveStatus = resolve; });
      statusStarted();
      return pending;
    });

    const p1 = runGlmZcodeMaintenance(db.connection);
    const p2 = runGlmZcodeMaintenance(db.connection);
    await started; // both calls are in flight before the first status fetch settles
    resolveStatus(emptyStatus());
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchZcodeResetStatus).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("force bypasses enrichment cache", async () => {
    await runGlmZcodeMaintenance(db.connection);
    await runGlmZcodeMaintenance(db.connection);
    expect(fetchZcodeResetStatus).toHaveBeenCalledTimes(1); // second run served from cache

    await runGlmZcodeMaintenance(db.connection, null, { force: true });
    expect(fetchZcodeResetStatus).toHaveBeenCalledTimes(2);
  });

  it("persisted sessionExpired skips gates while status stays unauthorized", async () => {
    db.connection = makeConnection({ zcodeSessionExpired: true });
    fetchZcodeResetStatus.mockRejectedValue(new ZcodeApiError("401", { kind: "auth", status: 401 }));

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(requestZcodeResetOpportunity).not.toHaveBeenCalled();
    expect(fetchZcodeClaimPreview).not.toHaveBeenCalled();
    expect(fetchZcodePlanBalance).toHaveBeenCalledTimes(1); // display still fetched
    expect(result.zcode.sessionExpired).toBe(true);
  });

  it("successful status fetch clears persisted sessionExpired", async () => {
    db.connection = makeConnection({ zcodeSessionExpired: true });

    const result = await runGlmZcodeMaintenance(db.connection);

    expect(result.zcode.sessionExpired).toBe(false);
    expect(db.connection.providerSpecificData.zcodeSessionExpired).toBe(false);
    expect(requestZcodeResetOpportunity).toHaveBeenCalledTimes(1); // gates run again
  });

  it("does not write when nothing changed", async () => {
    db.connection = makeConnection({ zcodeNextOpportunityAt: NOW + 10000000, zcodeNextClaimCheckAt: NOW + 10000000 });
    await runGlmZcodeMaintenance(db.connection);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("merges persisted fields onto a fresh connection read", async () => {
    // Simulate a concurrent writer adding a field between run start and persist.
    getProviderConnectionById.mockImplementation(async () => {
      const fresh = structuredClone(db.connection);
      fresh.providerSpecificData.concurrentField = "keep-me";
      return fresh;
    });

    await runGlmZcodeMaintenance(db.connection);

    const psd = updateProviderConnection.mock.calls.at(-1)[1].providerSpecificData;
    expect(psd.concurrentField).toBe("keep-me");
    expect(psd.zcodeNextOpportunityAt).toBe(NOW + 300000);
    expect(psd.zcodeJwtToken).toBe("jwt");
  });
});