//! Session usage types and pricing, independent of request routing.

use serde::{Deserialize, Serialize};

pub mod calculator;

/// Session-log request id prefix; kept stable for persisted scanner history.
pub const SESSION_REQUEST_ID_PREFIX: &str = "session:";

/// Token 使用量统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_creation_tokens: u32,
    /// 会话日志中的实际模型名称（如果可用）
    pub model: Option<String>,
    /// 会话消息 ID（用于去重）
    ///
    /// Claude API: `msg_xxx`，与 session JSONL 中的 `message.id` 一致
    #[serde(skip)]
    pub message_id: Option<String>,
}
