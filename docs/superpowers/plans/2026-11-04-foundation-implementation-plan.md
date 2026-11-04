# FileWorker 第一阶段实施计划

> **执行说明：** 使用 `superpowers:executing-plans` 在当前会话中逐项执行。
> 有独立任务需要委派时才使用 `superpowers:subagent-driven-development`；
> 不因工作流默认开启而创建子任务。下列复选框记录真实进度。

**目标：** 安装可管理的开发工具链，交付能启动、浏览真实本地目录并保存连接配置的 macOS 应用。

**架构：** Rust 核心库负责文件系统和配置存储，Tauri 只处理命令和应用路径。
React 负责连接管理和双栏界面，通过类型明确的命令访问核心库。
第一阶段不建立 SSH 连接，不收集密码，不模拟传输成功。

**技术栈：** Rust stable、Cargo workspace、Tauri 2、React、TypeScript、Vite、
pnpm、Vitest、Testing Library、Playwright。

**设计规范：** `docs/superpowers/specs/2026-11-03-sftp-client-design.md`

## 全局约束

- 第一版平台是 macOS；协议和传输模型为以后跨平台保留边界。
- 第一版只支持 SFTP；第一阶段只建立它所需的应用基础。
- 默认传输并发数为 `3`，传输队列在后续阶段接入。
- 最终支持密码和私钥认证；本阶段的配置文件不接受任何密码或私钥口令字段。
- 默认界面语言为中文。
- 不自动提交、推送、发布，不开启系统远程登录或修改系统服务。
- 不修改用户终端启动配置；启动脚本负责当前进程的工具路径。
- 当前目录尚未初始化 Git，直接在用户指定的空项目目录执行，不创建其他工作目录。
- 不把未实现、未验证的功能写成已完成能力。

## 阶段划分

总设计需要分阶段交付；本文件只详细计划第一阶段，避免一份计划同时承担所有子系统。

| 阶段 | 可独立验收的产物 | 对应规范 |
| --- | --- | --- |
| 第一阶段，本计划 | macOS 应用骨架、本地文件浏览、非敏感连接配置 | 第 3～6 节、第 8 节的基础工作区 |
| 第二阶段 | Keychain、主机指纹校验、SFTP 会话和远程目录浏览 | 第 2、4、7、9 节的认证和协议部分 |
| 第三阶段 | 上传下载、并发队列、暂停恢复、重试和冲突处理 | 第 5～7 节的传输部分 |
| 第四阶段 | Finder 原生拖入拖出、关闭窗口策略、打包验收 | 第 8～10 节的完整交互和发布验收 |

主机指纹校验必须先于真实认证和传输，不作为连接功能完成后的安全补丁。
远程文件拖到 Finder 需要原生文件承诺机制，不能把普通网页拖出事件当作验收通过。
最终阶段仍须分别验证 Finder 拖入、双栏拖拽、原生 Finder 拖出。

## 文件职责

```text
Cargo.toml                         Rust 工作区
rust-toolchain.toml                固定已验证的 Rust 工具链
.node-version                      固定 Node.js 版本
package.json                       前端和桌面开发命令
scripts/run.sh                     定位工具链并执行 pnpm 命令
crates/fileworker-core/
  src/lib.rs                       导出核心模块
  src/error.rs                     可识别的核心错误
  src/local.rs                     真实本地目录读取和条目排序
  src/profiles.rs                  配置校验和原子持久化
  tests/local.rs                   临时目录上的文件系统测试
  tests/profiles.rs                配置校验、损坏配置和读写测试
src-tauri/
  src/lib.rs                       桌面初始化和命令注册
  src/commands.rs                  阻塞工作隔离和错误序列化
  src/main.rs                      桌面入口
  tauri.conf.json                  窗口、构建、内容安全策略
  capabilities/default.json       主窗口最小权限
src/
  App.tsx                         窗口布局和工作区状态
  components/FilePane.tsx          本地或远程文件栏
  components/ProfileDialog.tsx     新建和编辑连接
  components/Sidebar.tsx           连接列表和本地常用目录
  lib/api.ts                      Tauri 命令适配，不在浏览器假造本地数据
  lib/types.ts                    前后端数据约定
  lib/files.ts                    排序、过滤、大小和日期显示
  styles.css                      紧凑、可扫描的桌面工具布局
tests/
  files.test.ts                   文件筛选和显示行为
  app.test.tsx                    表单及文件浏览的用户可见行为
  e2e/workspace.spec.ts            桌面和窄视口布局验证
README.md                         当前确实可用的能力和启动方法
CHANGELOG.md                      变更、兼容性和验证记录
```

