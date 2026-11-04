import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const storageKey = "fileworker.appearance.v1";
let dark = false;
let media: EventTarget & { readonly matches: boolean };

beforeEach(() => {
  localStorage.clear();
  dark = false;
  media = Object.assign(new EventTarget(), {
    get matches() { return dark; },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
  });
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", () => media);
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function systemTheme(nextDark: boolean) {
  act(() => { dark = nextDark; media.dispatchEvent(new Event("change")); });
}

async function chooseTheme(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "外观设置" }));
  await user.click(screen.getByRole("menuitemradio", { name }));
}

describe("外观", () => {
  it("首次打开跟随系统深色外观", async () => {
    dark = true;
    render(<App />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "外观设置" }));
    expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
  });

  it("手动选择暗色后立即生效，重新打开仍记得选择", async () => {
    const first = render(<App />);
    await chooseTheme("深色");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(storageKey)).toBe("dark");
    first.unmount();
    render(<App />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("手动选择浅色后，系统变化不会覆盖用户选择", async () => {
    dark = true;
    render(<App />);
    await chooseTheme("浅色");
    systemTheme(false);
    systemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("切回跟随系统后可以继续响应系统外观变化", async () => {
    localStorage.setItem(storageKey, "dark");
    render(<App />);
    await chooseTheme("跟随系统");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    systemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    systemTheme(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("无效外观偏好回退到系统设置，不影响连接配置", async () => {
    localStorage.setItem(storageKey, "invalid");
    dark = true;
    render(<App />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await chooseTheme("浅色");
    expect(localStorage.getItem("fileworker.preview.profiles.v1")).toBeNull();
  });

  it("无法写入偏好时仍能切换，并说明本次选择没有保存", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    render(<App />);
    await chooseTheme("深色");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(await screen.findByRole("alert")).toHaveTextContent("未能保存外观偏好");
  });

  it("读取本地存储被禁止时仍能打开工作区", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    render(<App />);
    await screen.findByRole("button", { name: "外观设置" });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("外观菜单支持方向键选择、Escape 关闭并归还焦点", async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = screen.getByRole("button", { name: "外观设置" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "外观" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("卸载后不再响应系统外观变化", () => {
    const view = render(<App />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    view.unmount();
    systemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
