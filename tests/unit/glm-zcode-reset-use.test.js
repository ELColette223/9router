import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep ZcodeApiError + ZCODE_RESET_TYPES real so instanceof/kind checks and
// type validation work in the reset module.
vi.mock("open-sse/services/usage/glmZcode.js", async () => {
  const { ZcodeApiError, ZCODE_RESET_TYPES } = await vi.importActual("open-sse/services/usage/glmZcode.js");
  return {
    ZcodeApiError,
    ZCODE_RESET_TYPES,
    fetchZcodeResetStatus: vi.fn(),
    useZcodeReset: vi.fn(),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

const NOW = 1700000000000;
const PROXY = {
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: false,
};

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

describe("glm zcode protected reset use", () => {
  let db;
  let useGlmResetProtected;
  let ZcodeApiError;
  let fetchZcodeResetStatus;
  let useZcodeReset;
  let getProviderConnectionById;
  let updateProviderConnection;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    ({ ZcodeApiError, fetchZcodeResetStatus, useZcodeReset } = await import("open-sse/services/usage/glmZcode.js"));
    ({ getProviderConnectionById, updateProviderConnection } = await import("@/lib/localDb"));
    ({ useGlmResetProtected } = await import("@/shared/services/glmZcodeReset.js"));

    // In-memory DB: connection row, shallow-merged on update like the real repo
    // (providerSpecificData is replaced wholesale by the caller's full object).
    db = { connection: makeConnection() };
    getProviderConnectionById.mockImplementation(async (id) =>
      id === db.connection.id ? structuredClone(db.connection) : null,
    );
    updateProviderConnection.mockImplementation(async (id, data) => {
      db.connection = { ...db.connection, ...data };
      return db.connection;
    });

    fetchZcodeResetStatus.mockResolvedValue(emptyStatus());
    useZcodeReset.mockResolvedValue({ used: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists key before calling use", async () => {
    const order = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      order.push("write");
      db.connection = { ...db.connection, ...data };
      return db.connection;
    });
    useZcodeReset.mockImplementation(async () => {
      order.push("use");
      return { used: true };
    });

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR", PROXY);

    expect(result).toEqual({ ok: true });
    // Write-ahead: the pending key is persisted BEFORE /use, then cleared after.
    expect(order).toEqual(["write", "use", "write"]);

    const firstWrite = updateProviderConnection.mock.calls[0][1].providerSpecificData;
    const pending = firstWrite.zcodeResetPending.FIVE_HOUR;
    expect(pending.startedAt).toBe(NOW);
    expect(typeof pending.key).toBe("string");
    expect(pending.key.length).toBeGreaterThan(0);
    expect(pending.key.length).toBeLessThanOrEqual(64);
    // Full merged object: existing fields survive the write.
    expect(firstWrite.zcodeJwtToken).toBe("jwt");
    expect(firstWrite.zaiBusinessToken).toBe("biz");

    expect(useZcodeReset).toHaveBeenCalledTimes(1);
    expect(useZcodeReset.mock.calls[0][0]).toMatchObject({
      zcodeJwt: "jwt",
      businessToken: "biz",
      resetType: "FIVE_HOUR",
      idempotencyKey: pending.key,
      proxyOptions: PROXY,
    });
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
    expect(db.connection.providerSpecificData.zcodeJwtToken).toBe("jwt");
  });

  it("retry after timeout reuses the same key", async () => {
    useZcodeReset.mockRejectedValueOnce(new ZcodeApiError("network down", { kind: "transport" }));

    const first = await useGlmResetProtected(db.connection, "FIVE_HOUR", PROXY);
    expect(first).toEqual({ ok: false, uncertain: true, message: expect.stringMatching(/retry/i) });
    expect(useZcodeReset).toHaveBeenCalledTimes(1);
    const pending = db.connection.providerSpecificData.zcodeResetPending.FIVE_HOUR;
    expect(pending).toBeTruthy();
    expect(pending.key).toBe(useZcodeReset.mock.calls[0][0].idempotencyKey);

    // Retry reads the fresh row; history shows nothing consumed → /use again.
    const fresh = await getProviderConnectionById("c1");
    const second = await useGlmResetProtected(fresh, "FIVE_HOUR", PROXY);

    expect(second).toEqual({ ok: true });
    expect(fetchZcodeResetStatus).toHaveBeenCalledTimes(1);
    expect(fetchZcodeResetStatus.mock.calls[0][0]).toMatchObject({ zcodeJwt: "jwt", businessToken: "biz", proxyOptions: PROXY });
    expect(useZcodeReset).toHaveBeenCalledTimes(2);
    const keys = useZcodeReset.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[1]).toBe(pending.key);
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
  });

  it("reconciles consumed attempt via history", async () => {
    db.connection = makeConnection({
      zcodeResetPending: {
        FIVE_HOUR: { key: "k1", startedAt: NOW },
        WEEK: { key: "kw", startedAt: NOW - 5000 },
      },
    });
    fetchZcodeResetStatus.mockResolvedValue({ ...emptyStatus(), latestFiveHourUsedAt: NOW + 1 });

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

    expect(result).toEqual({ ok: true, alreadyReset: true });
    expect(useZcodeReset).not.toHaveBeenCalled();
    // Only the reconciled type's entry is removed; the other type survives.
    expect(db.connection.providerSpecificData.zcodeResetPending).toEqual({
      WEEK: { key: "kw", startedAt: NOW - 5000 },
    });
  });

  it("reconciles WEEK via latestWeekUsedAt at the startedAt boundary", async () => {
    db.connection = makeConnection({ zcodeResetPending: { WEEK: { key: "kw", startedAt: NOW } } });
    // Five-hour history is newer but must not satisfy a WEEK reconciliation.
    fetchZcodeResetStatus.mockResolvedValue({
      ...emptyStatus(),
      latestFiveHourUsedAt: NOW + 999999,
      latestWeekUsedAt: NOW, // >= startedAt boundary
    });

    const result = await useGlmResetProtected(db.connection, "WEEK");

    expect(result).toEqual({ ok: true, alreadyReset: true });
    expect(useZcodeReset).not.toHaveBeenCalled();
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
  });

  it("definitive business error clears pending", async () => {
    useZcodeReset.mockRejectedValue(
      new ZcodeApiError("ZCode API business error 2007: no reset opportunity", { kind: "business", code: 2007 }),
    );

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.message).toMatch(/2007/);
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
  });

  it("auth error clears pending and reports re-login", async () => {
    useZcodeReset.mockRejectedValue(new ZcodeApiError("401", { kind: "auth", status: 401 }));

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

    expect(result.ok).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.message).toMatch(/re-login/i);
    expect(result.status).toBe(401);
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
  });

  it("success bumps opportunity epoch", async () => {
    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");
    expect(result).toEqual({ ok: true });
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 120000);

    // max(current, now+bump): a later existing epoch is never moved backwards.
    db.connection = makeConnection({ zcodeNextOpportunityAt: NOW + 600000 });
    await useGlmResetProtected(db.connection, "WEEK");
    expect(db.connection.providerSpecificData.zcodeNextOpportunityAt).toBe(NOW + 600000);
  });

  it("rejects invalid reset type without network", async () => {
    const result = await useGlmResetProtected(db.connection, "DAY");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/DAY/);
    expect(useZcodeReset).not.toHaveBeenCalled();
    expect(fetchZcodeResetStatus).not.toHaveBeenCalled();
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each(["transport", "throttled"])(
    "reconciliation %s failure keeps pending and does not consume",
    async (kind) => {
      db.connection = makeConnection({ zcodeResetPending: { FIVE_HOUR: { key: "k1", startedAt: NOW } } });
      fetchZcodeResetStatus.mockRejectedValue(new ZcodeApiError("status down", { kind }));

      const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

      expect(result).toEqual({ ok: false, uncertain: true, message: expect.stringMatching(/retry/i) });
      expect(useZcodeReset).not.toHaveBeenCalled();
      expect(db.connection.providerSpecificData.zcodeResetPending.FIVE_HOUR).toEqual({ key: "k1", startedAt: NOW });
    },
  );

  it("reconciliation auth failure clears pending and reports re-login", async () => {
    db.connection = makeConnection({ zcodeResetPending: { FIVE_HOUR: { key: "k1", startedAt: NOW } } });
    fetchZcodeResetStatus.mockRejectedValue(new ZcodeApiError("401", { kind: "auth", status: 401 }));

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/re-login/i);
    expect(useZcodeReset).not.toHaveBeenCalled();
    expect(db.connection.providerSpecificData.zcodeResetPending).toBeUndefined();
  });

  it("unexpected use error keeps pending as uncertain", async () => {
    useZcodeReset.mockRejectedValue(new Error("boom"));

    const result = await useGlmResetProtected(db.connection, "FIVE_HOUR");

    expect(result).toEqual({ ok: false, uncertain: true, message: expect.stringMatching(/retry/i) });
    expect(db.connection.providerSpecificData.zcodeResetPending.FIVE_HOUR).toBeTruthy();
  });

  it("write-ahead persist failure never calls use", async () => {
    updateProviderConnection.mockRejectedValueOnce(new Error("db down"));

    await expect(useGlmResetProtected(db.connection, "FIVE_HOUR")).rejects.toThrow("db down");
    expect(useZcodeReset).not.toHaveBeenCalled();
    expect(fetchZcodeResetStatus).not.toHaveBeenCalled();
  });
});
