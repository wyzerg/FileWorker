import { expect, test } from "@playwright/test";

test("外观偏好可以切换、记忆并跟随系统", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("menuitemradio", { name: "跟随系统" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("框架代码尚未加载时就使用保存的深色背景", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("fileworker.appearance.v1", "dark"));
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/u, (route) => route.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.locator("#root").innerHTML()).toBe("");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe("dark");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(25, 27, 32)");
});

test("明暗主题的工作区、菜单与表单在不同视口均可用", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of [{ width: 1280, height: 820 }, { width: 800, height: 580 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: `test-results/${theme}-workspace-${viewport.width}.png` });
      await page.getByRole("button", { name: "外观设置" }).click();
      const bounds = await page.getByRole("menu", { name: "外观" }).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: `test-results/${theme}-menu-${viewport.width}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const styles = await page.getByRole("dialog").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(element).color,
      }));
      expect(styles.background).not.toBe(styles.text);
      if (theme === "dark") expect(styles.background).not.toBe("rgb(255, 255, 255)");
      await page.screenshot({ path: `test-results/${theme}-profile-${viewport.width}.png` });
      await page.keyboard.press("Escape");
    }
  }
});

test("明暗主题的可用控件及次要文字保持可读对比度", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "添加 SFTP 连接" })).toBeEnabled();
    const contrasts = await page.locator(
      ".workspace-title, .runtime-label, .sidebar-section h2, .sidebar-no-connections, .pane-empty h3, .pane-empty p, .queue-title h2, .queue-empty, .app-statusbar, .button.primary, .file-table th",
    ).evaluateAll((elements) => elements.map((element) => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => {
        const linear = rgb(value).map((channel) => {
          const scaled = channel / 255;
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      let ancestor: Element | null = element;
      let background = "rgb(255, 255, 255)";
      while (ancestor) {
        const candidate = getComputedStyle(ancestor).backgroundColor;
        if (candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
          background = candidate; break;
        }
        ancestor = ancestor.parentElement;
      }
      const foreground = luminance(getComputedStyle(element).color);
      const behind = luminance(background);
      return {
        label: element.textContent?.trim(),
        ratio: (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05),
      };
    }));
    for (const { label, ratio } of contrasts) expect(ratio, `${theme}: ${label}`).toBeGreaterThanOrEqual(4.5);
  }
});