## 任务 1：准备并验证工具链

**涉及位置：**

- 安装：`~/.cargo`、`~/.rustup`。
- 安装：`~/.local/share/nodejs/node-v24.22.2-darwin-arm64`。
- 创建：`.node-version`、`rust-toolchain.toml`、`scripts/run.sh`。
- 不修改：`~/.zshrc`、`~/.zprofile`。

**接口：**

- 输入：Apple Silicon macOS、已有 Command Line Tools、用户安装许可。
- 输出：`bash scripts/run.sh <pnpm 参数>` 能在当前项目运行 pnpm，不要求用户手动设置环境变量。

- [x] 验证架构、编译工具和现有安装，确认不会覆盖已有工具链。
- [x] 使用官方 rustup 安装 Rust，添加 `--no-modify-path`，安装 rustfmt 和 Clippy。
- [x] 从 Node.js 官方发布站下载 arm64 包，并比对 SHA-256。
- [x] 安装固定版本 pnpm；只在当前进程设置 Node 和 Cargo 的路径。
- [x] 记录并验证实际版本：

```bash
"$HOME/.cargo/bin/rustc" --version
"$HOME/.cargo/bin/cargo" --version
"$HOME/.local/share/nodejs/node-v24.22.2-darwin-arm64/bin/node" --version
bash scripts/run.sh --version
```

预期：均成功退出，Rust 版本与 `rust-toolchain.toml` 一致。

## 任务 2：测试驱动的本地目录核心

**文件：** 创建 `crates/fileworker-core/{Cargo.toml,src/lib.rs,src/error.rs,src/local.rs,tests/local.rs}`。

**接口：**

```rust
pub fn list_directory(path: &std::path::Path) -> Result<DirectoryListing, CoreError>;
pub struct DirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FileEntry>,
    pub warnings: Vec<String>,
}
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub hidden: bool,
}
```

- [x] 先写临时目录测试，捕获“返回伪造文件”“目录和文件混排”“错误被吞成空目录”的回归：

```rust
#[test]
fn directories_are_listed_before_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.txt"), b"hello").unwrap();
    std::fs::create_dir(root.path().join("Z-folder")).unwrap();
    let listing = fileworker_core::local::list_directory(root.path()).unwrap();
    assert_eq!(listing.entries[0].name, "Z-folder");
    assert_eq!(listing.entries[1].size, Some(5));
}
```

- [x] 运行 `cargo test -p fileworker-core --test local`，确认实现缺失时失败。
- [x] 使用 `read_dir`、`symlink_metadata` 和 `metadata` 读取实际目录，返回规范路径及父目录。
- [x] 对丢失、非目录路径返回错误；逐条读取失败保留警告，不伪装成完整成功。
- [x] 避免有损转换真实操作路径；非 UTF-8 名称返回跳过警告，不能用替代字符指向另一个文件。
- [x] 补充隐藏文件、符号链接、空目录、不存在目录和文件路径测试，再运行同一测试命令。

macOS 文件系统拒绝创建非 UTF-8 文件名，因此该文件系统夹具测试仅在其他 Unix 平台启用；
本机没有把该分支记作执行通过。

## 任务 3：不含凭据的连接配置

**文件：** 创建 `crates/fileworker-core/src/profiles.rs`、`tests/profiles.rs`。

**接口：**

```rust
pub enum AuthMethod { Password, PrivateKey }
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    pub remote_path: String,
}
pub struct ProfileStore { root: std::path::PathBuf }
impl ProfileStore {
    pub fn new(root: std::path::PathBuf) -> Self;
    pub fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError>;
    pub fn save(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, CoreError>;
    pub fn delete(&self, id: &str) -> Result<(), CoreError>;
}
```

