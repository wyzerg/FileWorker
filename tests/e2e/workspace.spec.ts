import { expect, test } from "@playwright/test";

test("连接配置可以保存、重载、编辑、复制和删除", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("连接名称").fill("开发服务器");
  await dialog.getByLabel("主机地址").fill("dev.example.com");
  await dialog.getByLabel("用户名").fill("deploy");
  await dialog.getByRole("button", { name: "仅保存配置" }).click();
  await expect(page.getByRole("button", { name: /开发服务器/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /开发服务器/ })).toBeVisible();

  await page.getByRole("button", { name: "管理当前连接" }).click();
  await page.getByRole("menuitem", { name: "编辑连接" }).click();
  await page.getByLabel("连接名称").fill("测试服务器");
  await page.getByRole("button", { name: "仅保存配置" }).click();
  await expect(page.getByRole("button", { name: /测试服务器/ })).toBeVisible();

  await page.getByRole("button", { name: "管理当前连接" }).click();
  await page.getByRole("menuitem", { name: "复制连接" }).click();
  await expect(page.getByRole("button", { name: /测试服务器 副本/ })).toBeVisible();
  await page.getByRole("button", { name: "管理当前连接" }).click();
  await page.getByRole("menuitem", { name: "删除连接" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除连接" }).click();
  await expect(page.getByRole("button", { name: /测试服务器 副本/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /测试服务器/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("工作区和表单在桌面及窄视口没有横向溢出", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "FileWorker", exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `test-results/workspace-${viewport.width}.png` });

    await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
    await page.getByLabel("连接名称").fill("有一个非常长的连接名称用于验证换行和省略不会撑破界面");
    await page.screenshot({ path: `test-results/profile-${viewport.width}.png` });
    const bounds = await page.getByRole("dialog").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("窄视口可以切换文件栏并展开侧栏", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("tab", { name: "远程", exact: true }).click();
  await expect(page.getByRole("region", { name: "远程文件", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "本地文件", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(page.getByRole("complementary", { name: "位置和连接" })).toBeVisible();
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.getByRole("complementary", { name: "位置和连接" })).not.toBeVisible();
});
