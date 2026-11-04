# 第二阶段：安全连接与远程浏览实施计划

> **执行工作流：** 使用 Superpowers 计划执行与测试驱动开发，按任务逐项验收。当前目录不是 Git 仓库，在原项目目录实施，不初始化仓库、不提交、不修改系统服务。

**目标：** 在现有中文双栏界面中，安全连接 SFTP 服务器并浏览远程目录。

**架构：** Rust 核心负责 SSH 握手、应用专用主机指纹库、认证和远程目录；Tauri 仅协调后台任务及原生凭据存储；React 负责信任确认、认证和导航。一个工作区只保留一个连接尝试和一个活动会话，过期响应不可覆盖新的用户操作。

**技术栈：** `ssh2` / libssh2、`sha2`、`base64`、`zeroize`；macOS 使用 `security-framework` 的通用密码接口，其他平台暂只允许临时凭据，不回退到明文。

**设计依据：** `docs/superpowers/specs/2026-11-03-sftp-client-design.md`，第一阶段计划中的第二阶段。

## 全局约束

- 仅实现 SFTP 连接与只读目录浏览；上传下载、队列与 Finder 拖拽属于后续阶段。
- 首次指纹必须明确确认，已信任主机的密钥变化必须阻止认证。
- 主机身份为规范化主机名与端口；指纹使用 SSH SHA-256 格式。
- 密码及私钥口令不写入 JSON、日志、浏览器存储，也不从 Rust 返回前端。
- Keychain 条目绑定配置标识、主机、端口、用户名、认证方式和私钥路径，避免修改配置后误用旧凭据。
- 明暗配色、配置版本 `1`、本地浏览与原生目录选择保持兼容。
- 网络操作只在后台线程运行；连接和网络读写有超时，待认证会话有有效期。
- 不开启 macOS 远程登录；协议测试使用临时 Python 环境和仅监听 `127.0.0.1` 的隔离 SFTP 服务。
- 不访问或修改用户已有 SSH 密钥、`known_hosts` 或非本应用 Keychain 条目。

## 任务一：主机信任与远程路径（已完成）

**文件：** 新增核心 `known_hosts.rs`、`remote_path.rs` 及对应测试，导出模块。

**接口：**
```rust
KnownHostStore::new(root: PathBuf) -> KnownHostStore
KnownHostStore::check(host: &str, port: u16, key: &HostIdentity) -> Result<bool, CoreError>
KnownHostStore::trust(host: &str, port: u16, key: &HostIdentity) -> Result<(), CoreError>
remote_path::resolve(base: &str, input: &str) -> Result<String, CoreError>
```

- [x] 先写测试：未知主机不落盘；明确确认后可重读；端口隔离；大小写主机规范化；密钥变化不可覆盖；损坏文件保留；并发信任不丢记录；Unix 权限。
- [x] 运行核心测试观察缺失功能失败，再实现版本化 JSON、文件事务锁和原子替换。
- [x] 路径测试使用手写期望：路径保留服务器 REALPATH 所需的 `..` 和符号链接语义；根目录无上级；反斜杠保持字面值；控制字符/空输入拒绝。
- [x] 运行核心测试通过。

## 任务二：SSH/SFTP 会话（已完成）

**文件：** 新增 `sftp.rs`、`credentials.rs`、协议集成测试和 Python 隔离服务。

**接口：**
```rust
SftpConnection::probe(
    profile: ConnectionProfile,
    timeout: Duration,
    register_socket: impl FnOnce(Arc<TcpStream>) -> Result<(), CoreError>,
) -> Result<SftpConnection, CoreError>
SftpConnection::authenticate(&mut self, secret: &str, home: &Path) -> Result<String, CoreError>
SftpConnection::list_directory(&self, path: &str) -> Result<DirectoryListing, CoreError>
credential_account(profile: &ConnectionProfile) -> String
```

- [x] 先写测试：凭据绑定在修改服务器、账户、方式、密钥后改变，改名和默认目录不改变绑定。
- [x] 增加依赖并运行失败测试，再实现凭据绑定和不泄露凭据的错误处理。
- [x] 集成测试验证密码与加密私钥、错误凭据、符号链接、隐藏文件、中文名、目录权限错误、断线和超时。
- [x] 实现先握手后认证的 SFTP 连接，SHA-256 指纹、目录逐项读取和 UTF-8 检查，不使用本地路径规则词法归一化远程路径。
- [x] 使用隔离服务器运行真实协议测试；11 项测试通过，重复服务器签名算法场景在 C AddressSanitizer 下通过。

## 任务三：应用会话与凭据（已完成）

**文件：** 新增核心 `connections.rs`、Tauri `remote.rs`、`credentials.rs`，修改 `commands.rs`、`lib.rs`、Cargo 清单。

**接口：** `probe_connection(profileId, attemptId)`、`trust_connection(attemptId)`、`authenticate_connection(attemptId, secret, remember)`、`cancel_connection(attemptId)`、`list_remote_directory(sessionId, path)`、`disconnect_session(sessionId)`、`forget_credential(profileId)`。

