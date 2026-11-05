# 远程工作区验收 · 2026-11-05

## 产物与范围

- 标签：`v0.1.0-preview.5`，基础版本仍为 `0.1.0`。
- 实测：macOS `26.5.2`（`25F84`），Apple Silicon `arm64`。
- ZIP：`FileWorker-v0.1.0-preview.5-macos-arm64.app.zip`，`5,384,975` 字节。
- SHA-256：`b7e8a3240db9fbed4a7989c79da76d1fc39eba38922a7079af906ab1acee18e9`。
- 使用上述 ZIP 解压后的原样应用，通过隔离 HOME 和生成的回环 SFTP 服务验收，
  不修改真实用户配置，不访问真实服务器或用户 SSH 私钥。
- 完整 ad-hoc 签名，不是 Developer ID 签名，未公证；本机运行证据不等于
  浏览器下载后的首次启动、Gatekeeper 信任或最低系统验证。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| Vitest | `192/192`，`17` 个文件；默认及随机种子 `1105`、`515` 均通过。 |
| Playwright | `25/25`，明暗主题、1280×820、800×580、800×480、390×844。 |
| Rust 工作区，显式包含 ignored | `101` 项通过，`0` 失败、`0` 跳过。 |
| 真实 AsyncSSH 协议 | 上述 Rust 中 `35/35`。 |
| 随机 macOS Keychain | 上述 Rust 中 `1/1`，精确自动删除测试条目。 |
| C AddressSanitizer 真实协议 | `35/35`，未启用泄漏检测。 |
| 打包回归 | `11/11`，优化应用构建后顺序执行。 |
| 其他 | TypeScript、生产前端构建、fmt、全目标 Clippy `-D warnings`、优化 `.app` 构建通过。 |

回归覆盖目录成功记忆、端点隔离、损坏/不可写存储、回退一次和网络错误不回退，
首次信任前不读取凭据、自动认证失败后手工输入、已连接双击不重连、
显式保存并连接仍应用新输入，以及精确会话、迟到预览和重复提交隔离。

真实协议验证文本/PNG、文件大小和像素边界、UTF-8 和活动内容处理、异常名称/路径、
符号链接/根目录拒绝、`0700` 新建、同名不覆盖、空目录/普通文件删除和非空目录保留。
原生队列预留互斥测试暂停真实 mkdir，确认新传输被拒绝、队列轮询仍可用、
操作完成后恢复传输；未完成传输和同名冲突也阻止文件修改。
删除请求的未知 `recursive` 字段先复现被接受，再修正为严格拒绝；
Finder/连接旧测试等待凭据状态检查完成，不跳过实际禁用保护。

Playwright 对工具栏、菜单、长文本、图片和操作按钮做几何检查，确保矮窗口仍有文件列表，
完整按钮处于弹窗内，队列不覆盖底栏；人工查看代表性截图。
浏览器使用模拟 IPC，不能代替本机协议或系统验收。

运行方式：

```bash
bash scripts/run.sh test
bash scripts/run.sh test --sequence.shuffle --sequence.seed=1105
bash scripts/run.sh test --sequence.shuffle --sequence.seed=515
bash scripts/run.sh test:e2e
bash scripts/run.sh build
env FILEWORKER_TEST_PYTHON="$PWD/target/remote-workspace-test-venv/bin/python" \
  cargo test --workspace -- --include-ignored
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
bash scripts/run.sh tauri build --bundles app --ci -- --locked
bash scripts/run.sh test:preview
bash scripts/run.sh preview:package v0.1.0-preview.5
```

一次性协议环境使用 `asyncssh==2.21.1`。C ASan 构建使用独立 target，
`CFLAGS='-fsanitize=address -fno-omit-frame-pointer -g'`、
`RUSTFLAGS` 链接本机 Clang ASan 动态库并保留帧指针、`MACOSX_DEPLOYMENT_TARGET=11.0`，
构建 `aarch64-apple-darwin` 协议测试；对生成的二进制设置
`ASAN_OPTIONS=detect_leaks=0`、`DYLD_LIBRARY_PATH` 和 `FILEWORKER_TEST_PYTHON`，
执行 `--include-ignored`。`nm -u` 确认 libssh2 `userauth.o` 含
`__asan_init`、load/store 和栈插桩符号；不将仅设置运行变量当作 C 插桩证据。

