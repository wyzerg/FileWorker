import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Dialog } from "../src/components/Dialog";

it("保存期间即使所有控件被禁用，Tab 焦点也不会进入背景", async () => {
  const user = userEvent.setup();
  render(<>
    <button type="button">背景操作</button>
    <Dialog title="正在保存" busy onClose={() => {}}>
      <fieldset disabled><input type="radio" aria-label="认证方式" /></fieldset>
      <button type="button" disabled>保存</button>
    </Dialog>
  </>);
  await user.tab();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  await user.tab({ shift: true });
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
});

it("弹窗重叠交接不提前解锁背景，非逆序关闭后也不留下 inert 或滚动锁", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.inert = false;
  document.body.append(root);
  const initialOverflow = document.body.style.overflow;
  const view = render(<></>, { container: root });
  const dialogs = (first: boolean, second: boolean) => <>
    <button type="button">背景操作</button>
    {first && <Dialog key="first" title="第一层" onClose={() => {}}><input aria-label="第一输入" /></Dialog>}
    {second && <Dialog key="second" title="第二层" onClose={() => {}}><input aria-label="第二输入" /></Dialog>}
  </>;
  try {
    view.rerender(dialogs(true, false));
    expect(root.inert).toBe(true);
    view.rerender(dialogs(true, true));
    expect(screen.getByLabelText("第二输入")).toHaveFocus();
    screen.getByLabelText("第一输入").focus();
    expect(screen.getByRole("dialog", { name: "第二层" })).toContainElement(document.activeElement as HTMLElement);
    view.rerender(dialogs(false, true));
    expect(root.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(dialogs(false, false));
    expect(root.inert).toBe(false);
    expect(document.body.style.overflow).toBe(initialOverflow);
  } finally {
    view.unmount();
    root.remove();
    document.body.style.overflow = initialOverflow;
  }
});

it("StrictMode 弹窗关闭后恢复原始背景状态和焦点", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.inert = false;
  document.body.append(root);
  const view = render(<StrictMode><button type="button">背景操作</button></StrictMode>, { container: root });
  try {
    screen.getByRole("button", { name: "背景操作" }).focus();
    view.rerender(<StrictMode>
      <button type="button">背景操作</button>
      <Dialog title="测试" onClose={() => {}}><input aria-label="弹窗输入" /></Dialog>
    </StrictMode>);
    expect(root.inert).toBe(true);
    view.rerender(<StrictMode><button type="button">背景操作</button></StrictMode>);
    expect(root.inert).toBe(false);
    expect(screen.getByRole("button", { name: "背景操作" })).toHaveFocus();
  } finally {
    view.unmount();
    root.remove();
  }
});
