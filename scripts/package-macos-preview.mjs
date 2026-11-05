import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, description) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${description}: ${error.stderr || error.message}`);
  }
}

function plist(app, key) {
  return run(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", join(app, "Contents/Info.plist")],
    `Cannot read application ${key}`,
  );
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOutsideApp(app, output) {
  const appIdentity = lstatSync(realpathSync(app));
  let ancestor = output;
  while (!statIfPresent(ancestor)) {
    ancestor = dirname(ancestor);
  }
  ancestor = realpathSync(ancestor);
  // APFS can preserve differently cased aliases even after realpath.
  for (;;) {
    if (sameFile(lstatSync(ancestor), appIdentity)) {
      throw new Error("Output must be outside the input application bundle");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function verifyBundle(app, version) {
  run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", app],
    "Application signature verification failed",
  );
  if (!existsSync(join(app, "Contents/_CodeSignature/CodeResources"))) {
    throw new Error("Application signature has no sealed resources");
  }
  if (plist(app, "CFBundleIdentifier") !== "com.fileworker.desktop") {
    throw new Error("Application bundle identifier is not FileWorker");
  }
  if (plist(app, "CFBundleShortVersionString") !== version) {
    throw new Error("Preview tag base version does not match the app version");
  }
  const executable = plist(app, "CFBundleExecutable");
  if (basename(executable) !== executable) {
    throw new Error("Invalid application executable name");
  }
  const architecture = run(
    "/usr/bin/lipo",
    ["-archs", join(app, "Contents/MacOS", executable)],
    "Cannot verify application architecture",
  );
  if (architecture !== "arm64") {
    throw new Error("This preview packager requires a macOS arm64 app");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      app: { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: true,
  });
  const [tag] = positionals;
  const match = /^v(\d+\.\d+\.\d+)-preview\.\d+$/.exec(tag ?? "");
  if (positionals.length !== 1 || !match) {
    throw new Error(
      "Expected a preview tag: v0.1.0-preview.3 [--app path] [--output directory]",
    );
  }
  if (process.platform !== "darwin") {
    throw new Error("macOS is required to verify and package this preview");
  }
  const app = resolve(
    values.app ?? join(root, "target/release/bundle/macos/FileWorker.app"),
  );
  if (basename(app) !== "FileWorker.app") {
    throw new Error("Expected an application named FileWorker.app");
  }
  const output = resolve(
    values.output ?? join(root, "target/previews", tag),
  );
  assertOutsideApp(app, output);
  if (existsSync(output)) {
    throw new Error(`Release output already exists: ${output}`);
  }
  verifyBundle(app, match[1]);

  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".fileworker-preview-"));
  const published = [];
  let reservation;
  let complete = false;
  try {
    const name = `FileWorker-${tag}-macos-arm64.app.zip`;
    const zip = join(staging, name);
    run(
      "/usr/bin/ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip],
      "Cannot archive application",
    );
    run("/usr/bin/unzip", ["-tq", zip], "ZIP integrity verification failed");
    const extracted = join(staging, "verify");
    run(
      "/usr/bin/ditto",
      ["-x", "-k", zip, extracted],
      "Cannot extract application for verification",
    );
    verifyBundle(join(extracted, "FileWorker.app"), match[1]);
    rmSync(extracted, { recursive: true });

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(zip)) hash.update(chunk);
    const checksum = hash.digest("hex");
    writeFileSync(join(staging, `${name}.sha256`), `${checksum}  ${name}\n`, {
      flag: "wx",
    });
    try {
      mkdirSync(output);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Release output already exists: ${output}`);
      }
      throw error;
    }
    reservation = lstatSync(output);
    for (const filename of [name, `${name}.sha256`]) {
      const source = join(staging, filename);
      const path = join(output, filename);
      const identity = lstatSync(source);
      linkSync(source, path);
      published.push({ path, identity });
    }
    complete = true;
    console.log(`Verified macOS arm64 preview: ${join(output, name)}`);
    console.log(`SHA-256: ${checksum}`);
    console.log(
      "Ad-hoc signing is not Developer ID signing or notarization. macOS may require per-app approval.",
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!complete && sameFile(statIfPresent(output), reservation)) {
      for (const { path, identity } of published) {
        if (sameFile(statIfPresent(path), identity)) unlinkSync(path);
      }
      try {
        rmdirSync(output);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
