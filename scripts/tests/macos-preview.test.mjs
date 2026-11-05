import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = resolve(
  root,
  process.env.FILEWORKER_PREVIEW_APP ??
    "target/release/bundle/macos/FileWorker.app",
);
const script = join(root, "scripts/package-macos-preview.mjs");
const tag = "v0.1.0-preview.999";
const zipName = "FileWorker-v0.1.0-preview.999-macos-arm64.app.zip";
const macOnly = { skip: process.platform !== "darwin" };

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(t) {
  mkdirSync(join(root, "target"), { recursive: true });
  const directory = mkdtempSync(join(root, "target/macos-preview-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = join(directory, "FileWorker.app");
  cpSync(app, copy, { recursive: true });
  succeeds(run("/usr/bin/codesign", ["--force", "--sign", "-", copy]));
  return { directory, app: copy, output: join(directory, "output") };
}

function pack(f, version = tag) {
  return run(process.execPath, [
    script,
    version,
    "--app",
    f.app,
    "--output",
    f.output,
  ]);
}

test("release app has a valid sealed application signature", macOnly, () => {
  const result = run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    app,
  ]);
  succeeds(result);
  assert.ok(existsSync(join(app, "Contents/_CodeSignature/CodeResources")));
});

test("packages a signed app with a verified ZIP and matching checksum", macOnly, (t) => {
  const f = fixture(t);
  const sourcePaths = [
    "Contents/Info.plist",
    "Contents/MacOS/fileworker-app",
    "Contents/_CodeSignature/CodeResources",
  ];
  const before = sourcePaths.map((path) => hash(join(f.app, path)));
  succeeds(pack(f));
  assert.deepEqual(readdirSync(f.output).sort(), [zipName, `${zipName}.sha256`]);
  const zip = join(f.output, zipName);
  assert.equal(
    readFileSync(`${zip}.sha256`, "utf8"),
    `${hash(zip)}  ${zipName}\n`,
  );
  succeeds(run("/usr/bin/unzip", ["-t", zip]));
  const extracted = join(f.directory, "extracted");
  succeeds(run("/usr/bin/ditto", ["-x", "-k", zip, extracted]));
  succeeds(
    run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      join(extracted, "FileWorker.app"),
    ]),
  );
  assert.deepEqual(
    sourcePaths.map((path) => hash(join(f.app, path))),
    before,
  );
  assert.deepEqual(readdirSync(f.directory).sort(), [
    "FileWorker.app",
    "extracted",
    "output",
  ]);
});

test("refuses a missing resource seal without leaving release files", macOnly, (t) => {
  const f = fixture(t);
  rmSync(join(f.app, "Contents/_CodeSignature"), { recursive: true });
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature|resources/i);
  assert.deepEqual(readdirSync(f.directory), ["FileWorker.app"]);
});

test("refuses modified signed resources without leaving release files", macOnly, (t) => {
  const f = fixture(t);
  appendFileSync(join(f.app, "Contents/Resources/icon.icns"), "tampered");
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature|resource/i);
  assert.deepEqual(readdirSync(f.directory), ["FileWorker.app"]);
});

test("never overwrites an existing release directory", macOnly, (t) => {
  const f = fixture(t);
  mkdirSync(f.output);
  const marker = join(f.output, "existing-release");
  writeFileSync(marker, "keep this release");
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/i);
  assert.equal(readFileSync(marker, "utf8"), "keep this release");
  assert.deepEqual(readdirSync(f.output), ["existing-release"]);
});

test("rejects unsafe preview tags without creating output", macOnly, (t) => {
  const f = fixture(t);
  const result = pack(f, "../v0.1.0-preview.1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag/i);
  assert.deepEqual(readdirSync(f.directory), ["FileWorker.app"]);
});

test("rejects a tag whose base version does not match the app", macOnly, (t) => {
  const f = fixture(t);
  const result = pack(f, "v9.0.0-preview.1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version/i);
  assert.deepEqual(readdirSync(f.directory), ["FileWorker.app"]);
});

test("rejects output inside the input bundle before modifying it", macOnly, (t) => {
  const f = fixture(t);
  const resources = join(f.app, "Contents/Resources");
  const before = readdirSync(resources);
  f.output = join(resources, "previews/release");
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside.*application/i);
  assert.deepEqual(readdirSync(resources), before);
  succeeds(run("/usr/bin/codesign", ["--verify", "--deep", "--strict", f.app]));
});

test("rejects an output ancestor symlinked into the input bundle", macOnly, (t) => {
  const f = fixture(t);
  const resources = join(f.app, "Contents/Resources");
  const before = readdirSync(resources);
  const link = join(f.directory, "linked-resources");
  symlinkSync(resources, link);
  f.output = join(link, "previews/release");
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside.*application/i);
  assert.deepEqual(readdirSync(resources), before);
  succeeds(run("/usr/bin/codesign", ["--verify", "--deep", "--strict", f.app]));
});

test("rejects differently cased aliases of the input bundle", macOnly, (t) => {
  const f = fixture(t);
  const alias = join(f.directory, "fileworker.APP");
  if (!existsSync(alias)) {
    t.skip("The test filesystem distinguishes differently cased paths");
    return;
  }
  assert.equal(statSync(alias).ino, statSync(f.app).ino);
  const resources = join(f.app, "Contents/Resources");
  const before = readdirSync(resources);
  f.output = join(alias, "Contents/Resources/previews/release");
  const result = pack(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside.*application/i);
  assert.deepEqual(readdirSync(resources), before);
  succeeds(run("/usr/bin/codesign", ["--verify", "--deep", "--strict", f.app]));
});

test("cleans staging but preserves output created while packaging", macOnly, async (t) => {
  const f = fixture(t);
  let reservation;
  let observerError;
  const observer = watch(f.directory, (_event, name) => {
    if (!name?.startsWith(".fileworker-preview-") || reservation) return;
    try {
      mkdirSync(f.output);
      reservation = statSync(f.output);
    } catch (error) {
      observerError = error;
    }
  });
  t.after(() => observer.close());
  const child = spawn(
    process.execPath,
    [script, tag, "--app", f.app, "--output", f.output],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  observer.close();
  assert.ifError(observerError);
  assert.ok(reservation, "The competing directory was created after staging began");
  assert.notEqual(code, 0);
  assert.match(stderr, /already exists/i);
  assert.equal(statSync(f.output).ino, reservation.ino);
  assert.deepEqual(readdirSync(f.output), []);
  assert.deepEqual(readdirSync(f.directory).sort(), ["FileWorker.app", "output"]);
});
