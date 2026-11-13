import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

describe("ZCode device MID persistence", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-zcode-device-mid-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter()).close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates a stable UUID v4 that is excluded from settings exports", async () => {
    const first = await db.getOrCreateZcodeDeviceMid();
    const second = await db.getOrCreateZcodeDeviceMid();
    const exported = await db.exportSettings();

    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(first)).toBe(true);
    expect(second).toBe(first);
    expect(exported).not.toHaveProperty("zcodeDeviceMid");
  });

  it("preserves the existing local device MID when an import supplies another valid MID", async () => {
    const localMid = await db.getOrCreateZcodeDeviceMid();
    const injectedMid = localMid === "550e8400-e29b-41d4-a716-446655440000"
      ? "550e8400-e29b-41d4-a716-446655440001"
      : "550e8400-e29b-41d4-a716-446655440000";
    const backup = await db.exportDb();
    backup.settings = { ...backup.settings, zcodeDeviceMid: injectedMid };

    await db.importDb(backup);

    expect((await db.getOrCreateZcodeDeviceMid()) === localMid).toBe(true);
    expect(await db.exportDb()).not.toMatchObject({ settings: { zcodeDeviceMid: expect.any(String) } });
  });

  it("drops an imported device MID before creating a new local one", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(`DELETE FROM settings`);

    const backup = await db.exportDb();
    backup.settings = {
      ...backup.settings,
      zcodeDeviceMid: "550e8400-e29b-41d4-a716-446655440000",
    };

    await db.importDb(backup);

    const rawSettings = JSON.parse(adapter.get(`SELECT data FROM settings WHERE id = 1`)?.data || "{}");
    expect(rawSettings).not.toHaveProperty("zcodeDeviceMid");
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(await db.getOrCreateZcodeDeviceMid())).toBe(true);
    expect(await db.exportDb()).not.toMatchObject({ settings: { zcodeDeviceMid: expect.any(String) } });
  });

  it("does not restore an invalid local device MID through import", async () => {
    await db.updateSettings({ zcodeDeviceMid: "invalid-device-mid" });
    const backup = await db.exportDb();

    await db.importDb(backup);

    expect(await db.getSettings()).not.toHaveProperty("zcodeDeviceMid");
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(await db.getOrCreateZcodeDeviceMid())).toBe(true);
    expect(await db.exportDb()).not.toMatchObject({ settings: { zcodeDeviceMid: expect.any(String) } });
  });
});
