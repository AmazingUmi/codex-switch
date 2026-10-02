//! 供应商余额查询服务
//!
//! 支持 DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita AI 的账户余额查询。
//! 返回 UsageResult 格式，与现有用量系统无缝对接。
//!
//! 错误通道语义（与 coding_plan / subscription 两个服务保持一致）：
//! - `Err(String)` = 瞬时传输失败（网络不可达/超时/读体中断）。前端 invoke reject，
//!   react-query 触发 retry 并保留上一次成功的 data（天然 keep-last-good）。
//! - `Ok(success:false)` = 确定性失败（空 key/未知供应商/鉴权/非 2xx/响应体非法 JSON），
//!   立即透出错误文案。判定按 reqwest 错误种类在折叠点完成，不依赖错误文案匹配。

use crate::provider::{UsageData, UsageResult};
use std::time::Duration;

// ── 供应商检测 ──────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BalanceProvider {
    DeepSeek,
    StepFun,
    SiliconFlow,
    SiliconFlowEn,
    OpenRouter,
    NovitaAI,
}

fn detect_provider(base_url: &str) -> Option<BalanceProvider> {
    // Reject even empty userinfo ("https://@host"), which URL normalization drops.
    let authority = base_url
        .trim()
        .split_once("://")?
        .1
        .split(['/', '?', '#'])
        .next()?;
    if authority.contains('@') {
        return None;
    }
    let url = url::Url::parse(base_url.trim()).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    match url.host_str()? {
        "api.deepseek.com" => Some(BalanceProvider::DeepSeek),
        "api.stepfun.ai" | "api.stepfun.com" => Some(BalanceProvider::StepFun),
        "api.siliconflow.cn" => Some(BalanceProvider::SiliconFlow),
        "api.siliconflow.com" => Some(BalanceProvider::SiliconFlowEn),
        "openrouter.ai" => Some(BalanceProvider::OpenRouter),
        "api.novita.ai" => Some(BalanceProvider::NovitaAI),
        _ => None,
    }
}

fn make_error(msg: String) -> UsageResult {
    UsageResult {
        success: false,
        data: None,
        error: Some(msg),
    }
}

fn make_auth_error(status: reqwest::StatusCode) -> UsageResult {
    UsageResult {
        success: false,
        data: Some(vec![UsageData {
            plan_name: None,
            remaining: None,
            total: None,
            used: None,
            unit: None,
            is_valid: Some(false),
            invalid_message: Some(format!("Authentication failed (HTTP {status})")),
            extra: None,
        }]),
        error: Some(format!("Authentication failed (HTTP {status})")),
    }
}

// ── DeepSeek ────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance
// Response: { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }], is_available }

async fn query_deepseek(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::http_client::get();

    let resp = client
        .get("https://api.deepseek.com/user/balance")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Ok(make_error(format!("API error (HTTP {status}): {body}")));
    }

    // 先 bytes() 再解析：读体失败（超时/连接中断）是瞬时 → Err；拿到完整响应体
    // 后解析失败才是确定性。reqwest 的 json() 把读体错误也包成 decode，无法区分。
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    Ok(parse_balance_response(BalanceProvider::DeepSeek, &body))
}

// ── StepFun ─────────────────────────────────────────────────
// GET https://api.stepfun.com/v1/accounts
// Response: { object, type, balance, total_cash_balance, total_voucher_balance }

async fn query_stepfun(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::http_client::get();

    let resp = client
        .get("https://api.stepfun.com/v1/accounts")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Ok(make_error(format!("API error (HTTP {status}): {body}")));
    }

    // 先 bytes() 再解析：读体失败（超时/连接中断）是瞬时 → Err；拿到完整响应体
    // 后解析失败才是确定性。reqwest 的 json() 把读体错误也包成 decode，无法区分。
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    Ok(parse_balance_response(BalanceProvider::StepFun, &body))
}

// ── SiliconFlow ─────────────────────────────────────────────
// GET https://api.siliconflow.cn/v1/user/info (or .com for EN)
// Response: { code, data: { balance, chargeBalance, totalBalance, status } }

