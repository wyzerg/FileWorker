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
