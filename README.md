# Codex Switch

面向 Codex 的账号、连接配置和用量管理工具，基于 CC Switch 收敛而来。
技术栈为 Tauri 2、React、TypeScript 和 Rust。[English](docs/README_EN.md)。

- 首页提供可直接切换的 ChatGPT 账号、独立订阅额度和本地 Codex 用量视图。
- 设置集中管理连接配置、认证、本地路由、备份、同步与应用偏好。
- 登录账号无需新建连接配置，新增账号不会自动切换。铅笔编辑显示名称、备注、图标和颜色，保存后重启仍保留。
- “当前使用”随成功切换更新；默认账号收在高级选项中。API Key 与已有高级连接在设置中管理。

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
并检查包元数据及本地 ad-hoc 签名。不要单独使用预览配置，也不要将正在运行的
资料及凭据导入预览包。自定义目录可以指向预览资料之外的位置。

## 开发验证

```sh
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

开发约定见 [开发约定](docs/DEVELOPMENT.md)，配置行为见
[配置说明](docs/CONFIGURATION.md)，兼容边界见 [架构说明](docs/ARCHITECTURE.md)。

## 发布与来源

本分支尚无自动更新渠道。macOS 预览包是本地 ad-hoc 签名的 debug 应用，
未作公证发布。版本号及内部 `cc-switch` 标识为兼容现有数据而保留，不表示
本分支属于上游发行版。旧上游发布、下载镜像及赞助内容已移除。

项目源自 Jason Young 和其他贡献者维护的 CC Switch，保留原始版权与
[MIT 许可](LICENSE)。