- [x] 先写实际临时文件系统测试，捕获“同一 ID 重复新增”“删除未落盘”“保存导致明文密码进入配置”等回归：

```rust
#[test]
fn secret_fields_are_rejected_on_input() {
    let json = r#"{
      "id":"bde98cf0-154f-47c6-a967-f32565776efe",
      "name":"测试","host":"localhost","port":22,"username":"tester",
      "authMethod":"password","privateKeyPath":null,"remotePath":".",
      "password":"must-not-be-persisted"
    }"#;
    assert!(serde_json::from_str::<ConnectionProfile>(json).is_err());
}
```

- [x] 运行 `cargo test -p fileworker-core --test profiles`，记录实现前失败。
- [x] 配置模型使用 `serde(deny_unknown_fields)`，校验 UUID、名称、主机、非零端口和用户名，私钥方式要求私钥路径。
- [x] 存储结构使用 `{ "version": 1, "profiles": [...] }`，未来不认识的版本和损坏 JSON 均报错，禁止静默覆盖。
- [x] 写入同目录临时文件，刷新后原子替换；新建配置目录使用 `0700`、配置文件使用 `0600`。
- [x] 通过保存、更新、重启读取、复制后独立 ID、删除、损坏文件保护和 Unix 权限测试。
- [x] 补充先失败后通过的配置事务锁测试，锁定完整读改写过程而非仅锁定最后写入。

## 任务 4：桌面命令桥接

**文件：** 创建 `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,src/main.rs,src/lib.rs,src/commands.rs}`。

**接口：**

```text
get_environment() -> { homePath, shortcuts: [{ name, path }] }
list_local_directory(path: string | null) -> DirectoryListing
list_profiles() -> ConnectionProfile[]
save_profile(profile: ConnectionProfile) -> ConnectionProfile
delete_profile(id: string) -> void
```

所有结构统一使用 JSON camelCase。错误统一为 `{ code: string, message: string }`。
核心存储根目录通过 Tauri `app_data_dir()` 传入；读目录通过 `spawn_blocking` 执行。

- [x] 声明并运行前后端约定测试：错误不得被变成空列表，输入密码字段必须被拒绝。
- [x] 命令注册只包含上述能力，文件对话框仅授予主窗口所需权限。
- [x] 配置互斥保护，串行化同一进程内的更新和删除，防止并发写入丢失。
- [x] 配置本地生产内容安全策略，不加载远程页面，不提供任意 shell 命令能力。
- [x] 运行 `cargo check --workspace`，确认核心库与桌面入口同时通过编译。

## 任务 5：双栏界面和配置管理

**文件：** 创建 `src/` 下上述组件、`index.html`、Vite/TypeScript/Vitest 配置及前端测试。

**接口：**

- `api.ts` 与任务 4 的命令名和数据结构逐字对应。
- `FilePane` 消费 `DirectoryListing`，通过回调通知目录切换。
- `ProfileDialog` 消费 `ConnectionProfile | null`，提交不含密码的配置。
- 本阶段远程文件栏为明确的未连接状态，不填充示例服务器或虚假文件。

- [x] 先写前端行为测试，捕获“筛选时显示隐藏文件”“排序改变后目录被放到文件后面”“错误出现后仍展示旧路径”的回归。

```typescript
it("隐藏文件默认不出现在可见列表中", () => {
  const entries = [
    { name: ".env", path: "/work/.env", isDir: false, isSymlink: false, size: 1, modifiedMs: null, hidden: true },
    { name: "notes.txt", path: "/work/notes.txt", isDir: false, isSymlink: false, size: 5, modifiedMs: null, hidden: false },
  ];
  expect(visibleEntries(entries, "", false, "name", "asc").map((e) => e.name))
    .toEqual(["notes.txt"]);
});
```

