import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/ProfileDialog";
import { ConnectionDialog } from "../src/components/ConnectionDialog";
import type { ConnectionAttempt, ConnectionProfile } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  status: vi.fn(), probe: vi.fn(), authenticate: vi.fn(), trust: vi.fn(), cancel: vi.fn(), forget: vi.fn(),
}));
vi.mock("../src/lib/api", () => ({
  isDesktop: true,
  errorMessage: (error: unknown) => (error as { message?: string }).message ?? String(error),
  errorCode: (error: unknown) => (error as { code?: string }).code,
  api: {
    credentialStatus: (...args: unknown[]) => fixture.status(...args),
    forgetCredential: (...args: unknown[]) => fixture.forget(...args),
    choosePrivateKey: async () => null,
    probeDraftConnection: (...args: unknown[]) => fixture.probe(...args),
    authenticateTestConnection: (...args: unknown[]) => fixture.authenticate(...args),
    trustTestConnection: (...args: unknown[]) => fixture.trust(...args),
    cancelTestConnection: (...args: unknown[]) => fixture.cancel(...args),
  },
}));

const profile: ConnectionProfile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "隔离连接",
  host: "test.example.invalid", port: 22, username: "tester",
  authMethod: "password", privateKeyPath: null, remotePath: ".",
};
const attempt: ConnectionAttempt = { id: "test-attempt", profile, phase: "auth" };
const credentialMethods = [
  ["password", "连接成功后记住密码"],
  ["privateKey", "连接成功后记住私钥口令"],
  ["privateKeyContent", "连接成功后记住私钥和口令"],
] as const;

beforeEach(() => {
  fixture.status.mockReset().mockResolvedValue({ available: false, supported: true });
  fixture.probe.mockReset().mockImplementation(async (_profile, attemptId) => ({
    attemptId, host: profile.host, port: 22, trusted: true,
    identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:isolated" },
  }));
  fixture.authenticate.mockReset().mockResolvedValue({
    sessionId: "test-session", profileId: profile.id, initialPath: "/", warning: null,
  });
  fixture.trust.mockReset().mockResolvedValue(undefined);
  fixture.cancel.mockReset().mockResolvedValue(undefined);
  fixture.forget.mockReset().mockResolvedValue(undefined);
});

it("从粘贴私钥切回密码时，不会把私钥内容作为密码发送", async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);
  render(<ProfileDialog profile={profile} onSave={save} onClose={() => {}} />);
  await user.click(screen.getByRole("radio", { name: "SSH 私钥" }));
  await user.click(screen.getByRole("radio", { name: "粘贴私钥" }));
  await user.type(screen.getByLabelText("私钥内容"), "isolated-private-key-not-a-password");
  await user.click(screen.getByRole("radio", { name: "密码认证" }));
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  await user.click(screen.getByRole("button", { name: "保存并连接" }));
  expect(save.mock.calls[0][1]).toEqual({ secret: "test-password-only", privateKeyContent: null, remember: false });
});

it("编辑主机地址后，不会复用原地址已保存的密码", async () => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  const user = userEvent.setup();
  render(<ProfileDialog profile={profile} onSave={async () => {}} onClose={() => {}} />);
  await screen.findByText("已保存密码");
  await user.clear(screen.getByLabelText("主机地址"));
  await user.type(screen.getByLabelText("主机地址"), "other.example.invalid");
  expect(screen.queryByText("已保存密码")).not.toBeInTheDocument();
  expect(screen.getByLabelText("密码")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  expect(fixture.probe).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("请输入服务器密码");
});

it("测试连接仍需明确信任指纹，记住选项不进入测试认证", async () => {
  fixture.probe.mockResolvedValue({
    attemptId: "draft", host: profile.host, port: profile.port, trusted: false,
    identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:isolated-test" },
  });
  const user = userEvent.setup();
  render(<ProfileDialog profile={profile} onSave={async () => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  await user.click(screen.getByRole("checkbox", { name: /记住密码/ }));
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByRole("region", { name: "确认服务器指纹" })).toHaveTextContent("SHA256:isolated-test");
  expect(fixture.authenticate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "信任并测试" }));
  expect(await screen.findByRole("status")).toHaveTextContent("连接测试成功");
  expect(fixture.authenticate).toHaveBeenCalledWith(expect.any(String), {
    secret: "test-password-only", privateKeyContent: null, remember: false,
  });
  expect(fixture.cancel).toHaveBeenCalled();
});

