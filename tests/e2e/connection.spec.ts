import { expect, test } from "@playwright/test";

test("连接确认、认证和远程列表在明暗及窄视口下保持完整", async ({ page }) => {
  await page.addInitScript(() => {
    const profile = {
      id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "开发服务器 · 上海",
      host: "dev.example.com", port: 22, username: "deploy", authMethod: "password",
      privateKeyPath: null, remotePath: ".",
    };
    let trusted = false;
    let authenticated = false;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          switch (command) {
            case "transfer_snapshot": return { revision: 0, concurrency: 3, jobs: [] };
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [] };
            case "list_profiles": return [profile];
            case "list_local_directory": return { path: "/local", parentPath: "/", entries: [], warnings: [] };
            case "probe_connection": return {
              attemptId: args.attemptId, host: profile.host, port: 22, trusted,
              identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:U0vdqj6Z2S8mWVwPXq5g7bGlntAFy2QnFuEKtC7yZgE" },
            };
            case "trust_connection": trusted = true; return;
            case "authenticate_connection":
              if (!trusted) throw { code: "host_not_trusted", message: "主机尚未信任" };
              authenticated = true;
              return { sessionId: "e2e-session", profileId: profile.id, initialPath: "/", warning: null };
            case "list_remote_directory":
              if (!authenticated) throw { message: "尚未认证" };
              if (args.path === "/denied") throw { code: "remote_directory", message: "没有读取权限" };
              return {
                path: args.path, parentPath: args.path === "/" ? null : "/", warnings: [],
                entries: args.path === "/" ? [
                  { name: "backups", path: "/backups", isDir: true, isSymlink: false, size: null, modifiedMs: 1793692800000, hidden: false },
                  { name: "部署说明.md", path: "/部署说明.md", isDir: false, isSymlink: false, size: 2448, modifiedMs: 1793692800000, hidden: false },
                  { name: ".ssh", path: "/.ssh", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: true },
                ] : [],
              };
            case "disconnect_session": authenticated = false; return;
            case "cancel_connection": return;
            case "plugin:window|set_theme": return;
            default: throw new Error(`未配置的测试命令：${command}`);
          }
        },
      },
    });
  });
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      if (viewport.width < 760) await page.getByRole("tab", { name: "远程", exact: true }).click();
      await page.getByRole("button", { name: "连接服务器", exact: true }).click();
      const trust = page.getByRole("dialog", { name: "确认服务器指纹" });
      await expect(trust).toBeVisible();
      await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
      const details = await trust.locator(".fingerprint").boundingBox();
      const bounds = await trust.boundingBox();
      expect(details!.x + details!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      await page.screenshot({ path: `test-results/${theme}-trust-${viewport.width}.png` });
      await trust.getByRole("button", { name: "信任并继续" }).click();
      const auth = page.getByRole("dialog", { name: "服务器认证" });
      await expect(auth).toBeVisible();
      await page.screenshot({ path: `test-results/${theme}-auth-${viewport.width}.png` });
      await page.getByLabel("密码", { exact: true }).fill("isolated-e2e-placeholder");
      await auth.getByRole("button", { name: "连接", exact: true }).click();
      await expect(page.getByText("部署说明.md", { exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/${theme}-connected-${viewport.width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.getByText("backups", { exact: true }).dblclick();
      await expect(page.getByLabel("远程路径")).toHaveValue("/backups");
      await page.getByRole("button", { name: "远程返回上级" }).click();
      await expect(page.getByText("部署说明.md", { exact: true })).toBeVisible();
      await page.getByLabel("远程路径").fill("/denied");
      await page.getByLabel("远程路径").press("Enter");
      await expect(page.getByRole("alert")).toHaveText("没有读取权限");
      await page.screenshot({ path: `test-results/${theme}-denied-${viewport.width}.png` });
      await page.getByRole("button", { name: "远程返回上级" }).click();
      await expect(page.getByText("部署说明.md", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "远程返回上级" })).toBeDisabled();
      await page.getByRole("region", { name: "远程文件", exact: true }).getByRole("button", { name: "显示隐藏文件" }).click();
      await expect(page.getByText(".ssh", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "断开服务器" }).click();
      await expect(page.getByRole("button", { name: "连接服务器", exact: true })).toBeVisible();
    }
  }
});
