# 连接管理与分组验收 · 2026-11-05

## 产物与环境

- 标签：`v0.1.0-preview.4`，应用内基础版本仍为 `0.1.0`。
- 平台：macOS `26.5.2`（`25F84`），Apple Silicon `arm64`。
- ZIP：`FileWorker-v0.1.0-preview.4-macos-arm64.app.zip`，`5,342,574` 字节。
- SHA-256：

  ```text
  187651ed0fa5bd07a618296fb2797c75bc272b9d65136f35abc5313a5329fd6e
  ```

- 优化 `.app` 使用完整 ad-hoc 签名；打包器检查签名、资源封装、标识、基础版本、
  架构、ZIP 完整性，并解压复验。不是 Developer ID 分发签名，没有 Apple 公证。
- 原生验收直接使用上述 ZIP 解压应用，没有替换程序或绕过连接校验。
  该证据不等于浏览器下载后的首次启动或 Gatekeeper 信任通过。

## 功能和配置

- 单层可选分组，支持创建、改名、删除、展开和折叠；删除组保留连接和凭据。
  连接可在组之间移动，也可置于未分组；改名保留原顺序。
- 连接右键及更多菜单以实际点击的连接为操作对象，支持连接、编辑、复制、
  忘记已存凭据、删除；不为打开菜单而切换当前会话。
- 表单直接输入密码，或选择私钥文件、粘贴私钥内容及口令；
  测试连接、仅保存配置、保存并连接为独立动作。
- 测试使用独立管理器，强制不保存凭据，结束后关闭测试会话。
  首次测试也需核对和信任主机指纹；信任记录可保存，不属于配置或密码保存。
- 实际存在凭据才提供已存模式；更换、返回及认证失败保留本次手工输入。
  只有明确记住且认证成功后才保存到 macOS Keychain；配置和浏览器存储不含秘密。
- 配置 v1 只读不迁移，首次有效修改前原字节备份为私有
  `profiles.v1.backup.json`，不覆盖已有备份；随后原子写入 v2 文档。
  迁移失败保留原文件，损坏或未知字段不会被静默覆盖。
- 配置身份变更或删除先取消旧认证并移除对应凭据；阻止迟到认证重新保存。
  清理失败不保存新配置；若之后磁盘失败，保留旧配置并说明可能需重新输入凭据。
  改名、分组和默认目录变更不重置会话；忘记凭据不终止健康的活动会话。
- 有未完成传输时，前端阻止切换、重连、删除当前连接或修改其认证身份。
  凭据协调限定于单个应用进程，不保证多实例同时修改相同凭据。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| Vitest | `161/161`，共 `14` 个文件。 |
| Playwright | `23/23`，含明暗、1280/800/390 像素与矮窗口。 |
| Rust 工作区，显式包含 ignored | `93` 项通过，`0` 失败、`0` 跳过。 |
| 真实 AsyncSSH 协议 | 上述 Rust 中 `31/31`。 |
| 真实 macOS Keychain 随机账号 | 上述 Rust 中 `1/1`，自动删除测试条目。 |
| C AddressSanitizer 真实协议 | `31/31`，未启用泄漏检测。 |
| macOS 打包回归 | `11/11`，在最终优化应用构建完成后顺序执行。 |
| 其他 | TypeScript、生产前端构建、格式、Clippy `-D warnings`、优化 `.app` 构建通过。 |

回归覆盖迁移备份和文件权限、重复分组与并发写入、错误字段与秘密拒绝、
粘贴私钥格式/大小限制、主机信任前不读取凭据、加密私钥错误口令重试、
测试不影响原会话和传输、删除/改身份与迟到凭据保存竞争、删除中断待握手、
忘记凭据与活动会话保留。没有使用真实服务器、密码或用户 SSH 私钥。

界面回归覆盖 StrictMode 菜单、重复点击开关、上下文目标、长表单滚动、
折叠重启与后续选择展开、保存和测试重复提交、输入往返保留、弹窗栈清理及焦点恢复。
Playwright 使用模拟 IPC，不能替代原生 SSH、钥匙串或窗口行为验收。

常规执行：

```bash
bash scripts/run.sh test
bash scripts/run.sh test:e2e
bash scripts/run.sh build
env FILEWORKER_TEST_PYTHON="$PWD/target/connection-ux-test-venv/bin/python" \
  cargo test --workspace -- --include-ignored
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
bash scripts/run.sh tauri build --bundles app --ci -- --locked
bash scripts/run.sh test:preview
bash scripts/run.sh preview:package v0.1.0-preview.4
```

