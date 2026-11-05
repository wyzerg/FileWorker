import { expect, test, type Page } from "@playwright/test";

async function installFixture(page: Page) {
  await page.addInitScript(() => {
    const profile = {
      id: "c83f782d-1334-40f3-9905-ed2f9c4ae61f", name: "测试环境应用服务器", host: "isolated.example.invalid",
      port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "/remote",
    };
    const entry = (name: string, isDir = false) => ({
      name, path: `/remote/${name}`, isDir, isSymlink: false, size: isDir ? null : 4096,
      modifiedMs: 1793836800000, hidden: false,
    });
    let entries = [entry("logs", true), entry("应用程序运行日志.log"), entry("status.png")];
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    Object.assign(window, {
      isTauri: true, __remoteFilesFixture: { calls },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return [profile];
            case "list_groups": return [];
            case "credential_status": return { available: true, supported: true };
            case "list_local_directory": return { path: "/local", parentPath: "/", entries: [
              { ...entry("packages", true), path: "/local/packages" },
              { ...entry("本地文件说明.txt"), path: "/local/本地文件说明.txt" },
            ], warnings: [] };
            case "transfer_snapshot": return { revision: 0, concurrency: 3, jobs: [] };
            case "probe_connection": return { attemptId: args.attemptId, host: profile.host, port: 22, trusted: true,
              identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:generated-only" } };
            case "authenticate_connection": return { sessionId: "remote-files-session", profileId: profile.id, initialPath: "/remote", warning: null };
            case "list_remote_directory": return { path: args.path, parentPath: args.path === "/" ? null : "/remote",
              entries: args.path === "/remote" ? entries : [], warnings: [] };
            case "preview_remote_file":
              if (String(args.path).endsWith(".png")) {
                const canvas = document.createElement("canvas");
                canvas.width = 480; canvas.height = 240;
                const context = canvas.getContext("2d")!;
                context.fillStyle = "#eef7f4"; context.fillRect(0, 0, 480, 240);
                context.fillStyle = "#168363"; context.fillRect(36, 36, 120, 168);
                context.fillStyle = "#4f79c8"; context.fillRect(176, 76, 120, 128);
                context.fillStyle = "#d4893d"; context.fillRect(316, 116, 120, 88);
                return { kind: "image", path: args.path, mime: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
              }
              return { kind: "text", path: args.path, text: `<script>不会执行</script>\n${"2026-11-05 INFO 服务运行正常\n".repeat(40)}${"long-log-field".repeat(150)}` };
            case "remote_file_properties": return { path: args.path, kind: "file", size: 4096, modifiedMs: 1793836800000, permissions: "0600", uid: 501, gid: 20 };
            case "mutate_remote_file": {
              const action = args.action as { kind: string; name?: string };
              if (action.kind === "createDirectory") entries = [...entries, entry(action.name!, true)];
              if (action.kind === "rename") entries = entries.map((item) => item.path === args.path ? entry(action.name!, item.isDir) : item);
              if (action.kind === "delete") entries = entries.filter((item) => item.path !== args.path);
              return;
            }
            case "disconnect_session":
            case "cancel_connection":
            case "plugin:window|set_theme": return;
            default: throw new Error(`未配置命令：${command}`);
          }
        },
      },
    });
  });
}

