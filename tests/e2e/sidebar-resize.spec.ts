import { expect, test, type Page } from "@playwright/test";

async function dimensions(page: Page) {
  const sidebar = (await page.getByRole("complementary", { name: "位置和连接" }).boundingBox())!;
  const main = (await page.getByRole("main").boundingBox())!;
  const local = (await page.getByRole("region", { name: "本地文件", exact: true }).boundingBox())!;
  const remote = (await page.getByRole("region", { name: "远程文件", exact: true }).boundingBox())!;
  const queue = (await page.getByRole("region", { name: "传输队列" }).boundingBox())!;
  expect(main.x).toBeCloseTo(sidebar.width, 0);
  expect(local.x).toBeCloseTo(main.x, 0);
  expect(remote.x).toBeCloseTo(local.x + local.width, 0);
  expect(local.width).toBeCloseTo(remote.width, 0);
  expect(queue.x).toBeCloseTo(main.x, 0);
  expect(queue.width).toBeCloseTo(main.width, 0);
  for (const side of ["本地", "远程"]) {
    const toolbar = page.getByRole("toolbar", { name: `${side}文件操作` });
    const filter = toolbar.getByRole("textbox", { name: `筛选${side}文件` });
    expect((await filter.boundingBox())!.width).toBeGreaterThanOrEqual(64);
    expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  return { sidebar, main, local, remote, queue };
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 800]) {
    test(`${theme} ${width} 拖动侧栏同步调整双栏和队列，保存并支持还原`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/");
      const handle = page.getByRole("separator", { name: "调整侧栏宽度" });
      const initial = await dimensions(page);
      const box = (await handle.boundingBox())!;
      const delta = width === 1280 ? 150 : 50;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 200, { steps: 10 });
      await expect(page.locator("body")).toHaveClass(/resizing-sidebar/);
      await page.mouse.up();
      await expect(page.locator("body")).not.toHaveClass(/resizing-sidebar/);
      const changed = await dimensions(page);
      expect(changed.sidebar.width).toBeCloseTo(initial.sidebar.width + delta, 0);
      expect(changed.main.width).toBeCloseTo(initial.main.width - delta, 0);
      await page.screenshot({ path: `test-results/sidebar-resize-${theme}-${width}.png` });
      await page.reload();
      await expect(handle).toHaveAttribute("aria-valuenow", String(initial.sidebar.width + delta));
      await handle.focus();
      await handle.press("ArrowLeft");
      await expect(handle).toHaveAttribute("aria-valuenow", String(initial.sidebar.width + delta - 10));
      await handle.dblclick();
      await expect(handle).toHaveAttribute("aria-valuenow", "215");
      await dimensions(page);
      expect(errors).toEqual([]);
    });
  }
}

test("窗口临时压缩不覆盖偏好，折叠和移动抽屉保持完整布局", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const handle = page.getByRole("separator", { name: "调整侧栏宽度" });
  await handle.focus();
  await handle.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
  await page.setViewportSize({ width: 800, height: 580 });
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
  await dimensions(page);
  await handle.focus();
  await handle.press("ArrowRight");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 100, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem("fileworker.sidebar-width.v1"))).toBe("400");
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(handle).toBeHidden();
  expect((await page.getByRole("main").boundingBox())!.width).toBe(800);
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
  await page.getByRole("button", { name: "切换侧栏" }).click();
  await expect(page.getByRole("complementary", { name: "位置和连接" })).toBeVisible();
  expect((await page.getByRole("complementary", { name: "位置和连接" }).boundingBox())!.width).toBe(235);
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.setViewportSize({ width: 1280, height: 820 });
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
  await dimensions(page);
});
