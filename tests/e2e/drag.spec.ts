import { expect, test, type Page } from "@playwright/test";

async function installDesktopFixture(page: Page) {
  await page.addInitScript(() => {
    const profile = {
      id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "拖放验收",
      host: "test.example.invalid", port: 22, username: "tester", authMethod: "password",
      privateKeyPath: null, remotePath: "/remote",
    };
    const file = (name: string, parent: string, isDir = false) => ({
      name, path: `${parent}/${name}`, isDir, isSymlink: false,
      size: isDir ? null : 4, modifiedMs: null, hidden: false,
    });
    const local = [file("报告.csv", "/local"), file("照片名称较长用于检查拖放时布局稳定.txt", "/local"), file("本地子目录", "/local", true)];
    const remote = [file("remote.txt", "/remote"), file("远程子目录", "/remote", true)];
    let revision = 0;
    const jobs: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return [profile];
            case "list_groups": return [];
            case "credential_status": return { available: false, supported: true };
            case "list_local_directory": return { path: "/local", parentPath: "/", warnings: [], entries: local };
            case "probe_connection": return {
              attemptId: args.attemptId, host: profile.host, port: 22, trusted: true,
              identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:test" },
            };
            case "authenticate_connection": return { sessionId: "session", profileId: profile.id, initialPath: "/remote", warning: null };
            case "list_remote_directory": return { path: args.path, parentPath: "/", warnings: [], entries: remote };
            case "transfer_snapshot": return structuredClone({ revision, concurrency: 3, jobs });
            case "enqueue_transfers":
              for (const request of args.requests as Array<Record<string, string>>) {
                jobs.push({
                  ...request, id: `job-${jobs.length}`, name: request.sourcePath.split("/").pop(), attempt: 1,
                  state: "queued", destinationPath: null, transferredBytes: 0, totalBytes: 4,
                  bytesPerSecond: 0, etaSeconds: null, error: null, warning: null,
                });
              }
              revision += 1; return jobs.map((job) => job.id);
            case "cancel_connection":
            case "disconnect_session":
            case "plugin:window|set_theme": return;
            default: throw new Error(`未配置命令：${command}`);
          }
        },
      },
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 800]) {
    test(`${theme} ${width} 双栏实际鼠标拖放上传下载，目标为当前目录`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await installDesktopFixture(page);
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/");
      await page.getByRole("button", { name: "连接服务器", exact: true }).click();
      await page.getByLabel("密码", { exact: true }).fill("isolated-test");
      await page.getByRole("dialog").getByRole("button", { name: "连接", exact: true }).click();
      const localPane = page.getByRole("region", { name: "本地文件", exact: true });
      const remotePane = page.getByRole("region", { name: "远程文件", exact: true });
      const source = localPane.getByRole("row").filter({ hasText: "报告.csv" });
      const destination = remotePane.getByRole("row").filter({ hasText: "远程子目录" });
      await expect(source).toHaveAttribute("draggable", "true");
      await page.getByLabel("选择全部本地文件").check();
      const from = (await source.boundingBox())!;
      const to = (await destination.boundingBox())!;
      const destinationBefore = await destination.boundingBox();
      await page.mouse.move(from.x + 70, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 85, from.y + from.height / 2, { steps: 3 });
      await page.mouse.move(to.x + 70, to.y + to.height / 2, { steps: 8 });
      await expect(remotePane).toHaveClass(/file-pane--drop-target/u);
      expect(await destination.boundingBox()).toEqual(destinationBefore);
      await page.screenshot({ path: `test-results/${theme}-drag-${width}.png` });
      await page.mouse.up();
      const queue = page.getByRole("region", { name: "传输队列" });
      await expect(queue.locator(".transfer-row")).toHaveCount(2);
      await expect(queue.locator(".transfer-direction.upload")).toHaveCount(2);
      await expect(queue.locator(".transfer-file > span").first()).toHaveText("/remote");
      await expect(remotePane).not.toHaveClass(/file-pane--drop-target/u);
      await remotePane.getByRole("row").filter({ hasText: "remote.txt" })
        .dragTo(localPane.locator(".file-list-container"), { targetPosition: { x: 80, y: 160 } });
      await expect(queue.locator(".transfer-row")).toHaveCount(3);
      await expect(queue.locator(".transfer-direction.download")).toHaveCount(1);
      await expect(queue.locator(".transfer-file > span").last()).toHaveText("/local");
      await expect(page.getByLabel("选择 本地子目录")).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(errors).toEqual([]);
    });
  }
}

test("窄视口保留按钮传输，浏览器预览拒绝外部文件放下", async ({ page }) => {
  await installDesktopFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("tab", { name: "远程", exact: true }).click();
  await page.getByRole("button", { name: "连接服务器", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill("isolated-test");
  await page.getByRole("dialog").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByRole("button", { name: "断开服务器" })).toBeVisible();
  await page.getByRole("tab", { name: "本地", exact: true }).click();
  await page.getByLabel("选择 报告.csv").check();
  await page.getByRole("button", { name: "上传所选文件" }).click();
  await expect(page.locator(".transfer-row")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

  const preview = await page.context().newPage();
  await preview.goto("/");
  const data = await preview.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["isolated"], "external.txt"));
    return transfer;
  });
  await preview.locator(".file-pane--remote .file-list-container").dispatchEvent("drop", { dataTransfer: data });
  await expect(preview.getByRole("heading", { name: "FileWorker", exact: true })).toBeVisible();
  await expect(preview.getByText("暂无传输任务", { exact: true })).toBeVisible();
  await data.dispose();
  await preview.close();
});
