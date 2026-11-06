import { expect, test } from "@playwright/test";

test("切换已连接服务器保持目录和后台传输，仅显式断开目标连接", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    const profiles = [
      { id: "0a4a976f-ddc8-4e60-8b8f-de2532f0212d", name: "生产环境", host: "production.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
      { id: "a761b759-3b79-4f00-ae1f-f4cdc1e3d947", name: "测试环境", host: "staging.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
    ];
    const attempts = new Map<string, string>();
    const active = new Set<string>();
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    let jobs: Record<string, unknown>[] = [];
    let revision = 0;
    const entry = (path: string, isDir = false) => ({
      path, name: path.slice(path.lastIndexOf("/") + 1), isDir, isSymlink: false,
      size: isDir ? null : 10, modifiedMs: null, hidden: false,
    });
    Object.assign(window, {
      isTauri: true,
      __multi: {
        calls, active,
        complete: () => {
          jobs = jobs.map((job) => ({ ...job, state: "completed", transferredBytes: 10, bytesPerSecond: 0, etaSeconds: null }));
          revision += 1;
        },
      },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return profiles;
            case "list_groups": return [];
            case "credential_status": return { available: true, supported: true };
            case "list_local_directory": return { path: "/local", parentPath: "/", warnings: [], entries: [entry("/local/upload.txt")] };
            case "probe_connection":
              attempts.set(String(args.attemptId), String(args.profileId));
              return { attemptId: args.attemptId, trusted: true, host: "fixture.invalid", port: 22,
                identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:isolated" } };
            case "authenticate_connection": {
              const profileId = attempts.get(String(args.attemptId));
              const sessionId = `session-${profileId}`;
              active.add(sessionId);
              return { sessionId, profileId, initialPath: "/", warning: null };
            }
            case "list_remote_directory": {
              if (!active.has(String(args.sessionId))) throw { code: "session_closed", message: "连接已关闭" };
              const path = String(args.path);
              const entries = path === "/" ? [entry("/folder", true)] : [entry(`${path}/server.txt`)];
              if (jobs.some((job) => job.state === "completed" && job.sessionId === args.sessionId && job.destinationDir === path)) {
                entries.push(entry(`${path}/upload.txt`));
              }
              return { path, parentPath: path === "/" ? null : "/", warnings: [], entries };
            }
            case "enqueue_transfers":
              jobs = (args.requests as Record<string, unknown>[]).map((request, index) => ({
                ...request, id: `job-${index}`, name: "upload.txt", attempt: 1, state: "running",
                destinationPath: `${request.destinationDir}/upload.txt`, transferredBytes: 1, totalBytes: 10,
                bytesPerSecond: 1, etaSeconds: 9, error: null, warning: null,
              }));
              revision += 1;
              return jobs.map((job) => job.id);
            case "transfer_snapshot": return { revision, concurrency: 3, jobs };
            case "disconnect_session": active.delete(String(args.sessionId)); return;
            case "cancel_connection":
            case "plugin:window|set_theme": return;
            default: throw new Error(`Unexpected fixture command: ${command}`);
          }
        },
      },
    });
  });
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: 820 });
      await page.goto("/");
      async function select(name: string) {
        if (width < 760) await page.getByRole("button", { name: "切换侧栏" }).click();
        await page.getByRole("navigation", { name: "已保存连接" }).getByRole("button", { name: new RegExp(name) }).click();
      }
      async function connect(name: string) {
        await select(name);
        await page.getByRole("button", { name: "连接服务器", exact: true }).click();
        await expect(page.getByRole("button", { name: "断开服务器" })).toBeEnabled();
        await expect(page.getByLabel("远程路径")).toHaveValue("/");
      }
      await connect("生产环境");
      await page.getByText("folder", { exact: true }).dblclick();
      await expect(page.getByLabel("远程路径")).toHaveValue("/folder");
      if (width < 760) await page.getByRole("tab", { name: "本地", exact: true }).click();
      await page.getByLabel("选择 upload.txt").check();
      await page.getByRole("button", { name: "上传所选文件" }).click();
      await expect(page.getByRole("button", { name: "取消 upload.txt" })).toBeVisible();
      if (width < 760) await page.getByRole("tab", { name: "远程", exact: true }).click();
      await page.getByLabel("远程路径").fill("/unsubmitted");
      await connect("测试环境");
      const getCalls = () => page.evaluate(() => (window as unknown as {
        __multi: { calls: { command: string; args: Record<string, unknown> }[] };
      }).__multi.calls);
      expect((await getCalls()).filter((call) => call.command === "disconnect_session")).toHaveLength(0);
      await expect(page.getByRole("button", { name: "取消 upload.txt" })).toBeEnabled();
      if (width < 760) await page.getByRole("button", { name: "切换侧栏" }).click();
      await expect(page.getByRole("navigation", { name: "已保存连接" }).getByText("已连接")).toHaveCount(2);
      await page.screenshot({ path: `test-results/multiple-connections-${theme}-${width}.png` });
      if (width < 760) await page.getByRole("button", { name: "关闭侧栏" }).click();
      await page.evaluate(() => (window as unknown as { __multi: { complete: () => void } }).__multi.complete());
      await expect(page.getByRole("button", { name: "清理已结束任务" })).toBeEnabled();
      await select("生产环境");
      await expect(page.getByLabel("远程路径")).toHaveValue("/unsubmitted");
      await expect(page.getByText("server.txt", { exact: true })).toBeVisible();
      await page.getByLabel("远程路径").fill("/folder");
      await expect(page.getByRole("region", { name: "远程文件", exact: true }).getByText("upload.txt", { exact: true })).toBeVisible();
      await select("测试环境");
      await page.getByRole("button", { name: "断开服务器" }).click();
      await expect(page.getByRole("button", { name: "连接服务器", exact: true })).toBeVisible();
      await select("生产环境");
      await expect(page.getByRole("button", { name: "断开服务器" })).toBeEnabled();
      await expect(page.getByLabel("远程路径")).toHaveValue("/folder");
      const calls = await getCalls();
      expect(calls.filter((call) => call.command === "authenticate_connection")).toHaveLength(2);
      expect(calls.filter((call) => call.command === "disconnect_session").map((call) => call.args.sessionId))
        .toEqual(["session-a761b759-3b79-4f00-ae1f-f4cdc1e3d947"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
  }
});
