# Codex Switch

面向 Codex 的账号、连接配置和用量管理工具，基于 CC Switch 收敛而来。
技术栈为 Tauri 2、React、TypeScript 和 Rust。[English](docs/README_EN.md)。

- 首页分别管理订阅账号和 API Provider，两处各有独立的添加入口，另提供本地 Codex 用量视图。
- 设置集中管理全局认证策略、备份、同步与应用偏好。应用内网络代理配置已移除，网络请求遵循系统环境。
- OpenAI 订阅账号直接使用官方登录；DeepSeek API 使用官方原生 Responses 接口，填入 API Key 即可配置，模型和思考档位可自定义。应用不提供本地路由、自动故障转移或协议转换。
- 订阅账号直接登录、切换并查询各自额度，新增账号不会自动切换；编辑中管理显示信息、重新登录、默认账号和移除操作。
- API Provider 管理地址、API Key、模型和 API 余额。移除连接会清理其保存的配置和凭据；移除当前连接后保持未连接状态。
- “当前使用”只对应一个订阅账号或 API Provider，与默认账号独立。批量注销位于订阅账号列表下方。
- 额度、统计范围与设置说明通过标题旁的帮助图标查看，支持悬停、键盘聚焦和点击；本地用量中的费用标为估算费用。
- macOS 与 Windows 共用账号、连接配置、额度、用量及设置逻辑；托盘呈现、窗口装饰和快捷键按平台适配。

## 从源码运行

使用 [.node-version](.node-version) 指定的 Node、pnpm 10.12.3，以及
[rust-toolchain.toml](rust-toolchain.toml) 指定的 Rust。原生构建需要对应平台的
Tauri 开发依赖。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 使用常规应用资料，可以操作已有的 Codex 配置。需要隔离验证时，
在 macOS 构建本地预览包：

```sh
pnpm build:preview
open "src-tauri/target/debug/bundle/macos/Codex Switch Preview.app"
```

预览包默认使用 `~/.codex-switch-preview`，标识为 `com.codexswitch.preview`，
不注册外部 URL 协议。构建脚本同时启用前端标记、原生 feature 和预览配置，
macOS 构建检查包元数据及本地 ad-hoc 签名。不要单独使用预览配置，也不要将正在运行的
资料及凭据导入预览包。自定义目录可以指向预览资料之外的位置。

正式版应用数据默认存入 `~/.codex-switch`；预览版定价文件直接存入
`~/.codex-switch-preview/model-pricing.json`。首次启动会备份并复制各自的旧默认
数据目录，保留旧数据，拒绝覆盖已有目标文件。迁移与自定义目录规则见
[配置说明](docs/CONFIGURATION.md)。

Token 统计的数据源独立于账号和配置目录。Usage 的自动扫描区域提供数据源配置，
选择包含 `sessions` 和 `archived_sessions` 的 Codex 根目录；预览版默认只读扫描
本机 `~/.codex`，统计结果仍存入预览数据库。普通版默认沿用 Codex 配置目录。
可自定义日志来源，留空恢复默认，保存后点击“立即同步”验证，无需重启。

## 开发验证

```sh
pnpm typecheck
pnpm test:unit
pnpm test:packaging
pnpm build:renderer
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

开发约定见 [开发约定](docs/DEVELOPMENT.md)，配置行为见
[配置说明](docs/CONFIGURATION.md)，兼容边界见 [架构说明](docs/ARCHITECTURE.md)。

## 打包与发布

macOS 与 Windows 都通过 GitHub Actions 云端构建，工作流和分发入口如下：

| 平台                | 工作流                                                                             | 产物与分发                                            |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| macOS Apple Silicon | **macOS Pre-release**：版本标签触发，或手动选择已有标签                            | DMG，创建草稿 Pre-release，审核发布后从 Releases 下载 |
| Windows x64         | **Windows Packages**：相关源码 PR 触发，或手动选择 `production`、`preview`、`both` | 按用户安装的 NSIS 安装包，从该次运行的 Artifacts 下载 |

已发布版本的安装包和说明见 [GitHub Releases](https://github.com/AmazingUmi/codex-switch/releases)。
当前 `0.0.3` 为 macOS Apple Silicon（arm64）测试版，配置最低系统版本为
macOS 12；未在 macOS 12 或 Intel Mac 实机验证。无 Apple 开发者证书时使用
ad-hoc 签名，未经过 Apple 公证，安装需要在系统“隐私与安全性”中允许打开。
本分支尚无自动更新渠道，更新时从 Releases 下载新版本。

Windows 构建同时输出来源清单、安装启动检查结果与 SHA-256 校验和，当前不自动发布
Release。Windows 包未签名，缺少 WebView2 时由安装器下载；真实登录、托盘交互及
高 DPI 效果仍需验收。本地打包使用 `pnpm build:windows`，预览版增加 `--preview`。

发布包使用 release 构建、独立标识 `com.codexswitch.desktop` 和
`codexswitch://` 深链接。预览包使用独立标识，不注册外部 URL 协议；
`pnpm build:preview` 在 macOS 生成本地 debug 应用，在 Windows 生成 release 安装包。
打包、校验和签名配置见 [发布流程](docs/RELEASING.md)。

项目源自 Jason Young 和其他贡献者维护的 CC Switch，保留原始版权与
[MIT 许可](LICENSE)。