it("取消测试后迟到的探测不再进入认证，草稿和密码保持", async () => {
  let finish!: (value: unknown) => void;
  fixture.probe.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup();
  render(<ProfileDialog profile={profile} onSave={async () => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  await user.click(screen.getByRole("button", { name: "取消测试" }));
  await act(async () => { finish({ trusted: true }); });
  expect(fixture.authenticate).not.toHaveBeenCalled();
  expect(screen.getByLabelText("密码")).toHaveValue("test-password-only");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
});

it.each(credentialMethods)("%s 手动输入与本机已存凭据来回切换不会清空本次输入", async (authMethod) => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  const privateKey = authMethod !== "password";
  const authProfile = { ...profile, authMethod, privateKeyPath: authMethod === "privateKey" ? "/isolated/id_ed25519" : null };
  render(<ConnectionDialog attempt={{ ...attempt, profile: authProfile }} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={submit} />);
  const saved = await screen.findByText(privateKey ? "已保存私钥凭据" : "已保存密码");
  expect(saved).toHaveAccessibleDescription(/本机.*加密保存.*下次连接.*自动使用/);
  await user.click(screen.getByRole("button", { name: "连接" }));
  expect(submit).toHaveBeenLastCalledWith(null, false, null);
  await user.click(screen.getByRole("button", { name: privateKey ? "更换凭据" : "更换密码" }));
  await user.type(screen.getByLabelText(privateKey ? "私钥口令" : "密码"), "replacement-secret");
  if (authMethod === "privateKeyContent") {
    await user.type(screen.getByLabelText("私钥内容"), "replacement-private-key");
  }
  await user.click(screen.getByRole("button", { name: privateKey ? "使用已保存的私钥凭据" : "使用已保存的密码" }));
  await user.click(screen.getByRole("button", { name: "连接" }));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit).toHaveBeenLastCalledWith(null, false, null);
  await user.click(screen.getByRole("button", { name: privateKey ? "更换凭据" : "更换密码" }));
  expect(screen.getByLabelText(privateKey ? "私钥口令" : "密码")).toHaveValue("replacement-secret");
  if (authMethod === "privateKeyContent") {
    expect(screen.getByLabelText("私钥内容")).toHaveValue("replacement-private-key");
  }
  await user.click(screen.getByRole("button", { name: "连接" }));
  expect(submit).toHaveBeenLastCalledWith("replacement-secret", false,
    authMethod === "privateKeyContent" ? "replacement-private-key" : null);
});

it("忘记失败会保留已存状态并显示原因，成功后回到手动输入", async () => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  fixture.forget.mockRejectedValueOnce(new Error("本地凭据存储暂不可用"));
  const user = userEvent.setup();
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: "忘记已保存凭据" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("本地凭据存储暂不可用");
  expect(screen.getByText("已保存密码")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "忘记已保存凭据" }));
  expect(await screen.findByLabelText("密码")).toBeInTheDocument();
  expect(screen.queryByText("已保存密码")).not.toBeInTheDocument();
});

it("新建连接直接提供密码和记住密码选项", async () => {
  render(<ProfileDialog profile={null} onSave={async () => {}} onClose={() => {}} />);
  expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
  expect(screen.getByRole("checkbox", { name: /记住密码/ })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "测试连接" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存并连接" })).toBeInTheDocument();
});

it.each(credentialMethods)("%s 记住选项说明本机加密、自动复用及密钥风险，取消勾选后不保存", async (authMethod, rememberName) => {
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  const authProfile = { ...profile, authMethod, privateKeyPath: authMethod === "privateKey" ? "/isolated/id_ed25519" : null };
  render(<ConnectionDialog attempt={{ ...attempt, profile: authProfile }} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={submit} />);
  const remember = await screen.findByRole("checkbox", { name: rememberName });
  expect(remember).not.toBeChecked();
  expect(remember).toHaveAccessibleDescription(/本机.*加密保存.*下次连接.*自动使用/);
  expect(remember).toHaveAccessibleDescription(/密钥.*本机.*读取.*密钥.*凭据.*解密/);
  expect(remember.closest("label")).toHaveAttribute("title", expect.stringMatching(/本机.*加密保存/));
  await user.type(screen.getByLabelText(authMethod === "password" ? "密码" : "私钥口令"), "temporary-secret");
  if (authMethod === "privateKeyContent") {
    await user.type(screen.getByLabelText("私钥内容"), "temporary-private-key");
  }
  await user.click(remember);
  expect(remember).toBeChecked();
  await user.click(remember);
  expect(remember).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "连接" }));
  expect(submit).toHaveBeenCalledWith("temporary-secret", false,
    authMethod === "privateKeyContent" ? "temporary-private-key" : null);
});

