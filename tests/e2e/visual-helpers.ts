import { expect, type Locator } from "@playwright/test";

export async function expectReadableText(locator: Locator, context: string) {
  const contrasts = await locator.evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).map((element) => {
    const luminance = (value: string) => {
      const linear = value.match(/[\d.]+/gu)!.slice(0, 3).map(Number).map((channel) => {
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
      label: element.textContent?.trim().slice(0, 80),
      ratio: (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05),
    };
  }));
  expect(contrasts.length, `${context}: 至少检测一处可见文字`).toBeGreaterThan(0);
  for (const { label, ratio } of contrasts) expect(ratio, `${context}: ${label}`).toBeGreaterThanOrEqual(4.5);
}
