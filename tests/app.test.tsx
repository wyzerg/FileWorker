import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ConnectionGroup, ConnectionProfile, DirectoryListing } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  profiles: [] as ConnectionProfile[],
  groups: [] as ConnectionGroup[],
  listDirectory: vi.fn(),
  getEnvironment: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  isDesktop: true,
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  api: {
    transferSnapshot: async () => ({ revision: 0, concurrency: 3, jobs: [] }),
    getEnvironment: (...args: unknown[]) => fixture.getEnvironment(...args),
    listDirectory: (...args: unknown[]) => fixture.listDirectory(...args),
    listProfiles: async () => [...fixture.profiles],
    listGroups: async () => [...fixture.groups],
    credentialStatus: async () => ({ available: false, supported: true }),
    saveGroup: async (group: ConnectionGroup) => {
      fixture.groups = [...fixture.groups.filter((item) => item.id !== group.id), group];
      return group;
    },
    deleteGroup: async (id: string) => {
      fixture.groups = fixture.groups.filter((group) => group.id !== id);
      fixture.profiles = fixture.profiles.map((profile) => profile.groupId === id ? { ...profile, groupId: null } : profile);
    },
    saveProfile: async (profile: ConnectionProfile) => {
      fixture.profiles = [...fixture.profiles.filter((item) => item.id !== profile.id), profile];
      return profile;
    },
    deleteProfile: async (id: string) => {
      fixture.profiles = fixture.profiles.filter((item) => item.id !== id);
    },
    chooseDirectory: async () => null,
    choosePrivateKey: async () => null,
  },
}));

const home: DirectoryListing = {
  path: "/home/tester", parentPath: "/home", warnings: [],
  entries: [
    { name: "Projects", path: "/home/tester/Projects", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false },
    { name: "notes.txt", path: "/home/tester/notes.txt", isDir: false, isSymlink: false, size: 1024, modifiedMs: null, hidden: false },
  ],
};

beforeEach(() => {
  fixture.profiles = [];
  fixture.groups = [];
  fixture.listDirectory.mockReset().mockResolvedValue(home);
  fixture.getEnvironment.mockReset().mockResolvedValue({
    homePath: "/home/tester", runtime: "desktop",
    shortcuts: [{ name: "主目录", path: "/home/tester" }],
  });
});

