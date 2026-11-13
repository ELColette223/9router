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

  it("preserves the local device MID when importing a backup without it", async () => {
    const originalMid = await db.getOrCreateZcodeDeviceMid();
    await db.updateSettings({ cloudEnabled: true });
    const backup = await db.exportDb();
    backup.settings = { ...backup.settings, cloudEnabled: false };

    await db.importDb(backup);

    expect(await db.getOrCreateZcodeDeviceMid()).toBe(originalMid);
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
