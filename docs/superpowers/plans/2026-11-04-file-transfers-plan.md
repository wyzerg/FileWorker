# 第三阶段：文件传输与真实队列实施计划

> **执行工作流：** Superpowers 计划执行与测试驱动开发，在当前任务内逐项实现和验收。当前目录没有 Git，不创建仓库、提交、分支或部署，不改变系统服务。

**目标：** 从已连接的双栏工作区上传和下载一个或多个普通文件，显示真实进度，支持取消、手动重试及明确的同名文件决策。

**架构：** 独立于 Tauri 的 Rust 传输队列拥有固定数量后台工作线程，默认并发 `3`，运行时可调整为 `1` 到 `6`。每项任务建立独立 SSH/SFTP 连接并重新验证同一主机身份；活动连接只在内存中以 `Zeroizing` 保存本次认证信息，不要求保存到 Keychain。React 读取带版本号的队列快照，只刷新当前会话和当前路径匹配的传输目标。

**技术栈：** 现有 `ssh2`、Rust 标准线程与同步原语、`tempfile`、Tauri 后台 IPC、React、Vitest、Playwright、隔离 AsyncSSH 服务。

**设计依据：** `docs/superpowers/specs/2026-11-03-sftp-client-design.md` 第 5、6、7、10 节。用户已要求继续既定设计的实现。

## 全局约束

- 不修改已固定的 `libssh2-sys` 提交，不接触用户 SSH 密钥及系统 `known_hosts`。
- 凭据不写入队列快照、JSON、日志或前端持久化；断开后不能再创建该会话的任务。
- 普通文件以外的源（文件夹、符号链接、设备等）拒绝传输，不递归复制。
- 目标已存在时默认进入等待决策，不静默覆盖；提供跳过、明确覆盖和保留两份。
- 同目录临时文件写完、校验长度并关闭后再提交；不支持安全提交的服务器返回失败，不先删旧文件。
- 默认不覆盖的提交必须使用排他语义，处理预检查与最终提交之间新出现的目标。
- 取消单个任务不影响浏览连接或其他任务；断开/切换连接使旧会话的未结束任务取消。
- 队列是当前进程内状态，失败重试从头开始；暂停、断点续传、跨重启恢复和 Finder 拖拽不在本阶段。
- 更新 `README.md` 和追加 `CHANGELOG.md`，不夸大未实测能力。

## 任务一：安全的独立传输连接和流式文件操作

**文件：** `crates/fileworker-core/src/connections.rs`、`sftp.rs`、新增 `transfers/`，协议测试与 fixture。

**接口：**
```rust
TransferManager::new(remote: Arc<ConnectionManager>) -> TransferManager
TransferManager::enqueue(requests: Vec<TransferRequest>) -> Result<Vec<String>, CoreError>
TransferManager::snapshot() -> Result<TransferSnapshot, CoreError>
TransferManager::cancel(id: &str) -> Result<(), CoreError>
TransferManager::retry(id: &str) -> Result<(), CoreError>
TransferManager::resolve_conflict(id: &str, policy: ConflictPolicy) -> Result<(), CoreError>
TransferManager::set_concurrency(concurrency: usize) -> Result<(), CoreError>
TransferManager::clear_finished() -> Result<(), CoreError>
```

- [x] 先写真实协议失败测试：临时密码未入 Keychain 仍可传输，二进制/空文件上传下载内容一致，同名默认不覆盖。
- [x] 实现活动会话的临时零化凭据与独立传输连接。每次握手检查原会话身份及应用主机信任记录，先校验后认证。
- [x] 实现分块读写、取消检查、源变化校验、私有临时目标文件、关闭后提交，以及失败/取消清理。
- [x] 第一轮 16 项真实协议测试通过，新增竞态与关闭回归继续验收。

**接口核实后的限定：** 当前 `ssh2` 的 SFTP v3 重命名不能直接替换已有目标。远程明确覆盖采用
“原文件排他改名为随机备份 → 临时文件排他提交 → 清理备份”，提交失败尝试恢复原文件；
恢复或清理失败会指出备份路径。它保留原文件，但不是无间隙原子替换；短暂缺少目标路径，
断电或断网可能留下需要人工恢复的备份。不使用先删除原文件的回退。

## 任务二：有界队列与状态转换

**文件：** `crates/fileworker-core/src/transfers/mod.rs`、真实协议与状态回归测试。

**数据契约：** `TransferRequest { sessionId, direction, sourcePath, destinationDir }`；
状态为 `queued/running/canceling/conflict/completed/failed/canceled/skipped`；
快照包含 `revision/concurrency/jobs`，每项含真实字节进度、速度、剩余时间、错误及目标路径，不含凭据。

- [x] 先测试并发上限、运行中取消、等待任务取消、冲突跳过/覆盖/保留两份、失败后其他任务继续、手动重试。
- [x] 实现固定工作线程、有限队列容量、稳定入队顺序、可配置并发与单项状态转换；阻塞网络不持有队列锁。
- [x] 实现断开会话清理、Drop 取消和等待后台线程退出，最终提交开始前检查会话和任务取消标记。已发出的最终提交可能完成，不反向撤销成功文件。
- [x] 测试取消不关闭浏览连接、取消中清理以及目标在预检查后出现时不会被覆盖。

