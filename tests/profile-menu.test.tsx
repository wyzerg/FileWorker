import { StrictMode, useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ProfileMenu } from "../src/components/ProfileMenu";
import type { ConnectionProfile } from "../src/lib/types";

const profile: ConnectionProfile = {
  id: "menu-profile", name: "隔离连接", host: "menu.example.invalid", port: 22, username: "tester",
  authMethod: "password", privateKeyPath: null, remotePath: "/",
};

function MenuFixture() {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button type="button" ref={trigger} onClick={() => setOpen((value) => !value)}>打开菜单</button>
    <button type="button">外部操作</button>
    {open && <ProfileMenu profile={profile} anchor={{ x: 30, y: 50 }} trigger={trigger.current} busy={false} desktop
      onClose={() => setOpen(false)} onConnect={() => setAction("连接")}
      onEdit={() => setAction("编辑")} onDuplicate={() => {}} onForget={() => {}} onDelete={() => {}} />}
    <output>{action}</output>
  </>;
}

it("StrictMode 重复挂载后菜单仍可使用，Escape 返回触发器且外部点击保留外部焦点", async () => {
  const user = userEvent.setup();
  render(<StrictMode><MenuFixture /></StrictMode>);
  const trigger = screen.getByRole("button", { name: "打开菜单" });
  await user.click(trigger);
  expect(screen.getByRole("menuitem", { name: "连接服务器" })).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("status")).toHaveTextContent("编辑");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "外部操作" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "外部操作" })).toHaveFocus();
});

it("再次点击同一个触发按钮会收起菜单", async () => {
  const user = userEvent.setup();
  render(<StrictMode><MenuFixture /></StrictMode>);
  const trigger = screen.getByRole("button", { name: "打开菜单" });
  await user.click(trigger);
  expect(screen.getByRole("menu")).toBeVisible();
  await user.click(trigger);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
