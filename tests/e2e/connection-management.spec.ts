import { expect, test, type Page } from "@playwright/test";

for (const [theme, width] of [["light", 1280], ["dark", 390]] as const) {
  test(`${theme} ${width} 分组增改折叠重载及删除保留连接`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    const showSidebar = async () => {
      if (width < 760) await page.getByRole("button", { name: "切换侧栏" }).click();
    };
    await showSidebar();
    await page.getByRole("button", { name: "新建分组", exact: true }).click();
    await page.getByLabel("分组名称").fill("生产环境");
    await page.getByRole("button", { name: "保存分组" }).click();
    const group = page.getByRole("group", { name: "生产环境", exact: true });
    await group.getByRole("button", { name: "分组菜单" }).click();
    await page.getByRole("menuitem", { name: "新建连接" }).click();
    const editor = page.getByRole("dialog", { name: "新建连接" });
    await expect(editor.getByLabel("连接分组")).not.toHaveValue("");
    await editor.getByLabel("连接名称").fill("生产环境应用服务器");
    await editor.getByLabel("主机地址").fill("production.example.invalid");
    await editor.getByLabel("用户名").fill("tester");
    await editor.getByRole("button", { name: "仅保存配置" }).click();
    await expect(group.getByRole("button", { name: /生产环境应用服务器/ })).toBeVisible();
    await group.getByRole("button", { name: "生产环境 1" }).click();
    await expect(group.getByRole("button", { name: /生产环境应用服务器/ })).toHaveCount(0);
    await page.reload();
    await showSidebar();
    await expect(group.getByRole("button", { name: "生产环境 1" })).toHaveAttribute("aria-expanded", "false");
    await group.getByRole("button", { name: "生产环境 1" }).click();
    await page.screenshot({ path: `test-results/${theme}-groups-${width}.png` });
    await group.getByRole("button", { name: /生产环境应用服务器/ }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: /连接操作/ });
    await expect(menu.getByRole("menuitem", { name: "编辑连接" })).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/${theme}-connection-menu-${width}.png` });
    await page.keyboard.press("Escape");
    await group.getByRole("button", { name: "分组菜单" }).click();
    await page.getByRole("menuitem", { name: "编辑分组" }).click();
    await page.getByLabel("分组名称").fill("正式环境");
    await page.getByRole("button", { name: "保存分组" }).click();
    const renamed = page.getByRole("group", { name: "正式环境", exact: true });
    await renamed.getByRole("button", { name: "分组菜单" }).click();
    await page.getByRole("menuitem", { name: "删除分组" }).click();
    await expect(page.getByRole("dialog")).toContainText("不会删除连接");
    await page.getByRole("dialog").getByRole("button", { name: "删除分组" }).click();
    await expect(page.getByRole("navigation", { name: "已保存连接" }).getByRole("button", { name: /生产环境应用服务器/ })).toBeVisible();
    await page.reload();
    await showSidebar();
    await expect(page.getByRole("navigation", { name: "已保存连接" }).getByRole("button", { name: /生产环境应用服务器/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

async function installConnectionFixture(page: Page) {
  await page.addInitScript(() => {
    let profile: Record<string, unknown> | null = null;
    let trusted = false;
    let saved = false;
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    Object.assign(window, {
      isTauri: true,
      __connectionFixture: { calls },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          const session = { sessionId: "isolated-session", profileId: profile?.id, initialPath: "/remote", warning: null };
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [], credentialStorage: true };
            case "list_profiles": return profile ? [profile] : [];
            case "list_groups": return [];
            case "credential_status": return { available: saved, supported: true };
            case "list_local_directory": return { path: "/local", parentPath: "/", warnings: [], entries: [] };
            case "transfer_snapshot": return { revision: 0, concurrency: 3, jobs: [] };
            case "probe_connection":
            case "probe_draft_connection": return {
              attemptId: args.attemptId, host: "isolated.example.invalid", port: 22, trusted,
              identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:isolated-key-for-layout-only" },
            };
            case "trust_connection":
            case "trust_test_connection": trusted = true; return;
            case "authenticate_test_connection":
              if (!trusted || args.secret !== "test-password-only") throw { message: "测试认证失败" };
              return session;
            case "save_profile": profile = args.profile as Record<string, unknown>; return profile;
            case "authenticate_connection":
              if (!trusted || (args.secret !== "test-password-only" && args.secret !== null)) throw { code: "authentication_failed", message: "密码不正确" };
              if (args.remember) saved = true;
              return session;
            case "list_remote_directory": return { path: "/remote", parentPath: "/", warnings: [],
              entries: [{ name: "connected.txt", path: "/remote/connected.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false }] };
            case "forget_credential": saved = false; return;
            case "cancel_connection":
            case "cancel_test_connection":
            case "check_session":
            case "disconnect_session":
            case "plugin:window|set_theme": return;
            default: throw new Error(`未配置命令：${command}`);
          }
        },
      },
    });
  });
}

test("测试、保存并连接和已存凭据重连形成完整流程", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installConnectionFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
  await page.getByLabel("连接名称").fill("隔离测试连接");
  await page.getByLabel("主机地址").fill("isolated.example.invalid");
  await page.getByLabel("用户名").fill("tester");
  await page.getByLabel("密码", { exact: true }).fill("test-password-only");
  await page.getByRole("checkbox", { name: /记住密码/ }).check();
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("region", { name: "确认服务器指纹" })).toBeVisible();
  await page.getByRole("button", { name: "信任并测试" }).click();
  await expect(page.getByRole("status")).toHaveText("连接测试成功");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("test-password-only");
  const beforeSave = await page.evaluate(() => (window as unknown as { __connectionFixture: { calls: Array<{ command: string }> } }).__connectionFixture.calls);
  expect(beforeSave.some((call) => call.command === "save_profile")).toBe(false);
  await page.getByRole("button", { name: "保存并连接" }).click();
  await expect(page.getByText("connected.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "断开服务器" }).click();
  await page.getByRole("button", { name: "连接服务器", exact: true }).click();
  await expect(page.getByText("connected.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as {
    __connectionFixture: { calls: Array<{ command: string; args: Record<string, unknown> }> };
  }).__connectionFixture.calls);
  expect(calls.find((call) => call.command === "save_profile")!.args.profile).not.toHaveProperty("secret");
  expect(calls.find((call) => call.command === "authenticate_test_connection")!.args).not.toHaveProperty("remember");
  expect(calls.filter((call) => call.command === "authenticate_connection").map((call) => call.args.secret)).toEqual(["test-password-only", null]);
  expect(errors).toEqual([]);
});

test("长私钥表单在明暗与矮窄视口中保持可读和可操作", async ({ page }) => {
  await installConnectionFixture(page);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
      const dialog = page.getByRole("dialog");
      await page.getByRole("radio", { name: "SSH 私钥" }).check();
      await page.getByRole("radio", { name: "粘贴私钥" }).check();
      await page.getByLabel("私钥内容").fill(`-----BEGIN OPENSSH PRIVATE KEY-----\n${"isolated-placeholder-only".repeat(35)}\n-----END OPENSSH PRIVATE KEY-----`);
      await expect(dialog.getByRole("button", { name: "保存并连接" })).toBeInViewport();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/${theme}-private-key-form-${viewport.width}.png` });
      await page.keyboard.press("Escape");
    }
  }
});
