import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    genSalt: vi.fn(),
    hash: vi.fn(),
  },
}));

const { GET, PATCH } = await import("@/app/api/settings/route.js");

const DEVICE_MID = "550e8400-e29b-41d4-a716-446655440000";

describe("settings route server-only ZCode device MID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips a client-supplied device MID before updating and responding", async () => {
    mocks.updateSettings.mockResolvedValue({ theme: "dark", zcodeDeviceMid: DEVICE_MID });

    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ theme: "dark", zcodeDeviceMid: DEVICE_MID }),
    }));

    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
    expect(await response.json()).not.toHaveProperty("zcodeDeviceMid");
  });

  it("does not expose the device MID from settings GET", async () => {
    mocks.getSettings.mockResolvedValue({ theme: "dark", zcodeDeviceMid: DEVICE_MID });

    const response = await GET();

    expect(await response.json()).not.toHaveProperty("zcodeDeviceMid");
  });
});
