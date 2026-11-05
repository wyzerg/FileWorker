import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/components/Sidebar";
import type { ConnectionProfile } from "../src/lib/types";

const storageKey = "fileworker.groups.collapsed.v1";
const groups = [{ id: "production", name: "生产" }, { id: "archive", name: "归档" }];
const production: ConnectionProfile & { groupId: string } = {
  id: "alpha", name: "Alpha", host: "alpha.example", port: 22, username: "alice",
  authMethod: "password", privateKeyPath: null, remotePath: "/", groupId: "production",
};
const ungrouped: ConnectionProfile = {
  id: "beta", name: "Beta", host: "beta.example", port: 22, username: "bob",
  authMethod: "password", privateKeyPath: null, remotePath: "/",
};
const orphaned = { ...ungrouped, id: "gamma", name: "Gamma", groupId: "deleted-group" };
const defaults = {
  profiles: [production, ungrouped], selectedId: null, onSelect: () => {}, onNew: () => {},
  environment: null, localPath: "", onNavigate: () => {}, loading: false,
};

function sidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return <Sidebar {...defaults} {...overrides} />;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("connection groups", () => {
  it("keeps a flat list without groups and preserves the profile button name", () => {
    render(sidebar());
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Betabeta.example" })).toBeVisible();
    expect(screen.queryByText("未分组")).not.toBeInTheDocument();
  });

  it("renders named and empty groups with counts and keeps orphaned connections ungrouped", () => {
    render(sidebar({ groups, profiles: [production, ungrouped, orphaned] }));
    const productionSection = screen.getByRole("group", { name: "生产" });
    expect(within(productionSection).getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "true");
    expect(within(productionSection).getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
    expect(within(screen.getByRole("group", { name: "归档" })).getByRole("button", { name: "归档 0" })).toBeVisible();
    const loose = screen.getByRole("group", { name: "未分组" });
    expect(within(loose).getByRole("button", { name: "Betabeta.example" })).toBeVisible();
    expect(within(loose).getByRole("button", { name: "Gammabeta.example" })).toBeVisible();
  });

  it("shows empty group controls even when no connection has been saved", () => {
    render(sidebar({ groups, profiles: [] }));
    expect(screen.getByRole("button", { name: "生产 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "归档 0" })).toBeVisible();
  });

  it("persists manual collapse through rerender and a fresh mount", async () => {
    const user = userEvent.setup();
    const first = render(sidebar({ groups }));
    await user.click(screen.getByRole("button", { name: "生产 1" }));
    expect(screen.queryByRole("button", { name: "Alphaalpha.example" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(["production"]);
    first.rerender(sidebar({ groups, connectedId: "beta" }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    first.unmount();
    render(sidebar({ groups }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "生产 1" }));
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
  });

  it("reveals a newly externally selected profile without undoing its later manual collapse", async () => {
    const user = userEvent.setup();
    localStorage.setItem(storageKey, '["production"]');
    const view = render(sidebar({ groups, selectedId: "beta" }));
    expect(screen.queryByRole("button", { name: "Alphaalpha.example" })).not.toBeInTheDocument();
    view.rerender(sidebar({ groups, selectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "生产 1" }));
    view.rerender(sidebar({ groups: [...groups], selectedId: "alpha", connectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    view.rerender(sidebar({ groups, selectedId: "beta" }));
    view.rerender(sidebar({ groups, selectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
  });

  it("does not erase a saved manual collapse when the same selected profile is restored on restart", () => {
    localStorage.setItem(storageKey, '["production"]');
    render(sidebar({ groups, selectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(["production"]);
  });

  it("preserves saved collapse when startup asynchronously restores the selected connection", () => {
    localStorage.setItem(storageKey, '["production"]');
    const view = render(sidebar({ groups: [], profiles: [], loading: true }));
    view.rerender(sidebar({ groups, selectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(["production"]);
    view.rerender(sidebar({ groups, selectedId: "beta" }));
    view.rerender(sidebar({ groups, selectedId: "alpha" }));
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
  });

  it.each(["{broken", "null", '{"production":true}', "[1,null]"])("ignores invalid saved collapse data %s", (value) => {
    localStorage.setItem(storageKey, value);
    render(sidebar({ groups }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "true");
  });

  it("still folds and unfolds when browser storage access is denied", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    const user = userEvent.setup();
    render(sidebar({ groups }));
    await user.click(screen.getByRole("button", { name: "生产 1" }));
    expect(screen.getByRole("button", { name: "生产 1" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "生产 1" }));
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toBeVisible();
  });
});

describe("profile context menus", () => {
  it("suppresses the native menu and targets the right-clicked profile without changing selection", () => {
    const selected: string[] = [];
    const opened: unknown[] = [];
    render(sidebar({
      selectedId: "alpha", connectedId: "alpha",
      onSelect: (id) => selected.push(id),
      onProfileMenu: (profile, anchor) => opened.push({ profile, anchor }),
    }));
    const beta = screen.getByRole("button", { name: "Betabeta.example" });
    const nativeMenuAllowed = fireEvent.contextMenu(beta, { clientX: 71, clientY: 93 });
    expect(nativeMenuAllowed).toBe(false);
    expect(opened).toEqual([{ profile: ungrouped, anchor: { x: 71, y: 93 } }]);
    expect(selected).toEqual([]);
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toHaveAttribute("aria-pressed", "true");
    expect(beta).toHaveAttribute("aria-pressed", "false");
  });

  it("connects the double-clicked profile and removes redundant per-profile overflow buttons", async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    const connected: string[] = [];
    render(sidebar({
      onSelect: (id) => selected.push(id),
      onConnect: (id) => connected.push(id),
      onProfileMenu: () => {},
    }));
    await user.dblClick(screen.getByRole("button", { name: "Betabeta.example" }));
    expect(connected).toEqual(["beta"]);
    expect(screen.queryByRole("button", { name: "连接菜单" })).not.toBeInTheDocument();
    expect(selected).toEqual(["beta", "beta"]);
  });

  it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])("opens the focused profile menu with %s without selecting it", async (keys) => {
    const user = userEvent.setup();
    const selected: string[] = [];
    const opened: unknown[] = [];
    render(sidebar({
      onSelect: (id) => selected.push(id),
      onProfileMenu: (profile, anchor) => opened.push({ profile, anchor }),
    }));
    const beta = screen.getByRole("button", { name: "Betabeta.example" });
    vi.spyOn(beta, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 180, 42));
    beta.focus();
    await user.keyboard(keys);
    expect(opened).toEqual([{ profile: ungrouped, anchor: { x: 12, y: 82 } }]);
    expect(selected).toEqual([]);
  });

  it("keeps ordinary profile selection working separately from its menu", async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    const opened: string[] = [];
    render(sidebar({
      onSelect: (id) => selected.push(id),
      onProfileMenu: (profile) => opened.push(profile.id),
    }));
    await user.click(screen.getByRole("button", { name: "Betabeta.example" }));
    expect(selected).toEqual(["beta"]);
    expect(opened).toEqual([]);
  });
});

describe("group actions", () => {
  it("offers new group and ungrouped connection creation without passing click events as group IDs", async () => {
    const user = userEvent.setup();
    const created: (string | null | undefined)[] = [];
    let newGroups = 0;
    render(sidebar({ onNew: (groupId) => created.push(groupId), onNewGroup: () => { newGroups += 1; } }));
    const newGroup = screen.getByRole("button", { name: "新建分组" });
    expect(newGroup).toHaveAttribute("title", "新建分组");
    await user.click(newGroup);
    await user.click(screen.getByRole("button", { name: "新建连接" }));
    expect(newGroups).toBe(1);
    expect(created).toEqual([undefined]);
  });

  it.each([
    ["新建连接", "new"],
    ["编辑分组", "edit"],
    ["删除分组", "delete"],
  ])("%s targets the group whose menu was opened and closes the menu", async (action, kind) => {
    const user = userEvent.setup();
    const events: unknown[] = [];
    render(sidebar({
      groups,
      onNew: (groupId) => events.push({ kind: "new", groupId }),
      onEditGroup: (group) => events.push({ kind: "edit", group }),
      onDeleteGroup: (group) => events.push({ kind: "delete", group }),
    }));
    const trigger = within(screen.getByRole("group", { name: "归档" })).getByRole("button", { name: "分组菜单" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: action }));
    expect(events).toEqual([kind === "new" ? { kind, groupId: "archive" } : { kind, group: groups[1] }]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("supports keyboard menu navigation, Escape focus return, and outside dismissal", async () => {
    const user = userEvent.setup();
    render(<>{sidebar({ groups, onEditGroup: () => {}, onDeleteGroup: () => {} })}<button type="button">Outside</button></>);
    const trigger = within(screen.getByRole("group", { name: "生产" })).getByRole("button", { name: "分组菜单" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "新建连接" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "删除分组" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "新建连接" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("allows Tab to leave the menu and disables unavailable group callbacks", async () => {
    const user = userEvent.setup();
    render(sidebar({ groups }));
    const trigger = within(screen.getByRole("group", { name: "生产" })).getByRole("button", { name: "分组菜单" });
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "编辑分组" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "删除分组" })).toBeDisabled();
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alphaalpha.example" })).toHaveFocus();
  });

  it("opens only one group menu and supports opening at the last enabled action", async () => {
    const user = userEvent.setup();
    render(sidebar({ groups, onEditGroup: () => {}, onDeleteGroup: () => {} }));
    const productionTrigger = within(screen.getByRole("group", { name: "生产" })).getByRole("button", { name: "分组菜单" });
    const archiveTrigger = within(screen.getByRole("group", { name: "归档" })).getByRole("button", { name: "分组菜单" });
    productionTrigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "删除分组" })).toHaveFocus();
    await user.click(archiveTrigger);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "归档 分组菜单" })).toBeVisible();
    expect(productionTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("disables creation while connections are loading", () => {
    render(sidebar({ groups, loading: true, onNewGroup: () => {} }));
    expect(screen.getByRole("button", { name: "新建连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建分组" })).toBeDisabled();
    expect(screen.queryByRole("group", { name: "生产" })).not.toBeInTheDocument();
  });
});
