//! 原生供应商切换的金标测试。
//!
//! 锁定 MCP 与导入行的字节、客户端文件权限，以及 Codex 原生登录和凭据的安全红线。
//! 旧版 `PROXY_MANAGED` 只作为启动迁移识别的历史标记；不再产生本地路由或转换请求。
//!
//! 更新快照：`CODEX_SWITCH_UPDATE_GOLDEN=1 cargo test --test golden`，再逐个审 diff。
//! 快照变了就意味着行为变了，要能说清楚为什么。

#[allow(dead_code)]
#[path = "../support.rs"]
mod support;

mod claude_key_fields;
mod codex_red_lines;
mod file_modes;
mod import_rows;
mod mcp_bytes;
mod util;