async fn query_siliconflow(api_key: &str, is_cn: bool) -> Result<UsageResult, String> {
    let client = crate::http_client::get();

    let domain = if is_cn {
        "api.siliconflow.cn"
    } else {
        "api.siliconflow.com"
    };
    let url = format!("https://{domain}/v1/user/info");

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Ok(make_error(format!("API error (HTTP {status}): {body}")));
    }

    // 先 bytes() 再解析：读体失败（超时/连接中断）是瞬时 → Err；拿到完整响应体
    // 后解析失败才是确定性。reqwest 的 json() 把读体错误也包成 decode，无法区分。
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    Ok(parse_balance_response(
        if is_cn {
            BalanceProvider::SiliconFlow
        } else {
            BalanceProvider::SiliconFlowEn
        },
        &body,
    ))
}

// ── OpenRouter ──────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/credits
// Response: { data: { total_credits, total_usage } }

async fn query_openrouter(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::http_client::get();

    let resp = client
        .get("https://openrouter.ai/api/v1/credits")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Ok(make_error(format!("API error (HTTP {status}): {body}")));
    }

    // 先 bytes() 再解析：读体失败（超时/连接中断）是瞬时 → Err；拿到完整响应体
    // 后解析失败才是确定性。reqwest 的 json() 把读体错误也包成 decode，无法区分。
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    Ok(parse_balance_response(BalanceProvider::OpenRouter, &body))
}

// ── Novita AI ───────────────────────────────────────────────
// GET https://api.novita.ai/openapi/v1/billing/balance/detail
// Response: { availableBalance, cashBalance, creditLimit, outstandingInvoices }
// 金额单位：0.0001 USD

async fn query_novita(api_key: &str) -> Result<UsageResult, String> {
    let client = crate::http_client::get();

    let resp = client
        .get("https://api.novita.ai/openapi/v1/billing/balance/detail")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Err(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(make_auth_error(status));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Ok(make_error(format!("API error (HTTP {status}): {body}")));
    }

    // 先 bytes() 再解析：读体失败（超时/连接中断）是瞬时 → Err；拿到完整响应体
    // 后解析失败才是确定性。reqwest 的 json() 把读体错误也包成 decode，无法区分。
    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(format!("Failed to read response: {e}")),
    };
    let body: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Ok(make_error(format!("Failed to parse response: {e}"))),
    };

    Ok(parse_balance_response(BalanceProvider::NovitaAI, &body))
}

// ── 工具函数 ────────────────────────────────────────────────

/// Required amounts must be present and finite; an absent/invalid amount is never zero.
fn require_amount(obj: &serde_json::Value, field: &str) -> Result<f64, String> {
    obj.get(field)
        .and_then(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|number| number.trim().parse::<f64>().ok())
            })
        })
        .filter(|amount| amount.is_finite())
        .ok_or_else(|| format!("Missing or invalid '{field}' in balance response"))
}

fn balance_data(plan: &str, currency: &str, amount: f64, available: bool) -> UsageData {
    UsageData {
        plan_name: Some(plan.to_string()),
        remaining: Some(amount),
        total: None,
        used: None,
        unit: Some(currency.to_string()),
        is_valid: Some(available),
        invalid_message: (!available).then(|| "Insufficient balance".to_string()),
        extra: None,
    }
}

fn parse_balance_response(provider: BalanceProvider, body: &serde_json::Value) -> UsageResult {
    match parse_balance_data(provider, body) {
        Ok(data) => UsageResult {
            success: true,
            data: Some(data),
            error: None,
        },
        Err(error) => make_error(error),
    }
}