## 原生应用

测试服务仅监听 `127.0.0.1:61194`，生成主机密钥和 `tester` 账户，不开启系统远程登录。
隔离目录为 `target/native-remote-workspace-acceptance-Yoi34I`；每次显式启动该 HOME 下的
ZIP 解压应用后，才使用原生辅助功能接口获取窗口，避免启动真实用户实例。

1. 双击侧栏连接，首次仍要求信任；屏幕指纹与生成主机密钥的 `ssh-keygen -lf` 一致，
   确认后输入一次性密码并明确勾选记住，成功列出远程文件。
2. 双击 `acceptance.log` 显示只读文本，`<script>` 保持字面内容；
   右键 `status.png` 出现文件操作菜单，没有 Reload，点击预览显示实际 PNG。
3. 工具栏创建目录后列表刷新；属性显示目录权限 `0700`，文件系统侧核对一致。
4. 将新目录改为已存在的 `folder` 时明确报错，原目录与 `child.txt` 保留；
   同一弹窗改为新名称后成功，旧名称不再出现。
5. 右键「刷新目录」后会话仍已连接；此前所有预览/刷新/修改只出现一次密码认证，
   没有偷偷重连。删除弹窗明确显示完整目标、不可撤销及不递归提示；
   取消后目录保留。实际删除只由真实协议测试验证，不宣称本轮原生删除全流程通过。
6. 进入 `/folder`，后退到 `/`，前进返回 `/folder`。退出并用同一 ZIP 应用重启，
   双击直接使用已存密码，不要求再次手工确认，目录恢复为 `/folder`。
7. 工具栏下载 `child.txt`，队列完成、左栏刷新；源文件与下载文件 SHA-256 均为
   `ddc9e669194254cef019a29d3619a2c16592e5d52e1a81e98b01bd52319149a3`。
   传输中修改按钮禁用，完成后恢复。已连接对象再次双击不增加认证次数。
8. 已连接绿点和文字可见，单项连接不再有三点按钮，组及当前连接菜单保留。

独立 HOME 的 Keychain 访问采用此前已定位的验收环境适配：仅在隔离 HOME 内临时链接
`Library/Keychains` 到本机 Keychain 目录，未改变系统默认设置。测试前确认随机生成的
配置身份对应条目不存在，结束后只删除该服务/账号的测试条目，metadata 查询确认不存在。
先移除隔离符号链接，再递归清理测试目录，不进入真实 Keychain 目录。

## 清理与边界

- 测试应用和 SFTP 服务均退出，端口不再监听。
- 删除本轮隔离 HOME、配置、密钥、远端样本、下载文件、解压应用、Python 环境、
  ASan 构建和界面报告，保留发布 ZIP/校验文件及正常优化构建。
- 先前待用户完成首次启动的 `target/native-preview-signing-acceptance-OQOJdO` 保留；
  不清理用户下载、其他应用或未归属本轮的文件。
- 真实用户 `profiles.json` 前后 SHA-256：
  `247f50e205b2a4de8ba6220fc04e3e89681c5f8b1cb0b22fa42a13085fa8b1ac`。
  `known_hosts.json` 前后 SHA-256：
  `6a1bffb2a51786557f1df2e0f74576f5a3b4205e119a24dc6512e3a25203a21f`。
- 未重做浏览器下载首次启动/Gatekeeper 授权、Finder 原生拖入、最低 macOS、
  安装升级/回退、Intel Mac、Windows 或 Linux。Finder 错误投放目标仍待原生验收。
- 无远程编辑回传、递归传输、Finder 拖出、暂停/恢复、断点续传或跨重启队列恢复。
  不因本轮预发布宣称正式稳定发行、Apple 公证或无提示启动。
