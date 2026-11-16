import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: () => { throw new Error("Browser preview must not invoke desktop commands"); },
}));

import { api } from "../src/lib/api";

it("浏览器不能移除桌面传输记录", async () => {
  await expect(api.removeFinishedTransfer("job")).rejects.toThrow(/桌面应用/);
});