fn parse_balance_data(
    provider: BalanceProvider,
    body: &serde_json::Value,
) -> Result<Vec<UsageData>, String> {
    match provider {
        BalanceProvider::DeepSeek => {
            // https://api-docs.deepseek.com/api/get-user-balance/
            let available = body
                .get("is_available")
                .and_then(|value| value.as_bool())
                .ok_or_else(|| {
                    "Missing or invalid 'is_available' in balance response".to_string()
                })?;
            let infos = body
                .get("balance_infos")
                .and_then(|value| value.as_array())
                .filter(|infos| !infos.is_empty())
                .ok_or_else(|| {
                    "Missing or empty 'balance_infos' in balance response".to_string()
                })?;
            infos
                .iter()
                .map(|info| {
                    let currency = info
                        .get("currency")
                        .and_then(|value| value.as_str())
                        .filter(|currency| matches!(*currency, "CNY" | "USD"))
                        .ok_or_else(|| {
                            "Missing or invalid 'currency' in balance response".to_string()
                        })?;
                    let amount = require_amount(info, "total_balance")?;
                    // Availability is independent of the reported amount; preserve both currencies.
                    Ok(balance_data(currency, currency, amount, available))
                })
                .collect()
        }
        BalanceProvider::StepFun => {
            let amount = require_amount(body, "balance")?;
            Ok(vec![balance_data("StepFun", "CNY", amount, true)])
        }
        BalanceProvider::SiliconFlow | BalanceProvider::SiliconFlowEn => {
            // The documented response envelope uses code=20000 and status=true.
            // If supplied, a failure envelope must not be interpreted as a valid balance.
            if body
                .get("code")
                .is_some_and(|code| code.as_u64() != Some(20000))
                || body
                    .get("status")
                    .is_some_and(|status| status.as_bool() != Some(true))
            {
                return Err("Unsuccessful SiliconFlow balance response".to_string());
            }
            let data = body
                .get("data")
                .filter(|data| data.is_object())
                .ok_or_else(|| "Missing or invalid 'data' in balance response".to_string())?;
            let amount = require_amount(data, "totalBalance")?;
            let (plan, currency) = if provider == BalanceProvider::SiliconFlow {
                ("SiliconFlow", "CNY")
            } else {
                ("SiliconFlow (EN)", "USD")
            };
            Ok(vec![balance_data(plan, currency, amount, true)])
        }
        BalanceProvider::OpenRouter => {
            // https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
            // This account-wide endpoint requires a management key, unlike /key spending caps.
            let data = body
                .get("data")
                .filter(|data| data.is_object())
                .ok_or_else(|| "Missing or invalid 'data' in balance response".to_string())?;
            let total = require_amount(data, "total_credits")?;
            let used = require_amount(data, "total_usage")?;
            let remaining = total - used;
            if !remaining.is_finite() {
                return Err("Invalid remaining amount in balance response".to_string());
            }
            let mut amount = balance_data("OpenRouter", "USD", remaining, remaining > 0.0);
            amount.total = Some(total);
            amount.used = Some(used);
            amount.invalid_message = (remaining <= 0.0).then(|| "No credits remaining".to_string());
            Ok(vec![amount])
        }
        BalanceProvider::NovitaAI => {
            // https://docs.novita.ai/api-reference/basic-get-user-balance
            // Novita amounts are in 0.0001 USD; preserve sub-cent values in the wire format.
            let remaining = require_amount(body, "availableBalance")? / 10000.0;
            let mut amount = balance_data("Novita AI", "USD", remaining, remaining > 0.0);
            amount.invalid_message = (remaining <= 0.0).then(|| "No balance remaining".to_string());
            Ok(vec![amount])
        }
    }
}

// ── 公开入口 ────────────────────────────────────────────────

