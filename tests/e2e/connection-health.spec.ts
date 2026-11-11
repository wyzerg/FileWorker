import { expect, test } from "@playwright/test";

test("焦点恢复清除后台断线状态，保留当前连接和文件列表且不自动重连", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    const profiles = [
      { id: "0a4a976f-ddc8-4e60-8b8f-de2532f0212d", name: "生产连接", host: "production.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
      { id: "a761b759-3b79-4f00-ae1f-f4cdc1e3d947", name: "当前测试连接", host: "staging.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
    ];
    const attempts = new Map<string, string>();
    const active = new Set<string>();
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      isTauri: true,
      __connectionHealth: { calls, drop: (sessionId: string) => active.delete(sessionId) },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return profiles;
            case "list_groups": return [];
            case "credential_status": return { available: true, supported: true };
            case "list_local_directory": return { path: "/local", parentPath: "/", warnings: [], entries: [] };
            case "transfer_snapshot": return { revision: 0, concurrency: 3, jobs: [] };
            case "probe_connection":
              attempts.set(String(args.attemptId), String(args.profileId));
              return {
                attemptId: args.attemptId, trusted: true, host: "fixture.invalid", port: 22,
                identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:isolated-health-test" },
              };
            case "authenticate_connection": {
              const profileId = attempts.get(String(args.attemptId));
              const sessionId = `session-${profileId}`;
              active.add(sessionId);
              return { sessionId, profileId, initialPath: "/remote", warning: null };
            }
            case "check_session":
              if (!active.has(String(args.sessionId))) throw { code: "connection_lost", message: "服务器连接已中断，请重新连接" };
              return;
            case "list_remote_directory": {
              if (!active.has(String(args.sessionId))) throw { code: "session_closed", message: "连接已关闭" };
              const name = args.sessionId === `session-${profiles[0].id}` ? "production.txt" : "staging.txt";
              return {
                path: args.path, parentPath: "/", warnings: [],
                entries: [{ name, path: `/remote/${name}`, isDir: false, isSymlink: false, size: 10, modifiedMs: null, hidden: false }],
              };
            }
            case "disconnect_session": active.delete(String(args.sessionId)); return;
            case "cancel_connection":
            case "plugin:window|set_theme": return;
            default: throw new Error(`Unexpected fixture command: ${command}`);
          }
        },
      },
    });
  });
  await page.goto("/");
  const connections = page.getByRole("navigation", { name: "已保存连接" });
  const production = connections.getByRole("button", { name: /生产连接/ });
  const staging = connections.getByRole("button", { name: /当前测试连接/ });
  const remote = page.getByRole("region", { name: "远程文件", exact: true });
  await production.dblclick();
  await expect(remote.getByText("production.txt", { exact: true })).toBeVisible();
  await staging.dblclick();
  await expect(remote.getByText("staging.txt", { exact: true })).toBeVisible();
  await expect(production.getByText("已连接", { exact: true })).toBeVisible();
  await expect(staging.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByLabel("远程路径").fill("/not-submitted");
  await page.evaluate(() => {
    const fixture = (window as unknown as { __connectionHealth: { drop: (id: string) => void } }).__connectionHealth;
    fixture.drop("session-0a4a976f-ddc8-4e60-8b8f-de2532f0212d");
    window.dispatchEvent(new Event("focus"));
  });

  await expect(production.getByText("已连接", { exact: true })).toHaveCount(0);
  await expect(staging.getByText("已连接", { exact: true })).toBeVisible();
  await expect(staging).toHaveAttribute("aria-pressed", "true");
  await expect(remote.getByText("staging.txt", { exact: true })).toBeVisible();
  await expect(remote.getByRole("button", { name: "断开服务器" })).toBeEnabled();
  await expect(page.getByLabel("远程路径")).toHaveValue("/not-submitted");
  const notice = page.getByRole("button", { name: "查看完整提示" });
  await expect(notice).toContainText("生产连接");
  await expect(notice).toContainText("服务器连接已中断");
  await page.screenshot({ path: testInfo.outputPath("background-disconnected.png") });

  const calls = await page.evaluate(() => (window as unknown as {
    __connectionHealth: { calls: { command: string; args: Record<string, unknown> }[] };
  }).__connectionHealth.calls);
  expect(calls.filter((call) => call.command === "check_session").map((call) => call.args.sessionId)).toEqual([
    "session-0a4a976f-ddc8-4e60-8b8f-de2532f0212d", "session-a761b759-3b79-4f00-ae1f-f4cdc1e3d947",
  ]);
  expect(calls.filter((call) => call.command === "authenticate_connection")).toHaveLength(2);
  expect(calls.filter((call) => call.command === "probe_connection")).toHaveLength(2);
  expect(calls.filter((call) => call.command === "list_remote_directory")).toHaveLength(2);
  expect(calls.filter((call) => call.command === "disconnect_session").map((call) => call.args.sessionId))
    .toEqual(["session-0a4a976f-ddc8-4e60-8b8f-de2532f0212d"]);
  expect(errors).toEqual([]);
});