describe("工作区", () => {
  it("显示真实目录响应，双击目录切换路径", async () => {
    fixture.listDirectory.mockImplementation(async (path: string | null) =>
      path === "/home/tester/Projects"
        ? { path, parentPath: "/home/tester", entries: [], warnings: [] }
        : home,
    );
    render(<App />);
    await screen.findByText("Projects");
    fireEvent.doubleClick(screen.getByText("Projects"));
    await waitFor(() => expect(screen.getByLabelText("本地路径")).toHaveValue("/home/tester/Projects"));
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("目录读取失败时显示错误而不是伪装为空目录", async () => {
    fixture.listDirectory.mockRejectedValue(new Error("没有读取权限"));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("没有读取权限");
  });

  it("新建配置只保存非敏感字段并立即显示在侧栏", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新建连接" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("连接名称"), "开发服务器");
    await user.type(within(dialog).getByLabelText("主机地址"), "dev.example.com");
    await user.type(within(dialog).getByLabelText("用户名"), "deploy");
    await user.click(within(dialog).getByRole("button", { name: "仅保存配置" }));
    expect(await screen.findByRole("button", { name: /开发服务器/ })).toBeInTheDocument();
    expect(fixture.profiles).toHaveLength(1);
    expect(fixture.profiles[0]).not.toHaveProperty("password");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("可以新建、改名和删除分组，删除后连接移回未分组", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Projects");
    await user.click(screen.getByRole("button", { name: "新建分组" }));
    await user.type(screen.getByLabelText("分组名称"), "生产环境");
    await user.click(screen.getByRole("button", { name: "保存分组" }));
    const group = await screen.findByRole("group", { name: "生产环境" });
    await user.click(within(group).getByRole("button", { name: "分组菜单" }));
    await user.click(screen.getByRole("menuitem", { name: "新建连接" }));
    expect(screen.getByLabelText("连接分组")).toHaveValue(fixture.groups[0].id);
    await user.type(screen.getByLabelText("连接名称"), "生产一号");
    await user.type(screen.getByLabelText("主机地址"), "prod.example.invalid");
    await user.type(screen.getByLabelText("用户名"), "tester");
    await user.click(screen.getByRole("button", { name: "仅保存配置" }));
    expect(await within(group).findByRole("button", { name: /生产一号/ })).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "分组菜单" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑分组" }));
    await user.clear(screen.getByLabelText("分组名称"));
    await user.type(screen.getByLabelText("分组名称"), "正式环境");
    await user.click(screen.getByRole("button", { name: "保存分组" }));
    const renamed = await screen.findByRole("group", { name: "正式环境" });
    await user.click(within(renamed).getByRole("button", { name: "分组菜单" }));
    await user.click(screen.getByRole("menuitem", { name: "删除分组" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("不会删除连接");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除分组" }));
    expect(await within(screen.getByRole("navigation", { name: "已保存连接" })).findByRole("button", { name: /生产一号/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正式环境" })).not.toBeInTheDocument();
    expect(fixture.profiles).toHaveLength(1);
    expect(fixture.profiles[0].groupId).toBeNull();
  });

  it("右键操作的连接不必是当前选中的连接", async () => {
    const user = userEvent.setup();
    const base: ConnectionProfile = {
      id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "当前连接", host: "test.example.invalid",
      port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: ".",
    };
    fixture.profiles = [base, { ...base, id: "ee3b9e96-029c-44b6-9451-9828b3eb0052", name: "另一连接" }];
    render(<App />);
    const current = await screen.findByRole("button", { name: /当前连接.*test/ });
    const other = screen.getByRole("button", { name: /另一连接.*test/ });
    fireEvent.contextMenu(other, { clientX: 110, clientY: 250 });
    expect(current).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("menuitem", { name: "编辑连接" }));
    expect(screen.getByLabelText("连接名称")).toHaveValue("另一连接");
    await user.click(screen.getByRole("button", { name: "关闭对话框" }));
    fireEvent.contextMenu(other);
    await user.click(screen.getByRole("menuitem", { name: "删除连接" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("另一连接");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除连接" }));
    expect(screen.queryByRole("button", { name: /另一连接.*test/ })).not.toBeInTheDocument();
    expect(current).toHaveAttribute("aria-pressed", "true");
  });

  it("修改分组名称不会改变侧栏分组顺序", async () => {
    fixture.groups = [{ id: "group-first", name: "生产" }, { id: "group-second", name: "测试" }];
    const user = userEvent.setup();
    render(<App />);
    const first = await screen.findByRole("group", { name: "生产" });
    await user.click(within(first).getByRole("button", { name: "分组菜单" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑分组" }));
    await user.clear(screen.getByLabelText("分组名称"));
    await user.type(screen.getByLabelText("分组名称"), "正式环境");
    await user.click(screen.getByRole("button", { name: "保存分组" }));
    const names = within(screen.getByRole("navigation", { name: "已保存连接" }))
      .getAllByRole("group").map((element) => element.getAttribute("aria-label"));
    expect(names).toEqual(["正式环境", "测试", "未分组"]);
  });

  it("延迟的环境初始化不会覆盖用户已经打开的目录", async () => {
    let finishEnvironment!: (value: unknown) => void;
    fixture.getEnvironment.mockReturnValue(new Promise((resolve) => { finishEnvironment = resolve; }));
    fixture.listDirectory.mockImplementation(async (path: string | null) =>
      path === "/manual" ? {
        path, parentPath: "/", warnings: [],
        entries: [{ ...home.entries[1], name: "manual.txt", path: "/manual/manual.txt" }],
      } : home,
    );
    render(<App />);
    const input = screen.getByLabelText("本地路径");
    fireEvent.change(input, { target: { value: "/manual" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("manual.txt");
    await act(async () => {
      finishEnvironment({ homePath: "/home/tester", shortcuts: [], runtime: "desktop" });
    });
    expect(input).toHaveValue("/manual");
    expect(screen.getByText("manual.txt")).toBeInTheDocument();
  });

  it("筛选隐藏已选文件后仍然可以通过键盘进入可见列表", async () => {
    render(<App />);
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getByText("notes.txt"));
    fireEvent.change(screen.getByLabelText("筛选本地文件"), { target: { value: "Projects" } });
    expect(screen.getByText("Projects").closest("tr")).toHaveAttribute("tabindex", "0");
    expect(screen.queryByText(/已选择 1 项/)).not.toBeInTheDocument();
  });

  it("旧目录请求晚返回时不会覆盖较新的目录结果", async () => {
    let finishOld!: (value: DirectoryListing) => void;
    fixture.listDirectory.mockImplementation((path: string | null) => {
      if (path === "/slow") return new Promise((resolve) => { finishOld = resolve; });
      return Promise.resolve(path === "/fast" ? { ...home, path: "/fast", entries: [] } : home);
    });
    render(<App />);
    await screen.findByText("Projects");
    const input = screen.getByLabelText("本地路径");
    fireEvent.change(input, { target: { value: "/slow" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "/fast" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText("此目录为空")).toBeInTheDocument());
    await act(async () => { finishOld({ ...home, path: "/slow" }); });
    expect(input).toHaveValue("/fast");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });
});