test("保存凭据直连、目录恢复、导航历史及文件修改形成完整流程", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const profile = page.getByRole("navigation", { name: "已保存连接" }).getByRole("button", { name: /测试环境应用服务器/ });
  await profile.dblclick();
  const remote = page.getByRole("region", { name: "远程文件", exact: true });
  await expect(remote.getByText("应用程序运行日志.log", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(profile.getByText("已连接")).toBeVisible();
  await expect(page.getByRole("button", { name: "连接菜单", exact: true })).toHaveCount(0);
  await remote.getByText("logs", { exact: true }).dblclick();
  await expect(page.getByLabel("远程路径")).toHaveValue("/remote/logs");
  await page.reload();
  await page.getByRole("button", { name: "连接服务器", exact: true }).click();
  await expect(page.getByLabel("远程路径")).toHaveValue("/remote/logs");
  await page.getByRole("button", { name: "远程返回上级" }).click();
  await expect(page.getByLabel("远程路径")).toHaveValue("/remote");
  await page.getByRole("button", { name: "远程后退" }).click();
  await expect(page.getByLabel("远程路径")).toHaveValue("/remote/logs");
  await page.getByRole("button", { name: "远程前进" }).click();
  await expect(remote.getByText("应用程序运行日志.log", { exact: true })).toBeVisible();
  await page.getByLabel("远程路径").fill("/not-submitted");
  await remote.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByLabel("文件夹名称").fill("private-data");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(remote.getByText("private-data", { exact: true })).toBeVisible();
  await remote.getByText("private-data", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByLabel("新名称").fill("renamed-data");
  await page.getByRole("dialog").getByRole("button", { name: "重命名", exact: true }).click();
  await remote.getByText("renamed-data", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("不会递归删除");
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(remote.getByText("renamed-data", { exact: true })).toHaveCount(0);
  const probesBefore = await page.evaluate(() => (window as unknown as {
    __remoteFilesFixture: { calls: Array<{ command: string }> };
  }).__remoteFilesFixture.calls.filter((call) => call.command === "probe_connection").length);
  await remote.locator(".file-list-container").click({ button: "right", position: { x: 100, y: 200 } });
  await page.getByRole("menuitem", { name: "刷新目录" }).click();
  const probesAfter = await page.evaluate(() => (window as unknown as {
    __remoteFilesFixture: { calls: Array<{ command: string }> };
  }).__remoteFilesFixture.calls.filter((call) => call.command === "probe_connection").length);
  expect(probesAfter).toBe(probesBefore);
  await expect(remote.getByText("应用程序运行日志.log", { exact: true })).toBeVisible();
});

test("远程工具栏、右键与只读预览在明暗、矮窗和窄视口内正常显示", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixture(page);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 390, height: 844 }, { width: 800, height: 480 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      if (viewport.width < 760) await page.getByRole("tab", { name: "远程", exact: true }).click();
      await page.getByRole("button", { name: "连接服务器", exact: true }).click();
      const remote = page.getByRole("region", { name: "远程文件", exact: true });
      await expect(remote.getByText("应用程序运行日志.log", { exact: true })).toBeVisible();
      const queueEmpty = page.locator(".queue-empty");
      expect((await queueEmpty.boundingBox())!.y + (await queueEmpty.boundingBox())!.height)
        .toBeLessThanOrEqual((await page.locator(".app-statusbar").boundingBox())!.y);
      await page.screenshot({ path: `test-results/${theme}-remote-actions-${viewport.width}-${viewport.height}.png` });
      await remote.getByText("应用程序运行日志.log", { exact: true }).click({ button: "right" });
      const menu = page.getByRole("menu", { name: "远程文件操作" });
      const menuBounds = (await menu.boundingBox())!;
      expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: `test-results/${theme}-remote-context-${viewport.width}-${viewport.height}.png` });
      await menu.getByRole("menuitem", { name: "预览文件", exact: true }).click();
      const text = page.getByLabel("远程文本预览");
      await expect(text).toHaveAttribute("readonly", "");
      await expect(text).toHaveValue(/不会执行/);
      const dialog = page.getByRole("dialog");
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
      const closeBounds = (await dialog.getByRole("button", { name: "关闭", exact: true }).boundingBox())!;
      const dialogBounds = (await dialog.boundingBox())!;
      expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
      await page.screenshot({ path: `test-results/${theme}-remote-text-${viewport.width}-${viewport.height}.png` });
      await page.keyboard.press("Escape");
      await remote.getByText("status.png", { exact: true }).dblclick();
      const image = page.getByRole("dialog").getByRole("img");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(480);
      await page.screenshot({ path: `test-results/${theme}-remote-image-${viewport.width}-${viewport.height}.png` });
      await expect(page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.keyboard.press("Escape");
    }
  }
  expect(errors).toEqual([]);
});

test("双栏的路径、筛选、工具栏、表头和列表逐行对齐，连接状态不改变布局", async ({ page }, testInfo) => {
  await installFixture(page);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 1473, height: 895 }, { width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 800, height: 480 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const local = page.getByRole("region", { name: "本地文件", exact: true });
      const remote = page.getByRole("region", { name: "远程文件", exact: true });
      await expect(local.getByText("本地文件说明.txt", { exact: true })).toBeVisible();
      for (const connected of [false, true]) {
        if (connected) {
          await page.getByRole("button", { name: "连接服务器", exact: true }).click();
          await expect(remote.getByText("应用程序运行日志.log", { exact: true })).toBeVisible();
        }
        const localHeader = (await local.locator("th.column-name").boundingBox())!;
        const remoteHeader = (await remote.locator("th.column-name").boundingBox())!;
        expect(Math.abs(localHeader.y - remoteHeader.y), "两侧可见的文件表头应位于同一水平线").toBeLessThan(1);
        for (const selector of [".pane-heading", ".pane-toolbar", ".pane-filter-row", '[role="toolbar"]', ".file-list-container", ".pane-footer"]) {
          const left = (await local.locator(selector).boundingBox())!;
          const right = (await remote.locator(selector).boundingBox())!;
          expect(Math.abs(left.y - right.y), `${selector} 顶部应对齐`).toBeLessThan(1);
          expect(Math.abs(left.height - right.height), `${selector} 高度应一致`).toBeLessThan(1);
        }
        await expect(local.getByRole("toolbar", { name: "本地文件操作" })).toBeVisible();
        await expect(remote.getByRole("toolbar", { name: "远程文件操作" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await page.screenshot({ path: testInfo.outputPath(`${theme}-aligned-${viewport.width}-${viewport.height}.png`) });
    }
  }
});

test("窄视口切换本地和远程时，两侧工具栏保持完整且不溢出", async ({ page }, testInfo) => {
  await installFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const side of ["本地", "远程"] as const) {
    await page.getByRole("tab", { name: side, exact: true }).click();
    const pane = page.getByRole("region", { name: `${side}文件`, exact: true });
    const toolbar = pane.getByRole("toolbar", { name: `${side}文件操作` });
    await expect(toolbar).toBeInViewport();
    const bounds = (await toolbar.boundingBox())!;
    for (const button of await toolbar.getByRole("button").all()) {
      const buttonBounds = (await button.boundingBox())!;
      expect(buttonBounds.x).toBeGreaterThanOrEqual(bounds.x);
      expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(buttonBounds.y).toBeGreaterThanOrEqual(bounds.y);
      expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`toolbar-mobile-${side === "本地" ? "local" : "remote"}.png`) });
  }
});