it("SSH 认证支持粘贴私钥内容和单独的私钥口令", async () => {
  const user = userEvent.setup();
  render(<ProfileDialog profile={null} onSave={async () => {}} onClose={() => {}} />);
  await user.click(screen.getByRole("radio", { name: /SSH 私钥/ }));
  await user.click(screen.getByRole("radio", { name: "粘贴私钥" }));
  expect(screen.getByLabelText("私钥内容")).toHaveProperty("tagName", "TEXTAREA");
  expect(screen.getByLabelText("私钥口令")).toHaveAttribute("type", "password");
  expect(screen.queryByLabelText("私钥文件")).not.toBeInTheDocument();
});

it("没有保存过密码时不提供无效的已存凭据开关", async () => {
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  await screen.findByLabelText("密码");
  await waitFor(() => expect(screen.queryByLabelText("使用已保存的凭据")).not.toBeInTheDocument());
  expect(screen.queryByText("已保存密码")).not.toBeInTheDocument();
});

it("存在已存密码时显示状态，并且可以明确更换密码", async () => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  const user = userEvent.setup();
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  expect(await screen.findByText("已保存密码")).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "更换密码" }));
  expect(screen.getByLabelText("密码")).toHaveFocus();
});

it("认证失败后保留本次输入，允许修改后重试", async () => {
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  const view = render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={submit} />);
  await user.type(await screen.findByLabelText("密码"), "wrong-password");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "连接" }));
  view.rerender(<ConnectionDialog attempt={attempt} working={false} error="密码不正确"
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={submit} />);
  expect(screen.getByLabelText("密码")).toHaveValue("wrong-password");
  expect(screen.getByRole("alert")).toHaveTextContent("密码不正确");
});

it("自动认证失败后，迟到的凭据状态不能把手动输入切回已存模式", async () => {
  let finish!: (value: unknown) => void;
  fixture.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<ConnectionDialog attempt={{ ...attempt, phase: "probing" }} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  view.rerender(<ConnectionDialog attempt={attempt} working={false} error="已存密码失效"
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  await act(async () => { finish({ available: true, supported: true }); });
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  expect(screen.queryByText("已保存密码")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("已存密码失效");
});

it("测试草稿连接不保存配置，测试成功后回到保留输入的编辑表单", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  render(<ProfileDialog profile={null} onSave={save} onClose={() => {}} />);
  await user.type(screen.getByLabelText("连接名称"), "测试环境");
  await user.type(screen.getByLabelText("主机地址"), "test.example.invalid");
  await user.type(screen.getByLabelText("用户名"), "tester");
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByRole("status")).toHaveTextContent("连接测试成功");
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("密码")).toHaveValue("test-password-only");
  expect(screen.getByLabelText("连接名称")).toHaveValue("测试环境");
});

