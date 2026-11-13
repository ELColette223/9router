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
});