协议环境使用 `asyncssh==2.21.1`，生成一次性密钥，仅监听回环地址。ASan 使用独立
构建目录，实际对 C/OpenSSL/libssh2 依赖插桩，而非只给 Rust 测试加运行变量：

```bash
env CFLAGS='-fsanitize=address -fno-omit-frame-pointer -g' \
  RUSTFLAGS="-C link-arg=$(xcrun clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib) -C force-frame-pointers=yes" \
  MACOSX_DEPLOYMENT_TARGET=11.0 \
  CARGO_TARGET_DIR=target/connection-ux-c-asan \
  cargo test -p fileworker-core --target aarch64-apple-darwin \
  --test sftp_integration --no-run --locked
```

对编译输出的测试可执行文件设置 `FILEWORKER_TEST_PYTHON`、
`ASAN_OPTIONS=detect_leaks=0`，以及包含该 ASan 动态库的 `DYLD_LIBRARY_PATH`，
执行 `--include-ignored`。`nm -u` 确认 libssh2 的 `userauth.o` 存在
`__asan_init`、`__asan_report_load*`、`__asan_report_store*` 与栈插桩符号。
本轮没有声称泄漏检测通过。

## 原生应用

使用独立 HOME、生成的 `tester` 测试账户和回环 SFTP，实测：

1. 创建分组，从组菜单新建连接时预选该组。
2. 输入密码测试，向生成主机公钥核对指纹后信任，显示连接测试成功；
   表单和输入保留，草稿不写入配置、不保存秘密。
3. 保存并连接成功，编辑弹窗关闭后工作区仍可操作。
4. 折叠分组，退出重开保持折叠；连接中重命名分组不打断会话。
5. 实际右键显示该连接的管理菜单；删除等变更动作另由浏览器与核心测试验证，
   未将菜单出现记为原生删除全流程通过。
6. 选择生成的加密 ed25519 私钥文件并输入口令，测试成功。
7. 粘贴生成的未加密 OpenSSH 私钥，通过实际 Tauri IPC 测试成功；
   关闭未保存草稿后原会话仍可刷新目录。
8. 明确勾选记住密码，连接成功后断开；再次连接显示「已保存密码」，
   无需重新输入即可连接。生成条目在验收后精确删除。
9. 标题文字双击最大化和恢复正常；拖动标题文字并完整释放鼠标后，
   原生窗口边界从 `(320,76,1280,820)` 移至 `(423,576,1280,820)`。
   最初自动拖动缺少完整释放，未观察到位移；补齐原生释放后才记为通过，
   未修改业务代码绕过验收。空白拖动区未单独测量。

首次在独立 HOME 内记住密码时，系统安全存储报告失败，已连接会话仍然可用。
检查发现该 HOME 没有默认钥匙串；正常 HOME 的随机 Keychain 往返通过，
相同隔离 HOME 的往返失败，定位为验收环境差异。
仅在隔离 HOME 内临时建立 `Library/Keychains` 到本机钥匙串目录的符号链接，
未改变系统默认钥匙串设置；随后随机往返和实际应用保存重连均通过。
清理时先移除该链接，不递归进入真实钥匙串目录。

## 清理和未验收项

- 精确计算生成连接的凭据账号，仅删除对应服务/账号的 Keychain 条目；
  metadata 查询返回不存在，未读取或删除其他用户凭据。
- 停止验收应用和回环服务，端口 `53250` 不再监听，无本轮应用或夹具进程。
- 删除本轮独立 HOME、生成配置、主机密钥、远端样本、解压副本、Python 虚拟环境、
  ASan 构建及 Playwright 报告。权限拒绝样本目录先恢复自身权限后删除。
- 保留优化构建与发布 ZIP；保留先前尚待用户确认首次启动的
  `target/native-preview-signing-acceptance-OQOJdO`，不清理用户下载或应用。
- 真实用户 `profiles.json` 与 `known_hosts.json` 的前后 SHA-256 均未改变。
- 本轮没有重做 Finder 拖入、实际浏览器下载、Gatekeeper 首次启动、
  最低 macOS、安装升级/回退、Intel Mac、Windows 或 Linux 原生验收。
  没有 Developer ID 签名、公证、稳定发行或无提示启动承诺。
- Finder 拖出、目录递归、暂停/恢复、断点续传及跨重启队列恢复仍未实现。
