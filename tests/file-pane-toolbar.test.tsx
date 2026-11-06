import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FilePane } from "../src/components/FilePane";
import type { DirectoryListing } from "../src/lib/types";

const listing: DirectoryListing = {
  path: "/local", parentPath: "/", warnings: [],
  entries: [
    { name: "notes.txt", path: "/local/notes.txt", isDir: false, isSymlink: false, size: 8, modifiedMs: null, hidden: false },
    { name: "folder", path: "/local/folder", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false },
    { name: "link", path: "/local/link", isDir: false, isSymlink: true, size: 8, modifiedMs: null, hidden: false },
  ],
};

it("the local file toolbar uploads the selected files and opens the directory picker", () => {
  const upload = vi.fn(), chooseDirectory = vi.fn();
  render(<FilePane side="local" path="/unsubmitted" listing={listing} transferEnabled
    onTransfer={upload} onChooseDirectory={chooseDirectory} />);
  const toolbar = screen.getByRole("toolbar", { name: "本地文件操作" });
  const uploadButton = within(toolbar).getByRole("button", { name: "上传所选文件" });
  expect(uploadButton).toBeDisabled();
  fireEvent.click(screen.getByText("notes.txt"));
  expect(uploadButton).toBeEnabled();
  fireEvent.click(uploadButton);
  expect(upload).toHaveBeenCalledExactlyOnceWith([listing.entries[0]]);
  fireEvent.click(within(toolbar).getByRole("button", { name: "选择本地目录" }));
  expect(chooseDirectory).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("button", { name: "上传所选文件" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "选择本地目录" })).toHaveLength(1);
});

it.each([
  { name: "without a transfer connection", transferEnabled: false },
  { name: "while loading", transferEnabled: true, loading: true },
  { name: "in browser preview", transferEnabled: true, preview: true },
])("the local toolbar cannot upload $name", (options) => {
  const upload = vi.fn();
  render(<FilePane side="local" path="/local" listing={listing} onTransfer={upload} {...options} />);
  fireEvent.click(screen.getByText("notes.txt"));
  const toolbar = screen.getByRole("toolbar", { name: "本地文件操作" });
  const button = within(toolbar).getByRole("button", { name: "上传所选文件" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(upload).not.toHaveBeenCalled();
  if (options.preview) expect(within(toolbar).getByRole("button", { name: "选择本地目录" })).toBeDisabled();
});

it.each(["folder", "link"])("the local toolbar cannot upload a selected %s", (name) => {
  const upload = vi.fn();
  render(<FilePane side="local" path="/local" listing={listing} transferEnabled onTransfer={upload} />);
  fireEvent.click(screen.getByText(name));
  const button = within(screen.getByRole("toolbar", { name: "本地文件操作" }))
    .getByRole("button", { name: "上传所选文件" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(upload).not.toHaveBeenCalled();
});

it.each(["local", "remote"] as const)("the %s toolbar includes filtering and hidden-file controls with the file actions", (side) => {
  const label = side === "local" ? "本地" : "远程";
  render(<FilePane side={side} path="/local" listing={{
    ...listing, entries: [...listing.entries, { ...listing.entries[0], name: ".hidden", path: "/local/.hidden", hidden: true }],
  }} connected transferEnabled />);
  const toolbar = screen.getByRole("toolbar", { name: `${label}文件操作` });
  fireEvent.change(within(toolbar).getByRole("textbox", { name: `筛选${label}文件` }), { target: { value: "notes" } });
  expect(screen.getByText("notes.txt")).toBeVisible();
  expect(screen.queryByText("folder")).not.toBeInTheDocument();
  fireEvent.change(within(toolbar).getByRole("textbox", { name: `筛选${label}文件` }), { target: { value: "" } });
  expect(screen.queryByText(".hidden")).not.toBeInTheDocument();
  fireEvent.click(within(toolbar).getByRole("button", { name: "显示隐藏文件" }));
  expect(screen.getByText(".hidden")).toBeVisible();
});

it("the remote overflow menu acts on the current selection and returns focus to its trigger", () => {
  const onAction = vi.fn();
  render(<FilePane side="remote" path="/local" listing={listing} connected transferEnabled onFileAction={onAction} />);
  fireEvent.click(screen.getByText("notes.txt"));
  const more = screen.getByRole("button", { name: "更多文件操作" });
  fireEvent.click(more);
  const menu = screen.getByRole("menu", { name: "远程文件操作" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "复制路径" }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith("copyPath", [listing.entries[0]]);
  expect(more).toHaveFocus();
  expect(screen.getByText("notes.txt").closest("tr")).toHaveAttribute("aria-selected", "true");
  fireEvent.click(more);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(more).toHaveFocus();
});

it("changing a checkbox on the context-menu row closes the old target snapshot", () => {
  const onAction = vi.fn();
  const second = { ...listing.entries[0], name: "second.txt", path: "/local/second.txt" };
  render(<FilePane side="remote" path="/local" listing={{ ...listing, entries: [listing.entries[0], second] }}
    connected transferEnabled onFileAction={onAction} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "选择全部远程文件" }));
  fireEvent.contextMenu(screen.getByText("notes.txt").closest("tr")!, { clientX: 200, clientY: 250 });
  expect(screen.getByRole("menu", { name: "远程文件操作" })).toBeVisible();
  const checkbox = screen.getByRole("checkbox", { name: "选择 notes.txt" });
  fireEvent.pointerDown(checkbox);
  fireEvent.click(checkbox);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith("delete", [second]);
});