## 任务三：桌面 IPC、文件选择与队列界面

**文件：** `src-tauri/src/{commands,lib,remote,transfers}.rs`、`src/lib/{types,api,useTransfers}.ts`、`src/components/{FilePane,TransferQueue}.tsx`、`src/App.tsx`、`src/styles.css` 和对应前端测试。

- [x] 先写失败测试：未连接不能传输，普通文件可多选，目录不可作为文件上传，双栏选择不串用。
- [x] 实现勾选、范围选择和键盘选择，文件栏工具图标提交至另一栏已成功打开的目录。
- [x] 加入后台 IPC 与真实队列快照；显示状态、进度、速度、错误和操作，提供并发选择及清理结束任务。
- [x] 同名冲突显式选择跳过/覆盖/保留两份；失败和取消任务可在原会话仍有效时重试。
- [x] 只刷新匹配的当前目标目录，忽略旧轮询结果；目录读取中完成的任务延后补刷。浏览器预览保持只读且不发起传输。
- [x] 运行前端测试、类型检查、生产构建和明暗/窄视口 Playwright 验收。

## 任务四：验证与交付

**文件：** `README.md`、`CHANGELOG.md`、本计划。

- [x] 运行 Rust 工作区、真实协议、格式、Clippy；Rust 验证与 Tauri 打包顺序执行。
- [x] 针对真实上传下载与取消运行 C AddressSanitizer 协议回归。
- [x] 首次打包 `.app`，使用临时隔离服务实测原生上传/下载、冲突、取消/重试及断开；不使用真实账户。
- [x] 自查竞态、同名覆盖、路径、敏感数据和资源释放，记录真实验证范围并更新文档。

## 已取得的验证记录

2026-11-04，Apple Silicon macOS：

- 27 项默认 Rust 核心测试和应用/核心文档测试通过；真实协议测试默认 ignored，单独执行。
- 单独执行的 21 项真实协议测试、Rust 格式检查和工作区全目标 Clippy
  （`-D warnings`）通过；最终收尾时再次执行 Rust 工作区、协议、前端、
  类型、Playwright、生产构建、格式和 Clippy 检查，均通过。
- 21 项 C AddressSanitizer 真实协议测试通过，包括文件完整性、空文件、中文名、同名三策略、
  目标竞争、覆盖失败恢复、源变化、上传/下载取消、退出清理、并发上限和传输前主机变化校验。
  泄漏检测关闭，不宣称通过泄漏检测。
- 50 项前端测试、9 项 Playwright 测试和类型检查通过。目录加载与完成刷新重叠的问题
  先通过失败测试复现，再修正为读取结束后补刷；未提交路径不会被当作传输目的地。
- 已检查 1280、800、390 像素明暗截图中的文件选择、真实状态布局、进度、冲突弹窗和错误。
  Playwright 的 IPC 为受控替身，不能替代真实协议和原生应用验证。
- 最后一次目录刷新竞态修复后，生产前端和开发版 `.app` 均重新构建成功。
  最终前端资源为 `dist/assets/index-BhkLYg95.js`；应用产物为
  `target/debug/bundle/macos/FileWorker.app`，未进行 Developer ID 签名与公证，不用于对外发布。
- 最终安装包已退出重开并检查原生界面：本地目录正常读取、远程未连接、队列为空、
  并发恢复为 `3`，上传和下载在未连接时禁用，无错误提示。
  清空进程内队列是既定行为，不代表支持跨重启恢复。
- 原生 `.app` 使用原有隔离测试配置 `127.0.0.1:56458`，未保存凭据：双文件上传、
  下载、同名保留两份、64 MB 上传约 15 MB 后取消并从头重试均通过。
  取消后无最终文件或 `.part` 遗留；重试成功的 64 MB 文件、8 MB 文件及下载副本
  均通过 SHA-256 与生成的来源文件对比。已断开会话并停止本机测试服务。
- 定向代码自查覆盖会话失效、临时凭据、目标锁、网络错误、关闭和备份回滚；
  没有新增子代理调用，也没有 Git 提交或系统服务修改。
- 测试夹具显式设置 `reuse_address=True`，解决旧服务关闭后立即轮换主机密钥时的
  TIME_WAIT 端口复用失败，不修改操作系统网络配置。

### 本轮 C AddressSanitizer 产物

沿用第二阶段计划中的插桩构建命令，新增 `libc` 后本轮可执行文件为：
`target/c-asan/aarch64-apple-darwin/debug/deps/sftp_integration-512951684340ddbe`。
运行该可执行文件时设置 `ASAN_OPTIONS=detect_leaks=0`，并将 `DYLD_LIBRARY_PATH`
指向 `xcrun clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib` 所在目录；
实际运行 `--ignored --nocapture`，21 项通过。

### 未覆盖与限制

Finder 拖拽、目录递归、暂停、断点续传、自动重试、跨重启恢复、外部服务器、
Windows/Linux 原生包、断电恢复和服务器不遵守 SFTP 排他语义的情况未验收。
远程覆盖有备份改名间隙；异常备份与离线时无法清理的远程临时文件需人工检查。
本阶段只保证正常取消和可通信错误下的清理，不承诺强制终止进程后的自动恢复。