- [x] 运行 `pnpm test`，先观察实现缺失对应的失败。
- [x] 实现本地路径输入、返回上级、刷新、隐藏文件切换、目录双击和名称/大小/修改时间排序。
- [x] 实现新建、编辑、复制、删除连接；删除有确认；私钥路径可以通过原生文件选择器选择。
- [x] 请求使用递增序号忽略过期结果；切换路径后清理旧选择，错误不清空用户输入。
- [x] 对话框提供关联标签、焦点管理、Escape 关闭及表单错误。
- [x] 浏览器预览不访问桌面文件系统；显示预览状态，对原生操作返回明确错误。
- [x] 文件栏、侧栏、底部队列均为工具布局，不使用营销式首页，不使用装饰性嵌套卡片。
- [x] 图标使用 Lucide；图标按钮提供可访问名称及悬停提示；窄视口允许切换本地/远程文件栏。
- [x] 运行 `pnpm test`、`pnpm typecheck` 和 `pnpm build`。

## 任务 6：验证、文档和本阶段交付

**文件：** 创建 `README.md`、`CHANGELOG.md`、`tests/e2e/workspace.spec.ts`、
`playwright.config.ts`、应用图标源文件及生成的图标。

- [x] 运行：

```bash
bash scripts/run.sh test
bash scripts/run.sh typecheck
bash scripts/run.sh build
bash scripts/run.sh test:e2e
"$HOME/.cargo/bin/cargo" test -p fileworker-core
"$HOME/.cargo/bin/cargo" check --workspace
"$HOME/.cargo/bin/cargo" fmt --all -- --check
"$HOME/.cargo/bin/cargo" clippy --workspace --all-targets -- -D warnings
bash scripts/run.sh tauri build --debug --bundles app
```

- [x] 启动本地预览服务器，不占用已有监听端口；记录实际 URL。
- [x] 使用 Playwright 检查桌面和窄视口：首屏、弹窗、保存/编辑/删除、无横向溢出和浏览器控制台错误。
- [x] 启动真实 macOS 应用，检查真实目录浏览和配置读写，不以浏览器截图代替桌面能力验证。
- [x] README 区分“当前可用”和“尚未实现”，列出工具链位置、启动方式、配置位置和测试命令。
- [x] CHANGELOG 记录本阶段范围、无凭据迁移影响和实际验证结果。
- [x] 核对本计划的已完成项；未实测的 Finder 拖拽、Keychain、SFTP、队列等不得标记通过。

### 实际验收记录（2026-11-04）

- Rust 核心测试：17 项通过，本地目录 7 项、连接配置 10 项。
- 前端测试：19 项通过，包含配置损坏、延迟初始化、筛选后键盘入口和忙碌弹窗焦点回归。
- Playwright：3 项通过；检查 1280×820、800×580、390×844 视口及连接配置完整管理流程。
- TypeScript、生产构建、Rust 工作区编译、rustfmt、Clippy 均通过。
- 已重新构建 `target/debug/bundle/macos/FileWorker.app`，约 31.63 MiB。
- 原生应用已实测项目目录浏览、配置保存、退出重开后的持久化；临时测试配置已清理。
  最新构建再次打开，确认真实目录内容和空连接列表正常。
- 本地界面预览：`http://127.0.0.1:1430`，与桌面开发端口 1420 分开。
- 定向复查确认跨实例配置锁、弹窗焦点、初始化竞态、损坏预览数据、筛选键盘入口五项问题已修复。
- 本阶段无真实 SSH/SFTP、密码存储或传输；未验证 Finder 拖拽、Windows 和 Linux。

## 自检记录

- 规范覆盖：第一阶段只覆盖基础界面、本地目录和非敏感配置；其余已逐项分配到第二至第四阶段。
- 安全顺序：把主机校验安排在真实认证之前；第一阶段无 SSH、无密码收集和网络传输。
- 数据一致性：核心库、Tauri 命令和 TypeScript 数据字段统一为 camelCase。
- 路径边界：本地用操作系统路径；远程 POSIX 路径不借用本地路径规范化逻辑。
- 测试边界：真实磁盘测试存储和目录；前端测试只替换 Tauri IPC 边界，不伪造内部组件。
- 授权边界：工具链安装已获许可；不自动改终端配置、提交代码或开启 SSH 服务。
