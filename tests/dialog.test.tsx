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