it.each(credentialMethods)("%s 勾选记住后保存并连接将认证信息与配置分开", async (authMethod, rememberName) => {
  const user = userEvent.setup();
  let saved: unknown[] = [];
  render(<ProfileDialog profile={null} onSave={async (...args) => { saved = args; }} onClose={() => {}} />);
  await user.type(screen.getByLabelText("连接名称"), "测试环境");
  await user.type(screen.getByLabelText("主机地址"), "test.example.invalid");
  await user.type(screen.getByLabelText("用户名"), "tester");
  if (authMethod !== "password") {
    await user.click(screen.getByRole("radio", { name: "SSH 私钥" }));
    if (authMethod === "privateKey") {
      await user.type(screen.getByLabelText("私钥文件"), "/isolated/id_ed25519");
    } else {
      await user.click(screen.getByRole("radio", { name: "粘贴私钥" }));
    }
  }
  const remember = screen.getByRole("checkbox", { name: rememberName });
  await waitFor(() => expect(remember).toBeEnabled());
  expect(remember).not.toBeChecked();
  await user.type(screen.getByLabelText(authMethod === "password" ? "密码" : "私钥口令"), "test-secret-only");
  if (authMethod === "privateKeyContent") {
    await user.type(screen.getByLabelText("私钥内容"), "test-private-key-only");
  }
  await user.click(remember);
  expect(remember).toBeChecked();
  await user.click(screen.getByRole("button", { name: "保存并连接" }));
  await waitFor(() => expect(saved).toHaveLength(3));
  expect(saved[0]).toEqual({
    id: expect.any(String), name: "测试环境", host: "test.example.invalid", port: 22, username: "tester",
    authMethod, privateKeyPath: authMethod === "privateKey" ? "/isolated/id_ed25519" : null,
    remotePath: ".", groupId: null,
  });
  expect(saved[1]).toEqual({
    secret: "test-secret-only", privateKeyContent: authMethod === "privateKeyContent" ? "test-private-key-only" : null,
    remember: true,
  });
  expect(saved[2]).toBe(true);
});

it.each(credentialMethods)("%s 即使勾选记住，仅保存配置也不传递认证秘密", async (authMethod, rememberName) => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);
  const authProfile = { ...profile, authMethod, privateKeyPath: authMethod === "privateKey" ? "/isolated/id_ed25519" : null };
  render(<ProfileDialog profile={authProfile} onSave={save} onClose={() => {}} />);
  const remember = screen.getByRole("checkbox", { name: rememberName });
  await waitFor(() => expect(remember).toBeEnabled());
  await user.type(screen.getByLabelText(authMethod === "password" ? "密码" : "私钥口令"), "unsaved-secret");
  if (authMethod === "privateKeyContent") {
    await user.type(screen.getByLabelText("私钥内容"), "unsaved-private-key");
  }
  await user.click(remember);
  expect(remember).toBeChecked();
  await user.click(screen.getByRole("button", { name: "仅保存配置" }));
  expect(save).toHaveBeenCalledWith({ ...authProfile, groupId: null },
    { secret: "", privateKeyContent: null, remember: false }, false);
});

it("同一帧重复提交表单只保存一次", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<ProfileDialog profile={profile} onSave={save} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  const form = screen.getByRole("button", { name: "保存并连接" }).closest("form")!;
  await act(async () => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});

it("不支持安全存储的平台不显示记住密码，配置保存也不携带认证秘密", async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);
  render(<ProfileDialog profile={null} credentialStorage={false} onSave={save} onClose={() => {}} />);
  expect(screen.queryByRole("checkbox", { name: /记住密码/ })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("连接名称"), "临时连接");
  await user.type(screen.getByLabelText("主机地址"), "test.example.invalid");
  await user.type(screen.getByLabelText("用户名"), "tester");
  await user.type(screen.getByLabelText("密码"), "unsaved-password");
  await user.click(screen.getByRole("button", { name: "仅保存配置" }));
  expect(save.mock.calls[0][0]).not.toHaveProperty("secret");
  expect(save.mock.calls[0][1]).toEqual({ secret: "", privateKeyContent: null, remember: false });
  expect(save.mock.calls[0][2]).toBe(false);
});

it("凭据状态查询失败不会重新启用平台明确禁用的记住密码功能", async () => {
  fixture.status.mockRejectedValue(new Error("本地凭据存储未接入"));
  render(<ProfileDialog profile={profile} credentialStorage={false} onSave={async () => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  expect(screen.queryByRole("checkbox", { name: /记住密码/ })).not.toBeInTheDocument();
});

it("本地凭据状态查询失败后仍可手动临时认证", async () => {
  fixture.status.mockRejectedValue(new Error("本地凭据存储损坏"));
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={submit} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("本地凭据存储损坏，可重新输入后连接");
  await user.type(screen.getByLabelText("密码"), "temporary-password");
  expect(screen.getByRole("checkbox", { name: "连接成功后记住密码" })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "连接" }));
  expect(submit).toHaveBeenCalledWith("temporary-password", false, null);
});
