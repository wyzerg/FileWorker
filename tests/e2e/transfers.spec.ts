import { expect, test } from "@playwright/test";

test("文件选择、进度、冲突和重试在明暗及窄视口下可用", async ({ page }) => {
  await page.addInitScript(() => {
    const profile = {
      id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "传输验收",
      host: "test.example.invalid", port: 22, username: "tester", authMethod: "password",
      privateKeyPath: null, remotePath: ".",
    };
    let revision = 0;
    let concurrency = 3;
    let jobs: Array<Record<string, unknown>> = [];
    const local = ["报告.csv", "很长的传输文件名称用于验证任务队列不会溢出.bin"].map((name) => ({
      name, path: `/local/${name}`, isDir: false, isSymlink: false, size: 1048576, modifiedMs: null, hidden: false,
    }));
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          const findJob = () => jobs.find((job) => job.id === args.id)!;
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return [profile];
            case "list_local_directory": return { path: "/local", parentPath: "/", entries: local, warnings: [] };
            case "probe_connection": return { attemptId: args.attemptId, host: profile.host, port: 22, trusted: true, identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:test" } };
            case "authenticate_connection": return { sessionId: "session", profileId: profile.id, initialPath: "/", warning: null };
            case "list_remote_directory": return { path: args.path, parentPath: null, entries: [], warnings: [] };
            case "transfer_snapshot": return structuredClone({ revision, concurrency, jobs });
            case "enqueue_transfers":
              jobs = (args.requests as Array<Record<string, string>>).map((request, index) => ({
                ...request, id: `job-${index}`, attempt: 1, name: request.sourcePath.split("/").pop(),
                destinationPath: `${request.destinationDir}${request.sourcePath.split("/").pop()}`,
                state: index === 0 ? "conflict" : "running", transferredBytes: index === 0 ? 0 : 262144,
                totalBytes: 1048576, bytesPerSecond: 131072, etaSeconds: 6, error: null, warning: null,
              }));
              revision += 1; return jobs.map((job) => job.id);
            case "cancel_transfer": findJob().state = "canceled"; revision += 1; return;
            case "retry_transfer": findJob().state = "failed"; findJob().error = "磁盘空间不足，请释放空间后重试"; revision += 1; return;
            case "resolve_transfer_conflict": findJob().state = "completed"; findJob().transferredBytes = 1048576; revision += 1; return;
            case "set_transfer_concurrency": concurrency = Number(args.concurrency); revision += 1; return;
            case "clear_finished_transfers": jobs = []; revision += 1; return;
            case "cancel_connection":
            case "disconnect_session":
            case "plugin:window|set_theme": return;
            default: throw new Error(`未配置命令：${command}`);
          }
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: width === 800 ? 680 : 844 });
      await page.goto("/");
      if (width < 760) await page.getByRole("tab", { name: "远程", exact: true }).click();
      await page.getByRole("button", { name: "连接服务器", exact: true }).click();
      await page.getByLabel("密码", { exact: true }).fill("isolated-test");
      await page.getByRole("dialog").getByRole("button", { name: "连接", exact: true }).click();
      await expect(page.getByRole("button", { name: "断开服务器" })).toBeVisible();
      if (width < 760) await page.getByRole("tab", { name: "本地", exact: true }).click();
      await page.getByLabel("选择全部本地文件").check();
      await page.getByRole("button", { name: "上传所选文件" }).click();
      await expect(page.getByText("同名待处理", { exact: true })).toBeVisible();
      const progress = page.getByRole("progressbar", { name: /很长的传输文件名称/ });
      await expect(progress).toHaveAttribute("value", "262144");
      await page.getByLabel("同时传输数量").selectOption("1");
      await expect(page.getByLabel("同时传输数量")).toHaveValue("1");
      await page.screenshot({ path: `test-results/${theme}-transfers-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const rows = page.locator(".transfer-row");
      for (const row of await rows.all()) {
        expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.getByRole("button", { name: "处理 报告.csv 的同名文件" }).click();
      await expect(page.getByRole("dialog", { name: "同名文件" })).toBeVisible();
      await page.screenshot({ path: `test-results/${theme}-conflict-${width}.png` });
      await page.getByRole("button", { name: "保留两份", exact: true }).click();
      await page.getByRole("button", { name: "取消 很长的传输文件名称用于验证任务队列不会溢出.bin" }).click();
      await page.getByRole("button", { name: "重试 很长的传输文件名称用于验证任务队列不会溢出.bin" }).click();
      await expect(page.getByText("磁盘空间不足，请释放空间后重试", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "清理已结束任务" }).click();
      await expect(page.getByText("暂无传输任务", { exact: true })).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});
