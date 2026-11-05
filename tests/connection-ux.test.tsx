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

it("手动输入与已保存密码来回切换不会清空本次输入", async () => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  const user = userEvent.setup();
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: "更换密码" }));
  await user.type(screen.getByLabelText("密码"), "replacement-password");
  await user.click(screen.getByRole("button", { name: "使用已保存的密码" }));
  await user.click(screen.getByRole("button", { name: "更换密码" }));
  expect(screen.getByLabelText("密码")).toHaveValue("replacement-password");
});

it("忘记失败会保留已存状态并显示原因，成功后回到手动输入", async () => {
  fixture.status.mockResolvedValue({ available: true, supported: true });
  fixture.forget.mockRejectedValueOnce(new Error("钥匙串暂不可用"));
  const user = userEvent.setup();
  render(<ConnectionDialog attempt={attempt} working={false} error=""
    onCancel={() => {}} onTrust={async () => {}} onAuthenticate={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: "忘记已保存凭据" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("钥匙串暂不可用");
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

it("保存并连接将认证信息单独传递而不混入配置对象", async () => {
  const user = userEvent.setup();
  let saved: unknown[] = [];
  render(<ProfileDialog profile={null} onSave={async (...args) => { saved = args; }} onClose={() => {}} />);
  await user.type(screen.getByLabelText("连接名称"), "测试环境");
  await user.type(screen.getByLabelText("主机地址"), "test.example.invalid");
  await user.type(screen.getByLabelText("用户名"), "tester");
  await user.type(screen.getByLabelText("密码"), "test-password-only");
  await user.click(screen.getByRole("checkbox", { name: /记住密码/ }));
  await user.click(screen.getByRole("button", { name: "保存并连接" }));
  await waitFor(() => expect(saved).toHaveLength(3));
  expect(saved[0]).not.toHaveProperty("password");
  expect(saved[0]).not.toHaveProperty("secret");
  expect(saved[1]).toEqual({ secret: "test-password-only", privateKeyContent: null, remember: true });
  expect(saved[2]).toBe(true);
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
  fixture.status.mockRejectedValue(new Error("安全存储未接入"));
  render(<ProfileDialog profile={profile} credentialStorage={false} onSave={async () => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeEnabled());
  expect(screen.queryByRole("checkbox", { name: /记住密码/ })).not.toBeInTheDocument();
});
