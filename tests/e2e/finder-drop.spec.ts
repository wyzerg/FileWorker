import { expect, test, type Page } from "@playwright/test";

async function installFixture(page: Page) {
  await page.addInitScript(() => {
    const profile = {
      id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "Finder 验收",
      host: "test.example.invalid", port: 22, username: "tester", authMethod: "password",
      privateKeyPath: null, remotePath: "/remote",
    };
    const callbacks = new Map<number, (event: unknown) => void>();
    let nextCallback = 1;
    const listeners = new Map<string, number>();
    let enqueues = 0;
    const jobs: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __finderFixture: {
        emit: (payload: { phase: string; paths?: string[]; position: { x: number; y: number } }) => {
          const event = `tauri://drag-${payload.phase}`;
          const callback = listeners.get(event);
          if (callback !== undefined) callbacks.get(callback)?.({
            event, id: 1, payload: {
              type: payload.phase, paths: payload.paths, position: payload.position,
            },
          });
        },
        enqueues: () => enqueues,
      },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: (callback: (event: unknown) => void) => {
          const id = nextCallback++; callbacks.set(id, callback); return id;
        },
        invoke: async (command: string, args: Record<string, unknown>) => {
          switch (command) {
            case "get_environment": return { homePath: "/local", runtime: "desktop", shortcuts: [], finderDrop: true };
            case "list_profiles": return [profile];
            case "list_local_directory": return { path: "/local", parentPath: "/", warnings: [], entries: [] };
            case "probe_connection": return {
              attemptId: args.attemptId, host: profile.host, port: 22, trusted: true,
              identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:test" },
            };
            case "authenticate_connection": return { sessionId: "session", profileId: profile.id, initialPath: "/remote", warning: null };
            case "list_remote_directory": return { path: "/remote", parentPath: "/", warnings: [], entries: [] };
            case "transfer_snapshot": return structuredClone({ revision: jobs.length, concurrency: 3, jobs });
            case "plugin:event|listen":
              if (typeof args.event !== "string"
                || JSON.stringify(args.target) !== JSON.stringify({ kind: "Webview", label: "main" })) {
                throw new Error("unexpected native event subscription");
              }
              listeners.set(args.event, args.handler as number);
              return 1;
            case "enqueue_finder_upload":
              enqueues += 1;
              if (JSON.stringify(args.paths) !== JSON.stringify(["/finder/finder-first.txt", "/finder/报告 second.txt"])
                || args.sessionId !== "session" || args.destinationDir !== "/remote") {
                throw new Error("unexpected native upload destination");
              }
              for (const name of ["finder-first.txt", "报告 second.txt"]) jobs.push({
                id: `job-${jobs.length}`, name, attempt: 1, direction: "upload", sessionId: "session",
                sourcePath: `/finder/${name}`, destinationDir: "/remote", destinationPath: null, state: "queued",
                transferredBytes: 0, totalBytes: 4, bytesPerSecond: 0, etaSeconds: null, error: null, warning: null,
              });
              return jobs.map((job) => job.id);
            case "cancel_connection":
            case "disconnect_session":
            case "plugin:window|set_theme":
            case "plugin:event|unlisten": return;
            default: throw new Error(`未配置命令：${command}`);
          }
        },
      },
    });
  });
}

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "连接服务器", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill("isolated");
  await page.getByRole("dialog").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByRole("button", { name: "断开服务器" })).toBeVisible();
}

async function nativeEvent(page: Page, phase: string, position: { x: number; y: number }) {
  await page.evaluate(({ phase, position }) => {
    const fixture = (window as unknown as {
      __finderFixture: { emit: (payload: unknown) => void };
    }).__finderFixture;
    const physicalPosition = {
      x: position.x * window.innerWidth * window.devicePixelRatio,
      y: position.y * window.innerHeight * window.devicePixelRatio,
    };
    fixture.emit({
      phase, position: physicalPosition,
      paths: phase === "enter" || phase === "drop"
        ? ["/finder/finder-first.txt", "/finder/报告 second.txt"] : undefined,
    });
  }, { phase, position });
}

for (const [theme, width] of [["dark", 1280], ["light", 800]] as const) {
  test(`${theme} ${width} 原生事件边界高亮目标并批量入队一次`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installFixture(page);
    await page.setViewportSize({ width, height: 820 });
    await page.emulateMedia({ colorScheme: theme });
    await connect(page);
    const pane = page.getByRole("region", { name: "远程文件", exact: true });
    const zone = pane.locator(".file-list-container");
    const bounds = (await zone.boundingBox())!;
    const position = { x: (bounds.x + bounds.width / 2) / width, y: (bounds.y + bounds.height / 2) / 820 };
    await page.getByLabel("远程路径", { exact: true }).fill("/not-opened");
    await nativeEvent(page, "enter", position);
    await expect(pane).toHaveClass(/file-pane--drop-target/u);
    expect(await zone.boundingBox()).toEqual(bounds);
    await page.screenshot({ path: `test-results/${theme}-finder-${width}.png` });
    await nativeEvent(page, "drop", position);
    await nativeEvent(page, "drop", position);
    await expect(page.locator(".transfer-row")).toHaveCount(2);
    await expect(page.locator(".transfer-direction.upload")).toHaveCount(2);
    await expect(page.locator(".transfer-file > span").first()).toHaveText("/remote");
    await expect(pane).not.toHaveClass(/file-pane--drop-target/u);
    expect(await page.evaluate(() => (window as unknown as { __finderFixture: { enqueues: () => number } }).__finderFixture.enqueues())).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("原生放到本地栏或被弹窗遮挡的远程栏都不能入队", async ({ page }) => {
  await installFixture(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await connect(page);
  const local = (await page.locator(".file-pane--local .file-list-container").boundingBox())!;
  const remote = (await page.locator(".file-pane--remote .file-list-container").boundingBox())!;
  const point = (bounds: typeof local) => ({ x: (bounds.x + bounds.width / 2) / 1280, y: (bounds.y + bounds.height / 2) / 820 });
  await nativeEvent(page, "enter", point(local));
  await nativeEvent(page, "drop", point(local));
  await page.getByRole("button", { name: "添加 SFTP 连接" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await nativeEvent(page, "enter", point(remote));
  await nativeEvent(page, "drop", point(remote));
  await expect(page.locator(".transfer-row")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __finderFixture: { enqueues: () => number } }).__finderFixture.enqueues())).toBe(0);
});
