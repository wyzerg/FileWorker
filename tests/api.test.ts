import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../src/lib/api";
import type { ConnectionProfile } from "../src/lib/types";

const key = "fileworker.preview.profiles.v1";
const profile: ConnectionProfile = {
  id: "a4a28dd1-d0ed-46c7-ab17-69891881df55", name: "测试",
  host: "test.example.invalid", port: 22, username: "tester",
  authMethod: "password", privateKeyPath: null, remotePath: ".",
};
beforeEach(() => localStorage.clear());

describe("浏览器预览存储", () => {
  it("浏览器拒绝远程连接和凭据操作，不保存认证信息", async () => {
    for (const operation of [
      () => api.probeConnection(profile.id, "attempt"),
      () => api.trustConnection("attempt"),
      () => api.authenticateConnection("attempt", "not-a-real-password", true),
      () => api.cancelConnection("attempt"),
      () => api.listRemoteDirectory("session", "/"),
      () => api.checkSession("session"),
      () => api.disconnectSession("session"),
      () => api.forgetCredential(profile.id),
      () => api.enqueueTransfers([]),
      () => api.transferSnapshot(),
      () => api.cancelTransfer("job"),
      () => api.retryTransfer("job"),
      () => api.resolveTransferConflict("job", "overwrite"),
      () => api.setTransferConcurrency(3),
      () => api.clearFinishedTransfers(),
    ]) {
      await expect(operation()).rejects.toThrow(/桌面应用/);
    }
    expect(localStorage.length).toBe(0);
  });
  it.each([
    "[null]",
    JSON.stringify([{ ...profile, port: "22" }]),
    JSON.stringify([{ ...profile, password: "not-a-real-secret" }]),
    JSON.stringify([{ ...profile, authMethod: "unsupported" }]),
    JSON.stringify([{ ...profile, id: 12 }]),
  ])("拒绝损坏的配置对象而不传给渲染层：%s", async (stored) => {
    localStorage.setItem(key, stored);
    await expect(api.listProfiles()).rejects.toThrow();
    expect(localStorage.getItem(key)).toBe(stored);
  });

  it("损坏配置不会被下一次保存静默覆盖", async () => {
    localStorage.setItem(key, "[null]");
    await expect(api.saveProfile(profile)).rejects.toThrow();
    expect(localStorage.getItem(key)).toBe("[null]");
  });

  it("完整合法配置仍然可以保存和读回", async () => {
    await api.saveProfile(profile);
    expect(await api.listProfiles()).toEqual([profile]);
  });

  it("编辑连接后保持原有顺序，重载与原生配置行为一致", async () => {
    const second = { ...profile, id: "f9fd9ec9-642f-454c-9cb1-fbc8c9b4e6b1", name: "第二个" };
    await api.saveProfile(profile);
    await api.saveProfile(second);
    await api.saveProfile({ ...profile, name: "修改后" });
    expect((await api.listProfiles()).map((item) => item.name)).toEqual(["修改后", "第二个"]);
  });

  it("分组删除后连接保留并移回未分组，旧连接预览数据仍可读取", async () => {
    localStorage.setItem(key, JSON.stringify([profile]));
    const group = { id: "f9fd9ec9-642f-454c-9cb1-fbc8c9b4e6b1", name: "生产环境" };
    await api.saveGroup(group);
    await api.saveProfile({ ...profile, groupId: group.id });
    expect(await api.listGroups()).toEqual([group]);
    expect((await api.listProfiles())[0].groupId).toBe(group.id);
    await api.deleteGroup(group.id);
    expect(await api.listGroups()).toEqual([]);
    expect(await api.listProfiles()).toEqual([{ ...profile, groupId: null }]);
  });
});