/// 查询余额。瞬时传输失败返回 `Err`（前端 reject → retry + 保留上次成功值），
/// 确定性失败返回 `Ok(success:false)`（见模块级文档）。
pub async fn get_balance(base_url: &str, api_key: &str) -> Result<UsageResult, String> {
    if api_key.trim().is_empty() {
        return Ok(UsageResult {
            success: false,
            data: None,
            error: Some("API key is empty".to_string()),
        });
    }

    let provider = match detect_provider(base_url) {
        Some(p) => p,
        None => {
            return Ok(UsageResult {
                success: false,
                data: None,
                error: Some("Unknown balance provider".to_string()),
            })
        }
    };

    match provider {
        BalanceProvider::DeepSeek => query_deepseek(api_key).await,
        BalanceProvider::StepFun => query_stepfun(api_key).await,
        BalanceProvider::SiliconFlow => query_siliconflow(api_key, true).await,
        BalanceProvider::SiliconFlowEn => query_siliconflow(api_key, false).await,
        BalanceProvider::OpenRouter => query_openrouter(api_key).await,
        BalanceProvider::NovitaAI => query_novita(api_key).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(provider: BalanceProvider, amount: serde_json::Value) -> serde_json::Value {
        match provider {
            BalanceProvider::DeepSeek => json!({
                "is_available": true,
                "balance_infos": [{"currency": "CNY", "total_balance": amount}]
            }),
            BalanceProvider::StepFun => json!({"balance": amount}),
            BalanceProvider::SiliconFlow | BalanceProvider::SiliconFlowEn => {
                json!({"code": 20000, "status": true, "data": {"totalBalance": amount}})
            }
            BalanceProvider::OpenRouter => {
                json!({"data": {"total_credits": amount, "total_usage": 0}})
            }
            BalanceProvider::NovitaAI => json!({"availableBalance": amount}),
        }
    }

    const PROVIDERS: [BalanceProvider; 6] = [
        BalanceProvider::DeepSeek,
        BalanceProvider::StepFun,
        BalanceProvider::SiliconFlow,
        BalanceProvider::SiliconFlowEn,
        BalanceProvider::OpenRouter,
        BalanceProvider::NovitaAI,
    ];

    #[test]
    fn detects_only_exact_supported_https_origins() {
        for (host, provider) in [
            ("api.deepseek.com", BalanceProvider::DeepSeek),
            ("api.stepfun.ai", BalanceProvider::StepFun),
            ("api.stepfun.com", BalanceProvider::StepFun),
            ("api.siliconflow.cn", BalanceProvider::SiliconFlow),
            ("api.siliconflow.com", BalanceProvider::SiliconFlowEn),
            ("openrouter.ai", BalanceProvider::OpenRouter),
            ("api.novita.ai", BalanceProvider::NovitaAI),
        ] {
            assert_eq!(
                detect_provider(&format!("https://{host}/v1")),
                Some(provider)
            );
            assert_eq!(
                detect_provider(&format!("https://{host}:443/api")),
                Some(provider)
            );
            assert_eq!(detect_provider(&format!("http://{host}/v1")), None);
            assert_eq!(detect_provider(&format!("https://{host}:8443/v1")), None);
            assert_eq!(
                detect_provider(&format!("https://{host}.example.test/v1")),
                None
            );
            assert_eq!(
                detect_provider(&format!("https://user:secret@{host}/v1")),
                None
            );
            assert_eq!(detect_provider(&format!("https://@{host}/v1")), None);
            assert_eq!(
                detect_provider(&format!("https://{host}@example.test/v1")),
                None
            );
            assert_eq!(
                detect_provider(&format!("https://example.test/{host}")),
                None
            );
            assert_eq!(
                detect_provider(&format!("https://example.test/?host={host}")),
                None
            );
        }
        assert_eq!(
            detect_provider(" HTTPS://API.DEEPSEEK.COM/v1 "),
            Some(BalanceProvider::DeepSeek)
        );
        assert_eq!(detect_provider("not a URL"), None);
        assert_eq!(
            detect_provider("https://localhost:443/api.deepseek.com"),
            None
        );
    }

    #[test]
    fn all_supported_parsers_preserve_real_zero_and_numeric_strings() {
        for provider in PROVIDERS {
            for amount in [json!(0), json!("0.0000")] {
                let result = parse_balance_response(provider, &fixture(provider, amount));
                assert!(result.success, "{provider:?}: {:?}", result.error);
                let data = result.data.unwrap();
                assert_eq!(data.len(), 1);
                assert_eq!(data[0].remaining, Some(0.0));
            }
            let result = parse_balance_response(provider, &fixture(provider, json!("12.3456")));
            assert!(result.success, "{provider:?}: {:?}", result.error);
            assert!(result.data.unwrap()[0].remaining.unwrap().is_finite());
        }
    }

    #[test]
    fn all_supported_parsers_reject_missing_invalid_and_nonfinite_amounts() {
        for provider in PROVIDERS {
            let result = parse_balance_response(provider, &json!({}));
            assert!(!result.success, "{provider:?}");
            assert!(result.data.is_none());
            for amount in [
                json!(null),
                json!(true),
                json!({}),
                json!(""),
                json!("bad"),
                json!("NaN"),
                json!("Infinity"),
                json!("-inf"),
                json!("1e999"),
            ] {
                let result = parse_balance_response(provider, &fixture(provider, amount));
                assert!(!result.success, "{provider:?}: {:?}", result.data);
                assert!(result.data.is_none());
                assert!(result.error.is_some());
            }
        }
    }

    #[test]
    fn deepseek_preserves_multiple_currencies_and_unavailable_balance() {
        let result = parse_balance_response(
            BalanceProvider::DeepSeek,
            &json!({
                "is_available": false,
                "balance_infos": [
                    {"currency": "CNY", "total_balance": "12.3456"},
                    {"currency": "USD", "total_balance": "0.0001"}
                ]
            }),
        );
        assert!(result.success);
        let data = result.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].unit.as_deref(), Some("CNY"));
        assert_eq!(data[0].remaining, Some(12.3456));
        assert_eq!(data[1].unit.as_deref(), Some("USD"));
        assert_eq!(data[1].remaining, Some(0.0001));
        assert!(data.iter().all(|item| item.is_valid == Some(false)));
    }

    #[test]
    fn deepseek_does_not_invent_currency_availability_or_empty_balance() {
        for body in [
            json!({"is_available": true, "balance_infos": []}),
            json!({"balance_infos": [{"currency":"CNY", "total_balance": "1"}]}),
            json!({"is_available": "true", "balance_infos": [{"currency":"CNY", "total_balance": "1"}]}),
            json!({"is_available": true, "balance_infos": [{"total_balance": "1"}]}),
            json!({"is_available": true, "balance_infos": [{"currency":"EUR", "total_balance": "1"}]}),
            json!({"is_available": true, "balance_infos": [{"currency":"", "total_balance": "1"}]}),
            json!({"is_available": true, "balance_infos": [{"currency":"CNY", "total_balance": "1"}, {"currency":"USD"}]}),
        ] {
            let result = parse_balance_response(BalanceProvider::DeepSeek, &body);
            assert!(!result.success, "{body}");
            assert!(result.data.is_none());
        }
    }

    #[test]
    fn siliconflow_region_sets_currency_and_failure_envelopes_are_not_zero() {
        for (provider, currency) in [
            (BalanceProvider::SiliconFlow, "CNY"),
            (BalanceProvider::SiliconFlowEn, "USD"),
        ] {
            let valid = fixture(provider, json!("88.88"));
            assert_eq!(
                parse_balance_response(provider, &valid).data.unwrap()[0]
                    .unit
                    .as_deref(),
                Some(currency)
            );
            for body in [
                json!({"code": 40100, "data": {"totalBalance": "0"}}),
                json!({"status": false, "data": {"totalBalance": "0"}}),
                json!({"code": "20000", "data": {"totalBalance": "0"}}),
                json!({"data": {}}),
            ] {
                assert!(!parse_balance_response(provider, &body).success);
            }
        }
    }

    #[test]
    fn openrouter_requires_both_fields_and_preserves_total_used_and_debt() {
        let result = parse_balance_response(
            BalanceProvider::OpenRouter,
            &json!({"data": {"total_credits": "100.5", "total_usage": 25.75}}),
        );
        let data = result.data.unwrap();
        assert_eq!(data[0].remaining, Some(74.75));
        assert_eq!(data[0].total, Some(100.5));
        assert_eq!(data[0].used, Some(25.75));
        assert_eq!(data[0].unit.as_deref(), Some("USD"));
        for body in [
            json!({"data": {"total_credits": 100}}),
            json!({"data": {"total_usage": 10}}),
            json!({"data": {"total_credits": 1.7e308, "total_usage": -1.7e308}}),
            json!({"error": {"message": "Only management keys can perform this operation"}}),
        ] {
            assert!(!parse_balance_response(BalanceProvider::OpenRouter, &body).success);
        }
        let debt = parse_balance_response(
            BalanceProvider::OpenRouter,
            &json!({"data": {"total_credits": 0, "total_usage": 2}}),
        );
        assert_eq!(debt.data.unwrap()[0].remaining, Some(-2.0));
    }

    #[test]
    fn novita_converts_tenthousandths_without_rounding_subcent_amounts() {
        let result = parse_balance_response(
            BalanceProvider::NovitaAI,
            &json!({"availableBalance": "123456"}),
        );
        assert_eq!(result.data.unwrap()[0].remaining, Some(12.3456));
        let result =
            parse_balance_response(BalanceProvider::NovitaAI, &json!({"availableBalance": 1}));
        assert_eq!(result.data.unwrap()[0].remaining, Some(0.0001));
    }

    #[tokio::test]
    async fn empty_keys_and_unsupported_urls_fail_without_network_requests() {
        assert!(
            !get_balance("https://api.deepseek.com", " ")
                .await
                .unwrap()
                .success
        );
        assert!(
            !get_balance(
                "https://unrelated.example/api.deepseek.com",
                "synthetic-test-key"
            )
            .await
            .unwrap()
            .success
        );
    }
}
