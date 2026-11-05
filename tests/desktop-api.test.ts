import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => fixture.invoke(...args),
}));
import { api } from "../src/lib/api";

beforeEach(() => fixture.invoke.mockClear());

it("粘贴私钥与口令只进入认证请求，不冒充私钥文件路径", async () => {
  await api.authenticateConnection("attempt", "test-passphrase", true, "test-private-key-content");
  const args = fixture.invoke.mock.calls[0][1] as Record<string, unknown>;
  expect(fixture.invoke.mock.calls[0][0]).toBe("authenticate_connection");
  expect(args).toEqual({
    attemptId: "attempt", remember: true,
    secret: '{"version":1,"privateKey":"test-private-key-content","passphrase":"test-passphrase"}',
  });
});

it("连接测试使用独立后端通道，且认证不会保存密码", async () => {
  await api.authenticateTestConnection("test-attempt", {
    secret: "test-password", privateKeyContent: null, remember: true,
  });
  expect(fixture.invoke.mock.calls[0]).toEqual([
    "authenticate_test_connection", { attemptId: "test-attempt", secret: "test-password" },
  ]);
});

it("远程文件请求带上明确的会话、路径和操作参数", async () => {
  await api.previewRemoteFile("session", "/logs/app.log");
  await api.remoteFileProperties("session", "/logs/app.log");
  await api.mutateRemoteFile("session", "/logs/app.log", { kind: "rename", name: "old.log" });
  expect(fixture.invoke.mock.calls).toEqual([
    ["preview_remote_file", { sessionId: "session", path: "/logs/app.log" }],
    ["remote_file_properties", { sessionId: "session", path: "/logs/app.log" }],
    ["mutate_remote_file", { sessionId: "session", path: "/logs/app.log", action: { kind: "rename", name: "old.log" } }],
  ]);
});
