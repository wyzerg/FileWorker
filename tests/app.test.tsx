import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ConnectionProfile, DirectoryListing } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  profiles: [] as ConnectionProfile[],
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
    await user.click(within(dialog).getByRole("button", { name: "保存连接" }));
    expect(await screen.findByRole("button", { name: /开发服务器/ })).toBeInTheDocument();
    expect(fixture.profiles).toHaveLength(1);
    expect(fixture.profiles[0]).not.toHaveProperty("password");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
