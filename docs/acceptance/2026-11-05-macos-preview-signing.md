# macOS 免费预发布签名修复验收 · 2026-11-05

## 原问题

用户通过 Chrome 下载 `v0.1.0-preview.2` 并解压后，Finder 首次启动提示应用
“已损坏，无法打开”。只读检查用户下载文件，ZIP CRC 通过，大小 5,314,202 字节，
SHA-256 与 GitHub 附件及原始发布 ZIP 一致：

```text
a5df11516402090bd12c528bebf51356e3264e08b607fee405eb156af4e8b1e1
```

下载应用的主程序、Info.plist 和图标与原构建一致，带 Chrome 下载隔离属性。
`codesign --verify --deep --strict` 和 `spctl` 均报告：

```text
code has no resources but signature indicates they must be present
```

`codesign -dv --verbose=4` 显示仅有 `adhoc,linker-signed`，
`Info.plist=not bound`、`Sealed Resources=none`，没有完整 `.app` 资源封装。
没有删除或修改用户下载副本，也没有移除隔离属性或改变系统安全策略。

## 修复与回归

Tauri 显式使用 `bundle.macOS.signingIdentity: "-"`，对程序及整个应用进行
ad-hoc 签名。先添加真实产物回归，旧包签名检查稳定失败；实现打包脚本后，
其余六项行为回归通过，而旧构建仍因相同签名问题失败。重新执行优化构建后，
完整七项回归通过：

- 优化构建应用具有有效资源封装，严格签名校验通过。
- 签名应用可生成 ZIP 和匹配的 SHA-256，解压后再次严格验证，输入应用内容未变。
- 删除资源签名或修改已签名图标时拒绝打包，不遗留输出。
- 已有发布目录不覆盖；不安全标签、基础版本不一致被拒绝。

独立复查补充三项回归：输出位于输入应用内、经符号链接进入输入应用、
打包开始后目标目录被其他任务创建。前两项在旧脚本上失败，修复后全部十项通过。
写入前检查真实路径包含关系，最终独占创建输出目录并以不覆盖的硬链接提交附件；
后置提交失败的回归实际进入 staging 清理路径，确认对方空目录 inode 未变，
输入应用仍通过签名校验，没有修改资源或遗留临时目录。
再次复查补充 APFS 大小写别名回归，先在字符串路径比较版本上失败，
改为解析符号链接后逐级比较目录的设备号与 inode；合计十一项全部通过。

测试使用独立 `target/macos-preview-test-*` 目录，结束钩子删除生成的应用副本、
压缩包、解压副本和标记文件。生产打包使用独立临时目录，验证成功后才移交输出。

## 新产物

`FileWorker-v0.1.0-preview.3-macos-arm64.app.zip`，5,241,185 字节：

```text
fbf2497094dd96d31b39e49e61cde98d65bcbc472b3e152cf4fda0c895932529
```

平台为 macOS `26.5.2`、Apple Silicon。应用内版本仍为 `0.1.0`，
最低系统 `12.0` 只是包元数据，不代表已在最低系统实测。
签名显示 `Identifier=com.fileworker.desktop`、`Signature=adhoc`、
`Info.plist entries=15`、`Sealed Resources version=2`。
优化应用与 ZIP 解压副本严格校验通过，归档完整性通过。

未进行 Developer ID 签名或公证，`spctl` 返回 `rejected`（退出码 `3`）。
这与修复前的资源封装错误不同，不能将其记录为 Gatekeeper 信任通过，
也不承诺用户下载后可以无提示直接运行。

## 本轮验证范围

- `11` 项 macOS 打包行为回归、`107` 项前端测试、`19` 项 Playwright 全部通过。
- `30` 项默认 Rust 测试通过；`21` 项真实协议与 `1` 项 Keychain 测试按默认规则跳过。
- TypeScript、Rust 格式检查、Clippy（`-D warnings`）、生产前端和优化 `.app` 构建通过。
- 原生启动本机构建的优化应用，主窗口及本地文件列表正常、远程未连接、队列为空，
  随后正常退出；没有连接服务器或操作凭据。这不是浏览器下载后的首次启动证据。
- 本轮不宣称重跑完整真实协议、Keychain、ASan、Finder 拖拽或跨平台验收。

## 下载后首次启动

- 浏览器下载：通过 Chrome 实际下载公开 `preview.3` ZIP，下载完成后大小为
  5,241,185 字节，SHA-256 与 GitHub 附件摘要及上文新产物一致。
- Finder 解压：在独立 `target/native-preview-signing-acceptance-*` 目录中，
  通过 Finder 打开 ZIP，由归档实用工具生成 `FileWorker.app`，未覆盖用户原有下载副本。
- 隔离属性：ZIP 与解压应用均保留 `com.apple.quarantine`，来源为 `Chrome`；
  未去除隔离标记，未改变系统安全策略。
- 下载应用校验：`codesign --verify --deep --strict --verbose=2` 返回 `valid on disk`、
  `satisfies its Designated Requirement`；应用标识、ad-hoc 签名、Info.plist 绑定与
  资源封装均符合上文。`spctl` 仍返回 `rejected`（退出码 `3`），不是信任通过。
- 首次启动：尚未双击运行新下载应用，等待用户在执行前明确确认。系统可能要求
  单独允许打开；如需系统授权或密码，由用户本人操作，不以本地构建启动替代。
- 清理：仅暂留上述独立下载验收目录供首次启动继续验收，完成后删除本轮目录。
  用户原有下载、应用及实际连接配置不属于清理对象。
