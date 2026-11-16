import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";

const storageKey = "fileworker.sidebar-width.v1";
const bounds = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
      this.isPrimary = options.isPrimary ?? true;
    }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("workspace-body")
      ? { x: 0, y: 55, left: 0, right: window.innerWidth, top: 55, bottom: 800, width: window.innerWidth, height: 745, toJSON: () => ({}) }
      : bounds.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function workspace() {
  const view = render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "添加 SFTP 连接" })).toBeEnabled());
  return view;
}
const separator = () => screen.getByRole("separator", { name: "调整侧栏宽度" });
const width = () => Number(separator().getAttribute("aria-valuenow"));
function begin(x = width(), pointerId = 1) {
  fireEvent.pointerDown(separator(), { clientX: x, button: 0, pointerId, isPrimary: true });
}
function move(x: number, pointerId = 1) {
  fireEvent.pointerMove(window, { clientX: x, pointerId });
}
function finish(x: number, pointerId = 1) {
  fireEvent.pointerUp(window, { clientX: x, pointerId });
}

it("拖动实时调整整个工作区，松开才保存，重新打开恢复宽度", async () => {
  const view = await workspace();
  expect(width()).toBe(215);
  begin();
  move(320);
  expect(width()).toBe(320);
  expect(document.querySelector(".workspace-body")).toHaveStyle({ "--sidebar-width": "320px" });
  expect(localStorage.getItem(storageKey)).toBeNull();
  finish(320);
  expect(localStorage.getItem(storageKey)).toBe("320");
  expect(document.body).not.toHaveClass("resizing-sidebar");
  view.unmount();
  await workspace();
  expect(width()).toBe(320);
});

it("拖动限制侧栏上下界，并为右侧双栏保留宽度", async () => {
  await workspace();
  begin();
  move(-300);
  expect(width()).toBe(180);
  move(2000);
  expect(width()).toBe(400);
  finish(2000);
  window.innerWidth = 800;
  fireEvent.resize(window);
  expect(width()).toBe(280);
  expect(localStorage.getItem(storageKey)).toBe("400");
  window.innerWidth = 1280;
  fireEvent.resize(window);
  expect(width()).toBe(400);
});

it("支持键盘调整与双击恢复默认，折叠展开不丢宽度", async () => {
  await workspace();
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  expect(width()).toBe(225);
  fireEvent.keyDown(separator(), { key: "Home" });
  expect(width()).toBe(180);
  fireEvent.keyDown(separator(), { key: "End" });
  expect(width()).toBe(400);
  fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
  expect(width()).toBe(400);
  fireEvent.doubleClick(separator());
  expect(width()).toBe(215);
  expect(localStorage.getItem(storageKey)).toBe("215");
});

it.each(["pointer", "keyboard"])("临时收窄后 %s 无效扩宽不覆盖原偏好", async (input) => {
  localStorage.setItem(storageKey, "400");
  await workspace();
  window.innerWidth = 800;
  fireEvent.resize(window);
  expect(width()).toBe(280);
  if (input === "pointer") {
    begin();
    move(350);
    finish(350);
  } else {
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
  }
  expect(localStorage.getItem(storageKey)).toBe("400");
  window.innerWidth = 1280;
  fireEvent.resize(window);
  expect(width()).toBe(400);
});

it.each(["escape", "cancel", "blur", "collapse", "mobile", "unmount"])("%s 中断拖动时不保存半途宽度，也不残留全局拖动状态", async (cause) => {
  localStorage.setItem(storageKey, "260");
  const view = await workspace();
  begin();
  move(340);
  expect(width()).toBe(340);
  if (cause === "escape") fireEvent.keyDown(window, { key: "Escape" });
  if (cause === "cancel") fireEvent.pointerCancel(window, { pointerId: 1 });
  if (cause === "blur") fireEvent.blur(window);
  if (cause === "collapse") fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
  if (cause === "mobile") { window.innerWidth = 390; fireEvent.resize(window); }
  if (cause === "unmount") view.unmount();
  expect(document.body).not.toHaveClass("resizing-sidebar");
  expect(localStorage.getItem(storageKey)).toBe("260");
  move(390);
  finish(390);
  expect(localStorage.getItem(storageKey)).toBe("260");
  if (["escape", "cancel", "blur"].includes(cause)) expect(width()).toBe(260);
});

it("非主指针与其他指针不能抢占当前拖动", async () => {
  await workspace();
  fireEvent.pointerDown(separator(), { clientX: 215, button: 2, pointerId: 2, isPrimary: true });
  move(350, 2);
  expect(width()).toBe(215);
  begin();
  move(350, 2);
  finish(350, 2);
  expect(width()).toBe(215);
  move(300);
  finish(300);
  expect(width()).toBe(300);
});

it.each(['"300"', "null", "{}", "NaN", "99999", "-1"])("忽略无效的宽度存储 %s", async (value) => {
  localStorage.setItem(storageKey, value);
  await workspace();
  expect(width()).toBe(215);
});

it("存储失败仍能调整当前布局，并给出提示", async () => {
  await workspace();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("不可用"); });
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  expect(width()).toBe(225);
  expect(await screen.findByText("未能保存侧栏宽度，本次调整仍然有效")).toBeInTheDocument();
});