- [x] 测试连接状态：未确认指纹不得调用凭据读取或认证；过期或取消尝试不能认证；旧会话不能操作新会话；指纹变化不能通过确认覆盖。
- [x] 以随机标识绑定尝试和会话，待认证尝试两分钟过期；同一尝试串行认证，失败时关闭旧传输并重新握手，成功后移入活动会话。
- [x] 原生 Keychain 仅提供读取、写入和删除，不提供将密码返回前端的命令。只在认证成功且主动选择保存后写入，保存失败保留已连接会话并提示；按凭据身份协调保存/读取/删除，取消中的保存恢复旧值。
- [x] 使用 `spawn_blocking` 隔离网络和 Keychain；有限网络超时；取消、过期和断开时关闭对应套接字。
- [x] 检查所有 IPC 字段与 TypeScript 数据模型一致。

## 任务四：中文连接流程与远程文件栏（已完成）

**文件：** 新增 `useRemoteConnection.ts`、`ConnectionDialog.tsx`，修改 `types.ts`、`api.ts`、`App.tsx`、`FilePane.tsx`、样式和前端测试。

- [x] 先写界面失败测试：点击连接出现指纹而不是密码；确认后才出现认证表单；拒绝不继续；成功后远程列表可导航。
- [x] 增加主题一致的信任/认证弹窗、连接/取消/断开操作，以及可选的 Keychain 保存/使用/忘记操作。
- [x] 远程栏启用路径输入、返回上级、刷新、筛选、排序、隐藏文件和目录键盘导航。
- [x] 测试错误凭据与目录错误可见；过期、切换配置、取消和迟到响应不会串用会话；浏览器预览不发起 SSH 或保存密码。
- [x] 执行前端测试及桌面/窄视口截图检查，保持本地功能通过。

## 任务五：交付验收（已完成，范围为本阶段）

**文件：** `README.md`、`CHANGELOG.md`、本计划。

- [x] 按真实实现更新中文说明，明确已交付与尚未交付边界。
- [x] 执行 Rust 核心、真实协议集成、前端、Playwright、TypeScript、生产构建、rustfmt 和 Clippy。
- [x] 构建 `.app` 并实测原生密码连接、目录导航、权限错误返回、空路径刷新、符号链接与隐藏文件、断开操作；Keychain 原生读写仅使用随机测试条目且立即删除。
- [x] 定向复查主机校验顺序、凭据泄露、路径、并发、取消和资源释放；处理发现的问题后重新验证。

## 验收记录

2026-11-04，Apple Silicon macOS：

- Rust 工作区测试通过，包含 27 项默认核心测试和应用/核心文档测试；11 项隔离真实协议测试另行显式执行通过。
- 42 项前端测试、8 项 Playwright 测试、TypeScript、生产前端构建、rustfmt、Clippy 和 `.app` 构建通过。
- 原生密码认证与只读浏览通过，测试服务已断开并停止；没有使用真实账户或用户 SSH 密钥。
- 原生 Keychain 随机条目测试验证读取、保存、覆盖和幂等删除，结束后自动清理；未通过原生 UI 保存实际账户凭据。
- 原登记版 `libssh2-sys 0.3.3` 在重复服务端签名算法场景触发 C 堆越界；固定上游提交后，含该回归的 11 项协议测试在 C AddressSanitizer 下通过。
- 复查发现的过期清理、迟到保存、跨配置钥匙串阻塞、信任文件锁竞争、重试套接字清理、过期弹窗、目录错误与空路径导航问题，均有失败后转为通过的回归测试。
- 不支持多实例并发修改同一凭据；未验证外部服务器、Windows/Linux 原生包、文件传输或 Finder 拖拽。

### C AddressSanitizer 复验

以下方式对 C 依赖进行实际插桩，独立使用 `target/c-asan`。编译完成后使用输出中的
协议测试可执行文件路径运行，避免 Cargo 启动时丢失动态运行库搜索路径：

```bash
source "$HOME/.cargo/env"
ASAN_RUNTIME="$(xcrun clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib)"
CFLAGS='-fsanitize=address -fno-omit-frame-pointer -g' \
RUSTFLAGS="-C link-arg=$ASAN_RUNTIME -C force-frame-pointers=yes" \
MACOSX_DEPLOYMENT_TARGET=11.0 CARGO_TARGET_DIR=target/c-asan \
cargo test -p fileworker-core --target aarch64-apple-darwin --test sftp_integration --no-run
ASAN_OPTIONS=detect_leaks=0 DYLD_LIBRARY_PATH="$(dirname "$ASAN_RUNTIME")" \
target/c-asan/aarch64-apple-darwin/debug/deps/sftp_integration-4f091df4b97ed649 --ignored --nocapture
```

末行文件名是本轮实际产物，依赖或工具链变化后以 `--no-run` 的输出路径为准。
此验证覆盖越界访问，不宣称已通过泄漏检测。

## 本阶段边界

本计划完成的是安全 SFTP 连接和只读远程目录。上传、下载、队列调度、断点续传、
冲突处理、远程写操作、Finder 拖拽和退出时任务处理不属于本阶段，继续保留在后续
传输阶段。
