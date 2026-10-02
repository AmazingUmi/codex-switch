use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::app_config::AppType;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use crate::config::get_home_dir;
use crate::config::read_json_file;
use crate::database::Database;
use crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID;
use crate::error::AppError;
use crate::live::engine::{lock_app, DeviceStore, LiveFile};
use crate::live::floor;
use crate::live::patch::json::{self as patch_json, ClearScope, JsonPatch};
use crate::live::patch::{KeyPath, LivePatch, LiveWriteError};
use crate::mode::operation::{self, FileChange};
use crate::mode::state::{self, PendingTarget};
use crate::provider::{ClaudeDesktopMode, Provider};

pub const PROFILE_ID: &str = "00000000-0000-4000-8000-000000157210";
pub const PROFILE_NAME: &str = "CC Switch";

#[cfg(any(target_os = "macos", windows, target_os = "linux", test))]
const CONFIG_FILE: &str = "claude_desktop_config.json";
#[cfg(any(target_os = "macos", windows, target_os = "linux", test))]
const CONFIG_LIBRARY_DIR: &str = "configLibrary";
const GATEWAY_TOKEN_SETTING_KEY: &str = "claude_desktop_gateway_token";

/// Claude Desktop 模型菜单识别的 route ID 前缀。
pub const CLAUDE_ROUTE_PREFIX: &str = "claude-";
/// 替代前缀（与前端 `ANTHROPIC_CLAUDE_ROUTE_PREFIX` 一致）。
pub const ANTHROPIC_CLAUDE_ROUTE_PREFIX: &str = "anthropic/claude-";
/// Claude Code env 中通过 `[1M]` 后缀声明 1M 上下文能力（匹配用 `eq_ignore_ascii_case`）。
/// Claude Desktop schema 不接受此后缀，import 边界翻译为 `supports1m` 字段。
pub const ONE_M_CONTEXT_MARKER: &str = "[1m]";

const CURRENT_OPUS_ROUTE_ID: &str = "claude-opus-5";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopDefaultRoute {
    pub route_id: &'static str,
    pub env_key: &'static str,
    #[serde(rename = "supports1m")]
    pub supports_1m: bool,
}

pub const DEFAULT_MODEL_ROLES: &[ClaudeDesktopDefaultRoute] = &[
    ClaudeDesktopDefaultRoute {
        route_id: "claude-sonnet-5",
        env_key: "ANTHROPIC_DEFAULT_SONNET_MODEL",
        supports_1m: true,
    },
    ClaudeDesktopDefaultRoute {
        route_id: CURRENT_OPUS_ROUTE_ID,
        env_key: "ANTHROPIC_DEFAULT_OPUS_MODEL",
        supports_1m: true,
    },
    ClaudeDesktopDefaultRoute {
        route_id: "claude-haiku-4-5",
        env_key: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        supports_1m: true,
    },
    // 保留历史模型角色顺序，用于读取和导入现有目录元数据。
    ClaudeDesktopDefaultRoute {
        route_id: "claude-fable-5",
        env_key: "ANTHROPIC_DEFAULT_FABLE_MODEL",
        supports_1m: true,
    },
];

#[derive(Debug, Clone)]
struct ClaudeDesktopPaths {
    normal_config_path: PathBuf,
    threep_config_path: PathBuf,
    config_library_path: PathBuf,
    profile_path: PathBuf,
    meta_path: PathBuf,
    /// 写前意图和首写备份所在的设备目录。
    device: DeviceStore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectGatewayCredentials {
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopStatus {
    pub supported: bool,
    pub configured: bool,
    pub applied_id: Option<String>,
    pub profile_path: Option<String>,
    pub config_library_path: Option<String>,
    pub mode: Option<ClaudeDesktopMode>,
    pub expected_base_url: Option<String>,
    pub actual_base_url: Option<String>,
    pub proxy_running: bool,
    pub stale_raw_models: bool,
    pub missing_route_mappings: bool,
    pub gateway_token_configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InferenceModelSpec {
    name: String,
    label_override: Option<String>,
    supports_1m: bool,
}

pub fn apply_provider(db: &Database, provider: &Provider) -> Result<(), AppError> {
    let paths = current_platform_paths()?;
    apply_provider_to_paths(db, provider, &paths)
}

pub fn get_status(db: &Database) -> Result<ClaudeDesktopStatus, AppError> {
    if !is_supported_platform() {
        return Ok(ClaudeDesktopStatus {
            supported: false,
            configured: false,
            applied_id: None,
            profile_path: None,
            config_library_path: None,
            mode: None,
            expected_base_url: None,
            actual_base_url: None,
            proxy_running: false,
            stale_raw_models: false,
            missing_route_mappings: false,
            gateway_token_configured: false,
        });
    }

    let paths = current_platform_paths()?;
    let applied_id = read_applied_id(&paths.meta_path);
    let profile = read_json_or_empty(&paths.profile_path).unwrap_or_else(|_| json!({}));
    // 切回官方后 profile 文件保留、只清关键字段，所以不能按文件在不在判断。
    let configured =
        meta_has_profile_entry(&paths.meta_path) || profile.get("inferenceProvider").is_some();
    let actual_base_url = profile
        .get("inferenceGatewayBaseUrl")
        .and_then(Value::as_str)
        .map(str::to_string);
    let stale_raw_models = profile
        .get("inferenceModels")
        .and_then(Value::as_array)
        .map(|models| {
            models.iter().any(|item| {
                item.as_str()
                    .or_else(|| item.get("name").and_then(Value::as_str))
                    .is_some_and(|model| !is_claude_safe_model_id(model))
            })
        })
        .unwrap_or(false);
    let gateway_token_configured = db
        .get_setting(GATEWAY_TOKEN_SETTING_KEY)
        .ok()
        .flatten()
        .is_some_and(|token| !token.trim().is_empty());
    let current_provider =
        crate::mode::current::direct_provider(db, &crate::app_config::AppType::ClaudeDesktop)
            .ok()
            .flatten();
    let mode = current_provider.as_ref().map(provider_mode);
    let expected_base_url = match mode {
        Some(ClaudeDesktopMode::Proxy) => None,
        Some(ClaudeDesktopMode::Direct) => current_provider
            .as_ref()
            .and_then(|provider| direct_gateway_credentials(provider).ok())
            .map(|credentials| credentials.base_url),
        None => None,
    };
    let missing_route_mappings = current_provider.as_ref().is_some_and(|provider| {
        matches!(provider_mode(provider), ClaudeDesktopMode::Proxy)
            && provider.meta.as_ref().is_none_or(|meta| {
                !meta
                    .claude_desktop_model_routes
                    .iter()
                    .any(|(id, route)| !id.trim().is_empty() && !route.model.trim().is_empty())
            })
    });

    Ok(ClaudeDesktopStatus {
        supported: true,
        configured,
        applied_id,
        profile_path: Some(paths.profile_path.display().to_string()),
        config_library_path: Some(paths.config_library_path.display().to_string()),
        mode,
        expected_base_url,
        actual_base_url,
        proxy_running: false,
        stale_raw_models,
        missing_route_mappings,
        gateway_token_configured,
    })
}

pub fn get_config_library_path() -> Result<PathBuf, AppError> {
    Ok(current_platform_paths()?.config_library_path)
}

pub fn default_model_roles() -> Vec<ClaudeDesktopDefaultRoute> {
    DEFAULT_MODEL_ROLES.to_vec()
}

pub fn is_compatible_direct_provider(provider: &Provider) -> bool {
    validate_direct_provider(provider).is_ok()
}

pub fn is_official_provider(provider: &Provider) -> bool {
    provider.id == CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID
}

pub fn provider_mode(provider: &Provider) -> ClaudeDesktopMode {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.claude_desktop_mode.clone())
        .unwrap_or(ClaudeDesktopMode::Direct)
}

pub fn is_claude_safe_model_id(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.contains(ONE_M_CONTEXT_MARKER) {
        return false;
    }

    let Some(route_tail) = normalized
        .strip_prefix(ANTHROPIC_CLAUDE_ROUTE_PREFIX)
        .or_else(|| normalized.strip_prefix(CLAUDE_ROUTE_PREFIX))
    else {
        return false;
    };

    // 角色前缀后必须还有实际模型标识，拒绝 claude-sonnet- 这类退化值
    // （否则会写入 profile 并触发 Claude Desktop fail-all 拒收整组）。
    // Claude Desktop 1.12603.1+ 的 fail-all validator 角色白名单已纳入 fable
    // （app.asar 内 ["sonnet","opus","haiku","fable","mythos"]），故 claude-fable-*
    // 可安全写入 profile。mythos 官方未公开发布，暂不暴露给用户。
    ["sonnet-", "opus-", "haiku-", "fable-"]
        .iter()
        .any(|prefix| {
            route_tail
                .strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        })
}

fn inference_model_json(spec: &InferenceModelSpec) -> Value {
    if spec.supports_1m || spec.label_override.is_some() {
        let mut item = json!({ "name": spec.name });
        if let Some(label_override) = spec.label_override.as_deref() {
            item["labelOverride"] = json!(label_override);
        }
        if spec.supports_1m {
            item["supports1m"] = json!(true);
        }
        item
    } else {
        Value::String(spec.name.clone())
    }
}

pub fn direct_gateway_credentials(
    provider: &Provider,
) -> Result<DirectGatewayCredentials, AppError> {
    let env = provider
        .settings_config
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AppError::localized(
                "claude_desktop.provider.env_missing",
                "Claude Desktop 直连供应商缺少 env 配置",
                "Claude Desktop direct provider is missing env configuration",
            )
        })?;

    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::localized(
                "claude_desktop.provider.base_url_missing",
                "Claude Desktop 直连供应商缺少 ANTHROPIC_BASE_URL",
                "Claude Desktop direct provider is missing ANTHROPIC_BASE_URL",
            )
        })?
        .to_string();

    let api_key = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::localized(
                "claude_desktop.provider.auth_token_missing",
                "Claude Desktop 直连供应商缺少 ANTHROPIC_AUTH_TOKEN（Bearer Token）",
                "Claude Desktop direct provider is missing ANTHROPIC_AUTH_TOKEN (Bearer Token)",
            )
        })?
        .to_string();

    Ok(DirectGatewayCredentials { base_url, api_key })
}

pub fn validate_direct_provider(provider: &Provider) -> Result<(), AppError> {
    if is_official_provider(provider) {
        return Ok(());
    }

    if !provider.settings_config.is_object() {
        return Err(AppError::localized(
            "claude_desktop.provider.settings_not_object",
            "Claude Desktop 直连供应商配置必须是 JSON 对象",
            "Claude Desktop direct provider configuration must be a JSON object",
        ));
    }

    if let Some(meta) = provider.meta.as_ref() {
        if let Some(api_format) = meta.api_format.as_deref() {
            if !api_format.trim().is_empty() && api_format != "anthropic" {
                return Err(AppError::localized(
                    "claude_desktop.provider.api_format_unsupported",
                    "Claude Desktop 直连只支持原生 Anthropic Messages API",
                    "Claude Desktop direct connections only support native Anthropic Messages API",
                ));
            }
        }

        if matches!(
            meta.claude_desktop_mode.as_ref(),
            Some(ClaudeDesktopMode::Proxy)
        ) {
            return Err(AppError::localized(
                "claude_desktop.provider.mode_unsupported",
                "该供应商是 Claude Desktop 本地路由模式，不能按直连模式写入",
                "This Claude Desktop provider uses proxy mode and cannot be written as direct mode",
            ));
        }

        if matches!(
            meta.provider_type.as_deref(),
            Some("github_copilot") | Some("codex_oauth") | Some("xai_oauth")
        ) {
            return Err(AppError::localized(
                "claude_desktop.provider.type_unsupported",
                "Claude Desktop 直连模式不支持需要本地代理转换的供应商",
                "Claude Desktop direct mode does not support providers that require local proxy conversion",
            ));
        }

        if meta.is_full_url == Some(true) {
            return Err(AppError::localized(
                "claude_desktop.provider.full_url_unsupported",
                "Claude Desktop 直连模式不支持完整 URL 端点配置",
                "Claude Desktop direct mode does not support full URL endpoint configuration",
            ));
        }
    }

    direct_inference_model_specs(provider)?;
    direct_gateway_credentials(provider)?;
    Ok(())
}

pub fn validate_provider(provider: &Provider) -> Result<(), AppError> {
    if matches!(provider_mode(provider), ClaudeDesktopMode::Proxy) {
        return Err(AppError::localized(
            "claude_desktop.provider.mode_unsupported",
            "Claude Desktop 本地路由已移除，存量路由配置不能启用",
            "Claude Desktop local routing has been removed; saved proxy configurations cannot be activated",
        ));
    }
    validate_direct_provider(provider)
}

fn direct_inference_model_specs(provider: &Provider) -> Result<Vec<InferenceModelSpec>, AppError> {
    let Some(routes) = provider
        .meta
        .as_ref()
        .map(|meta| &meta.claude_desktop_model_routes)
    else {
        return Ok(Vec::new());
    };

    let mut result = Vec::new();
    for (route_id, route) in routes {
        let supports_1m = route.supports_1m.unwrap_or(false);
        let route_id = route_id.trim();
        if route_id.is_empty() {
            continue;
        }
        if !is_claude_safe_model_id(route_id) {
            return Err(AppError::localized(
                "claude_desktop.provider.route_invalid",
                format!(
                    "Claude Desktop 直连模型必须使用 claude-* 或 anthropic/claude-* 名称: {route_id}"
                ),
                format!(
                    "Claude Desktop direct model must use a claude-* or anthropic/claude-* name: {route_id}"
                ),
            ));
        }
        let upstream_model = route.model.trim();
        if !upstream_model.is_empty() && upstream_model != route_id {
            return Err(AppError::localized(
                "claude_desktop.provider.direct_mapping_unsupported",
                format!("Claude Desktop 直连模式不能映射模型: {route_id} -> {upstream_model}"),
                format!(
                    "Claude Desktop direct mode cannot map models: {route_id} -> {upstream_model}"
                ),
            ));
        }
        result.push(InferenceModelSpec {
            name: route_id.to_string(),
            label_override: route
                .label_override
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            supports_1m,
        });
    }

    // Sort supports_1m=true first within each name so the subsequent dedup_by
    // (which keeps the first occurrence) preserves the 1M-capable variant.
    result.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| b.supports_1m.cmp(&a.supports_1m))
    });
    result.dedup_by(|a, b| a.name == b.name);
    Ok(result)
}

fn apply_provider_to_paths(
    _db: &Database,
    provider: &Provider,
    paths: &ClaudeDesktopPaths,
) -> Result<(), AppError> {
    validate_provider(provider)?;
    if is_official_provider(provider) {
        return restore_official_at_paths(paths);
    }

    let credentials = direct_gateway_credentials(provider)?;
    let model_specs = direct_inference_model_specs(provider)?;
    let profile = build_gateway_profile(
        &credentials.base_url,
        &credentials.api_key,
        (!model_specs.is_empty()).then_some(model_specs.as_slice()),
    );

    let deployment = deployment_mode_patch("3p");
    let profile = gateway_profile_patch(profile);
    let meta = MetaPatch { applied: true };
    write_desktop_files(
        paths,
        &[
            FileChange {
                file: LiveFile::shared(&paths.normal_config_path),
                patch: &deployment,
            },
            FileChange {
                file: LiveFile::shared(&paths.threep_config_path),
                patch: &deployment,
            },
            FileChange {
                file: LiveFile::private(&paths.profile_path),
                patch: &profile,
            },
            FileChange {
                file: LiveFile::shared(&paths.meta_path),
                patch: &meta,
            },
        ],
    )
}

/// 切回官方：两个配置文件改回 `1p`，清掉旧版写进 `enterpriseConfig` 的网关设置，
/// 把 CC Switch 的 profile 从 `_meta.json` 里摘掉。
///
/// profile 文件本身保留、只清关键字段：用户在 Desktop 里对这个 profile 改的设置
/// （#4774 的 auto 模式）下次切回第三方时还在，Key 也从磁盘上清掉了。Desktop 只按
/// `_meta.json` 的条目读 profile，摘掉条目后这个文件不会被列出。
fn restore_official_at_paths(paths: &ClaudeDesktopPaths) -> Result<(), AppError> {
    let normal = deployment_mode_patch("1p");
    let mut threep = deployment_mode_patch("1p");
    threep.remove = LEGACY_ENTERPRISE_GATEWAY_KEYS
        .iter()
        .map(|key| KeyPath::new(&["enterpriseConfig", key]))
        .collect();
    let threep = DropEmptyEnterpriseConfig(threep);
    let profile = JsonPatch {
        clear: vec![ClearScope {
            parent: KeyPath::root(),
            is_floor: floor::desktop_profile_floor,
        }],
        ..JsonPatch::default()
    };
    let meta = MetaPatch { applied: false };

    let mut changes = vec![
        FileChange {
            file: LiveFile::shared(&paths.normal_config_path),
            patch: &normal,
        },
        FileChange {
            file: LiveFile::shared(&paths.threep_config_path),
            patch: &threep,
        },
        FileChange {
            file: LiveFile::shared(&paths.meta_path),
            patch: &meta,
        },
    ];
    if paths.profile_path.exists() {
        changes.push(FileChange {
            file: LiveFile::private(&paths.profile_path),
            patch: &profile,
        });
    }
    write_desktop_files(paths, &changes)
}

/// Desktop 的几个文件作为一次操作写入：任何一个解析失败都不写；写到一半失败或崩溃，
/// 下次写入或启动时按写前意图补完。
fn write_desktop_files(
    paths: &ClaudeDesktopPaths,
    changes: &[FileChange<'_>],
) -> Result<(), AppError> {
    let guard = lock_app(AppType::ClaudeDesktop.as_str());
    operation::run(
        &paths.device,
        &guard,
        state::op::APPLY,
        changes,
        PendingTarget::default(),
        &|_| Ok(()),
    )?;
    Ok(())
}

fn deployment_mode_patch(mode: &str) -> JsonPatch {
    JsonPatch {
        set: vec![(KeyPath::new(&["deploymentMode"]), json!(mode))],
        ..JsonPatch::default()
    }
}

/// 旧版写进 `claude_desktop_config.json` 的 `enterpriseConfig` 的网关设置。
const LEGACY_ENTERPRISE_GATEWAY_KEYS: &[&str] = &[
    "disableDeploymentModeChooser",
    "inferenceGatewayApiKey",
    "inferenceGatewayAuthScheme",
    "inferenceGatewayBaseUrl",
    "inferenceProvider",
];

/// 清完旧网关设置后，`enterpriseConfig` 空了就整个删掉。
struct DropEmptyEnterpriseConfig(JsonPatch);

impl LivePatch for DropEmptyEnterpriseConfig {
    fn apply(&self, path: &Path, pre: Option<&[u8]>) -> Result<Vec<u8>, LiveWriteError> {
        let (mut doc, style) = patch_json::parse(path, pre)?;
        self.0.apply_to(path, &mut doc)?;
        if let Some(obj) = doc.as_object_mut() {
            if obj
                .get("enterpriseConfig")
                .and_then(Value::as_object)
                .is_some_and(|enterprise| enterprise.is_empty())
            {
                obj.shift_remove("enterpriseConfig");
            }
        }
        patch_json::serialize(path, &doc, &style)
    }
}

/// `build_gateway_profile` 的结果拆成补丁：关键字段替换，策略键缺失时才写。
fn gateway_profile_patch(profile: Value) -> JsonPatch {
    let mut patch = JsonPatch {
        clear: vec![ClearScope {
            parent: KeyPath::root(),
            is_floor: floor::desktop_profile_floor,
        }],
        ..JsonPatch::default()
    };
    if let Value::Object(fields) = profile {
        for (key, value) in fields {
            let key_path = KeyPath::new(&[&key]);
            if floor::DESKTOP_PROFILE_SEED.contains(&key.as_str()) {
                patch.seed.push((key_path, value));
            } else {
                patch.set.push((key_path, value));
            }
        }
    }
    patch
}

/// `configLibrary/_meta.json`：`entries` 里登记 CC Switch 的 profile，`appliedId`
/// 指向当前生效的那个。已有条目原位更新，不挪位置。
struct MetaPatch {
    applied: bool,
}

impl LivePatch for MetaPatch {
    fn apply(&self, path: &Path, pre: Option<&[u8]>) -> Result<Vec<u8>, LiveWriteError> {
        let (mut doc, style) = patch_json::parse(path, pre)?;
        let obj = doc.as_object_mut().expect("parse guarantees an object");
        let not_an_array = || LiveWriteError::Shape {
            path: path.to_path_buf(),
            key_path: KeyPath::new(&["entries"]),
            expected: "数组",
        };
        let is_ours = |entry: &Value| entry.get("id").and_then(Value::as_str) == Some(PROFILE_ID);

        if self.applied {
            let entries = obj
                .entry("entries")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(not_an_array)?;
            match entries.iter_mut().find(|entry| is_ours(entry)) {
                Some(Value::Object(entry)) => {
                    entry.insert("name".to_string(), json!(PROFILE_NAME));
                }
                _ => entries.push(json!({ "id": PROFILE_ID, "name": PROFILE_NAME })),
            }
            match obj.get_mut("appliedId") {
                Some(slot) => *slot = json!(PROFILE_ID),
                None => {
                    obj.insert("appliedId".to_string(), json!(PROFILE_ID));
                }
            }
        } else {
            let next_id = match obj.get_mut("entries") {
                Some(entries) => {
                    let entries = entries.as_array_mut().ok_or_else(not_an_array)?;
                    entries.retain(|entry| !is_ours(entry));
                    entries
                        .iter()
                        .find_map(|entry| entry.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                }
                None => None,
            };
            if obj.get("appliedId").and_then(Value::as_str) == Some(PROFILE_ID) {
                match next_id {
                    Some(next_id) => {
                        obj.insert("appliedId".to_string(), json!(next_id));
                    }
                    None => {
                        obj.shift_remove("appliedId");
                    }
                }
            }
        }

        patch_json::serialize(path, &doc, &style)
    }
}

fn build_gateway_profile(
    base_url: &str,
    api_key: &str,
    model_specs: Option<&[InferenceModelSpec]>,
) -> Value {
    let mut profile = json!({
        "coworkEgressAllowedHosts": ["*"],
        "disableDeploymentModeChooser": true,
        "inferenceGatewayApiKey": api_key,
        "inferenceGatewayAuthScheme": "bearer",
        "inferenceGatewayBaseUrl": base_url,
        "inferenceProvider": "gateway"
    });

    if let Some(model_specs) = model_specs {
        profile["inferenceModels"] =
            Value::Array(model_specs.iter().map(inference_model_json).collect());
    }

    profile
}

fn read_json_or_empty(path: &Path) -> Result<Value, AppError> {
    let value = if path.exists() {
        read_json_file(path)?
    } else {
        json!({})
    };

    if value.is_object() {
        Ok(value)
    } else {
        Ok(json!({}))
    }
}

fn read_applied_id(path: &Path) -> Option<String> {
    read_json_or_empty(path).ok().and_then(|value| {
        value
            .get("appliedId")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn meta_has_profile_entry(path: &Path) -> bool {
    read_json_or_empty(path)
        .ok()
        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
        .is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(PROFILE_ID))
        })
}

fn is_supported_platform() -> bool {
    cfg!(any(target_os = "macos", windows, target_os = "linux"))
}

#[allow(clippy::needless_return)]
fn current_platform_paths() -> Result<ClaudeDesktopPaths, AppError> {
    #[cfg(target_os = "macos")]
    {
        return Ok(macos_paths_from_home(&get_home_dir()));
    }

    #[cfg(windows)]
    {
        let local_app_data = windows_local_app_data_dir();
        return Ok(windows_paths_from_local_app_data(&local_app_data));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(linux_paths_from_config_dir(&linux_config_dir()));
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Err(unsupported_platform_error())
    }
}

/// Flatpak keeps an app's XDG_CONFIG_HOME inside its sandbox. Claude Desktop
/// installed natively uses the host's ~/.config by default, which must be
/// exposed through the Flatpak filesystem permissions.
///
/// This is intentionally the host *default* configuration directory. We do
/// not expose a directory override or attempt to recover a host-custom
/// XDG_CONFIG_HOME: Flatpak replaces that variable with its private path, so
/// its original host value is not available reliably from the sandbox. Users
/// with a custom host XDG_CONFIG_HOME should run the native CC Switch package.
#[cfg(target_os = "linux")]
fn linux_config_dir() -> PathBuf {
    let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    linux_config_dir_from_home(&get_home_dir(), xdg_config_home.as_deref(), is_flatpak())
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_config_dir_from_home(
    home: &Path,
    xdg_config_home: Option<&Path>,
    running_in_flatpak: bool,
) -> PathBuf {
    if running_in_flatpak {
        return home.join(".config");
    }

    xdg_config_home
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"))
}

#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").is_file()
}

#[cfg(target_os = "linux")]
fn linux_paths_from_config_dir(config_dir: &Path) -> ClaudeDesktopPaths {
    paths_from_dirs(config_dir.join("Claude"), config_dir.join("Claude-3p"))
}

#[cfg(target_os = "macos")]
fn macos_paths_from_home(home: &Path) -> ClaudeDesktopPaths {
    let app_support = home.join("Library").join("Application Support");
    paths_from_dirs(app_support.join("Claude"), app_support.join("Claude-3p"))
}

#[cfg(windows)]
fn windows_local_app_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| get_home_dir().join("AppData").join("Local"))
}

#[cfg(windows)]
fn windows_paths_from_local_app_data(local_app_data: &Path) -> ClaudeDesktopPaths {
    let normal_dir = pick_windows_claude_dir(local_app_data, false)
        .unwrap_or_else(|| local_app_data.join("Claude"));
    let threep_dir = pick_windows_claude_dir(local_app_data, true)
        .unwrap_or_else(|| local_app_data.join("Claude-3p"));
    paths_from_dirs(normal_dir, threep_dir)
}

#[cfg(windows)]
fn pick_windows_claude_dir(local_app_data: &Path, threep: bool) -> Option<PathBuf> {
    let exact_name = if threep { "Claude-3p" } else { "Claude" };
    let exact = local_app_data.join(exact_name);
    if exact.exists() {
        return Some(exact);
    }

    let mut candidates: Vec<PathBuf> = std::fs::read_dir(local_app_data)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            let starts = name.starts_with("Claude");
            let is_threep = name.contains("-3p");
            starts && is_threep == threep
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

#[cfg(any(target_os = "macos", windows, target_os = "linux", test))]
fn paths_from_dirs(normal_dir: PathBuf, threep_dir: PathBuf) -> ClaudeDesktopPaths {
    let config_library_path = threep_dir.join(CONFIG_LIBRARY_DIR);
    let profile_path = config_library_path.join(format!("{PROFILE_ID}.json"));
    let meta_path = config_library_path.join("_meta.json");

    ClaudeDesktopPaths {
        normal_config_path: normal_dir.join(CONFIG_FILE),
        threep_config_path: threep_dir.join(CONFIG_FILE),
        config_library_path,
        profile_path,
        meta_path,
        device: DeviceStore::for_device(),
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn unsupported_platform_error() -> AppError {
    AppError::localized(
        "claude_desktop.unsupported_platform",
        "当前平台暂不支持 Claude Desktop 3P 配置。支持的平台：macOS、Windows 和 Linux。",
        "Claude Desktop 3P configuration is not supported on this platform yet. Supported platforms: macOS, Windows, and Linux.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::write_json_file;
    use crate::database::Database;
    use crate::provider::{ClaudeDesktopModelRoute, ProviderMeta};
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn test_paths(home: &Path) -> ClaudeDesktopPaths {
        let mut paths = paths_from_dirs(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
            home.join("Library")
                .join("Application Support")
                .join("Claude-3p"),
        );
        paths.device = DeviceStore::at(home.join(".cc-switch"));
        paths
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    #[test]
    fn linux_config_dir_uses_absolute_xdg_config_home_outside_flatpak() {
        let home = Path::new("/home/tester");
        let xdg = Path::new("/mnt/config");

        assert_eq!(
            linux_config_dir_from_home(home, Some(xdg), false),
            PathBuf::from("/mnt/config")
        );
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    #[test]
    fn linux_config_dir_falls_back_for_missing_or_relative_xdg_config_home() {
        let home = Path::new("/home/tester");

        assert_eq!(
            linux_config_dir_from_home(home, None, false),
            PathBuf::from("/home/tester/.config")
        );
        assert_eq!(
            linux_config_dir_from_home(home, Some(Path::new("relative/config")), false),
            PathBuf::from("/home/tester/.config")
        );
    }

    #[cfg(any(target_os = "linux", all(test, unix)))]
    #[test]
    fn linux_config_dir_uses_host_config_when_cc_switch_runs_in_flatpak() {
        let home = Path::new("/home/tester");
        let private_xdg = Path::new("/home/tester/.var/app/com.ccswitch.desktop/config");

        assert_eq!(
            linux_config_dir_from_home(home, Some(private_xdg), true),
            PathBuf::from("/home/tester/.config")
        );
    }

    fn test_db() -> Database {
        Database::memory().expect("memory db")
    }

    fn direct_provider(id: &str) -> Provider {
        let mut provider = Provider::with_id(
            id.to_string(),
            "Direct".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://gateway.example.com",
                    "ANTHROPIC_AUTH_TOKEN": "test-token",
                    "ANTHROPIC_MODEL": "ignored-by-desktop"
                }
            }),
            Some("https://example.com".to_string()),
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("anthropic".to_string()),
            ..Default::default()
        });
        provider
    }

    fn official_provider() -> Provider {
        let mut provider = Provider::with_id(
            CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID.to_string(),
            "Claude Desktop Official".to_string(),
            json!({"env": {}}),
            Some("https://claude.ai/download".to_string()),
        );
        provider.category = Some("official".to_string());
        provider
    }

    fn proxy_provider(id: &str) -> Provider {
        let mut provider = direct_provider(id);
        provider.name = "Proxy".to_string();
        provider.meta = Some(ProviderMeta {
            claude_desktop_mode: Some(ClaudeDesktopMode::Proxy),
            api_format: Some("openai_chat".to_string()),
            claude_desktop_model_routes: std::collections::HashMap::from([(
                "claude-sonnet-4-6".to_string(),
                ClaudeDesktopModelRoute {
                    model: "kimi-k2".to_string(),
                    label_override: Some("Kimi K2".to_string()),
                    supports_1m: Some(true),
                },
            )]),
            ..Default::default()
        });
        provider
    }

    fn direct_provider_with_models(id: &str) -> Provider {
        let mut provider = direct_provider(id);
        provider.meta = Some(ProviderMeta {
            claude_desktop_mode: Some(ClaudeDesktopMode::Direct),
            api_format: Some("anthropic".to_string()),
            claude_desktop_model_routes: std::collections::HashMap::from([(
                "claude-sonnet-4-6".to_string(),
                ClaudeDesktopModelRoute {
                    model: "claude-sonnet-4-6".to_string(),
                    label_override: None,
                    supports_1m: Some(true),
                },
            )]),
            ..Default::default()
        });
        provider
    }

    #[test]
    fn claude_desktop_apply_writes_3p_profile_and_meta() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let provider = direct_provider("direct");
        let db = test_db();

        apply_provider_to_paths(&db, &provider, &paths).expect("apply provider");

        let normal: Value = read_json_file(&paths.normal_config_path).expect("read normal config");
        let threep: Value = read_json_file(&paths.threep_config_path).expect("read 3p config");
        let profile: Value = read_json_file(&paths.profile_path).expect("read profile");
        let meta: Value = read_json_file(&paths.meta_path).expect("read meta");

        assert_eq!(normal["deploymentMode"], json!("3p"));
        assert_eq!(threep["deploymentMode"], json!("3p"));
        assert_eq!(profile["inferenceProvider"], json!("gateway"));
        assert_eq!(
            profile["inferenceGatewayBaseUrl"],
            json!("https://gateway.example.com")
        );
        assert_eq!(profile["inferenceGatewayApiKey"], json!("test-token"));
        assert_eq!(profile["inferenceGatewayAuthScheme"], json!("bearer"));
        assert_eq!(profile["disableDeploymentModeChooser"], json!(true));
        assert_eq!(profile["coworkEgressAllowedHosts"], json!(["*"]));
        assert!(profile.get("inferenceModels").is_none());
        assert_eq!(meta["appliedId"], json!(PROFILE_ID));
        assert!(meta["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["id"] == json!(PROFILE_ID) && entry["name"] == json!(PROFILE_NAME)));
    }

    #[test]
    fn claude_desktop_direct_can_write_optional_safe_model_ids() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let provider = direct_provider_with_models("direct-models");
        let db = test_db();

        apply_provider_to_paths(&db, &provider, &paths).expect("apply provider");

        let profile: Value = read_json_file(&paths.profile_path).expect("read profile");
        assert_eq!(
            profile["inferenceGatewayBaseUrl"],
            json!("https://gateway.example.com")
        );
        assert_eq!(
            profile["inferenceModels"],
            json!([{ "name": "claude-sonnet-4-6", "supports1m": true }])
        );
    }

    #[test]
    fn claude_desktop_direct_rejects_model_mapping_to_non_claude_upstream() {
        let mut provider = direct_provider_with_models("direct-non-claude");
        provider
            .meta
            .as_mut()
            .expect("meta")
            .claude_desktop_model_routes
            .get_mut("claude-sonnet-4-6")
            .expect("route")
            .model = "mimo-v2.5-pro".to_string();

        let err = validate_provider(&provider).expect_err("direct mapping should fail");
        assert!(err.to_string().contains("直连模式不能映射模型"));
    }

    #[test]
    fn claude_desktop_rejects_legacy_proxy_without_writing_local_gateway() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let db = test_db();
        let provider = proxy_provider("saved-proxy");
        let saved_settings = provider.settings_config.clone();
        let saved_routes = provider
            .meta
            .as_ref()
            .unwrap()
            .claude_desktop_model_routes
            .clone();

        let err = apply_provider_to_paths(&db, &provider, &paths)
            .expect_err("removed local routing cannot activate");
        assert!(
            err.to_string().contains("已移除"),
            "unexpected error: {err}"
        );
        assert!(!paths.profile_path.exists());
        assert!(!paths.normal_config_path.exists());
        assert!(!paths.threep_config_path.exists());
        assert!(!paths.meta_path.exists());
        assert!(db.get_setting(GATEWAY_TOKEN_SETTING_KEY).unwrap().is_none());
        assert_eq!(provider.settings_config, saved_settings);
        assert_eq!(
            provider.meta.as_ref().unwrap().claude_desktop_model_routes,
            saved_routes
        );
    }

    #[test]
    fn claude_desktop_rejects_1m_suffix_as_model_id() {
        assert!(!is_claude_safe_model_id("claude-sonnet-4-6 [1m]"));
        assert!(!is_claude_safe_model_id("  claude-sonnet-4-6  [1M]  "));
        assert!(!is_claude_safe_model_id("claude-old"));
        assert!(!is_claude_safe_model_id("claude-3-5-sonnet-20241022"));
        assert!(!is_claude_safe_model_id("claude-deepseek-v4-pro"));
        assert!(!is_claude_safe_model_id("claude-gpt-5-4"));
        assert!(!is_claude_safe_model_id("claude-"));
        assert!(!is_claude_safe_model_id("anthropic/claude-"));
        assert!(!is_claude_safe_model_id("sonnet"));
        assert!(!is_claude_safe_model_id("sonnet-"));
        // 角色前缀后无实际标识的退化值必须拒绝
        assert!(!is_claude_safe_model_id("claude-sonnet-"));
        assert!(!is_claude_safe_model_id("claude-opus-"));
        assert!(!is_claude_safe_model_id("anthropic/claude-haiku-"));
        assert!(is_claude_safe_model_id("  claude-sonnet-4-6  "));
        assert!(is_claude_safe_model_id("anthropic/claude-opus-4-8"));
    }

    #[test]
    fn claude_desktop_apply_rolls_back_when_profile_write_fails() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let provider = direct_provider("direct");
        let db = test_db();

        write_json_file(
            &paths.normal_config_path,
            &json!({"deploymentMode": "1p", "normal": true}),
        )
        .expect("write normal");
        write_json_file(
            &paths.threep_config_path,
            &json!({"deploymentMode": "1p", "threep": true}),
        )
        .expect("write 3p");
        fs::write(&paths.config_library_path, "not a directory").expect("block profile parent");

        apply_provider_to_paths(&db, &provider, &paths).expect_err("apply should fail");

        let normal: Value = read_json_file(&paths.normal_config_path).expect("read normal config");
        let threep: Value = read_json_file(&paths.threep_config_path).expect("read 3p config");

        assert_eq!(normal, json!({"deploymentMode": "1p", "normal": true}));
        assert_eq!(threep, json!({"deploymentMode": "1p", "threep": true}));
        assert!(!paths.profile_path.exists());
    }

    #[test]
    fn claude_desktop_refuses_a_meta_file_it_cannot_understand() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let db = test_db();
        if let Some(parent) = paths.meta_path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&paths.meta_path, "[]").expect("write invalid meta shape");

        apply_provider_to_paths(&db, &direct_provider("direct"), &paths)
            .expect_err("a meta file that is not an object must not be overwritten");

        assert_eq!(fs::read_to_string(&paths.meta_path).unwrap(), "[]");
        assert!(!paths.profile_path.exists());
        assert!(!paths.normal_config_path.exists());
    }

    #[test]
    fn claude_desktop_restore_switches_to_1p_and_clears_the_cc_switch_profile() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let provider = direct_provider("direct");
        let db = test_db();

        apply_provider_to_paths(&db, &provider, &paths).expect("apply provider");
        restore_official_at_paths(&paths).expect("restore official");

        let normal: Value = read_json_file(&paths.normal_config_path).expect("read normal config");
        let threep: Value = read_json_file(&paths.threep_config_path).expect("read 3p config");
        let meta: Value = read_json_file(&paths.meta_path).expect("read meta");
        let profile: Value = read_json_file(&paths.profile_path).expect("profile is kept");

        assert_eq!(normal["deploymentMode"], json!("1p"));
        assert_eq!(threep["deploymentMode"], json!("1p"));
        for key in floor::DESKTOP_PROFILE_FLOOR {
            assert!(profile.get(*key).is_none(), "{key} must be cleared");
        }
        assert!(meta.get("appliedId").is_none());
        assert!(!meta["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["id"] == json!(PROFILE_ID)));
    }

    /// #4774：用户在 Desktop 里给 CC Switch 的 profile 打开的设置，切换供应商、
    /// 切回官方再切回来都不能丢；用户收紧过的出站白名单也不能被改回 `*`。
    #[test]
    fn claude_desktop_switches_keep_the_users_own_profile_settings() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let db = test_db();

        apply_provider_to_paths(&db, &direct_provider("a"), &paths).expect("apply a");
        let mut profile: Value = read_json_file(&paths.profile_path).expect("read profile");
        profile["userAutoMode"] = json!(true);
        profile["coworkEgressAllowedHosts"] = json!(["corp.example"]);
        fs::write(
            &paths.profile_path,
            serde_json::to_string_pretty(&profile).unwrap(),
        )
        .unwrap();

        apply_provider_to_paths(&db, &direct_provider_with_models("b"), &paths).expect("apply b");
        restore_official_at_paths(&paths).expect("restore official");
        apply_provider_to_paths(&db, &direct_provider("a"), &paths).expect("apply a again");

        let profile: Value = read_json_file(&paths.profile_path).expect("read profile");
        assert_eq!(profile["userAutoMode"], json!(true));
        assert_eq!(profile["coworkEgressAllowedHosts"], json!(["corp.example"]));
        assert_eq!(profile["disableDeploymentModeChooser"], json!(true));
        assert_eq!(profile["inferenceProvider"], json!("gateway"));
        assert!(
            profile.get("inferenceModels").is_none(),
            "the previous provider's models must not linger"
        );
    }

    #[test]
    fn claude_desktop_keeps_other_meta_entries_in_place() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let db = test_db();
        write_json_file(
            &paths.meta_path,
            &json!({
                "entries": [
                    {"id": "other-1", "name": "Mine"},
                    {"id": PROFILE_ID, "name": "Old name", "note": "kept"},
                    {"id": "other-2", "name": "Also mine"}
                ],
                "appliedId": "other-1"
            }),
        )
        .expect("seed meta");

        apply_provider_to_paths(&db, &direct_provider("a"), &paths).expect("apply");
        let meta: Value = read_json_file(&paths.meta_path).expect("read meta");
        assert_eq!(
            meta["entries"],
            json!([
                {"id": "other-1", "name": "Mine"},
                {"id": PROFILE_ID, "name": PROFILE_NAME, "note": "kept"},
                {"id": "other-2", "name": "Also mine"}
            ])
        );
        assert_eq!(meta["appliedId"], json!(PROFILE_ID));

        restore_official_at_paths(&paths).expect("restore");
        let meta: Value = read_json_file(&paths.meta_path).expect("read meta");
        assert_eq!(
            meta["entries"],
            json!([{"id": "other-1", "name": "Mine"}, {"id": "other-2", "name": "Also mine"}])
        );
        assert_eq!(meta["appliedId"], json!("other-1"));
    }

    #[cfg(unix)]
    #[test]
    fn claude_desktop_profile_with_the_gateway_key_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        apply_provider_to_paths(&test_db(), &direct_provider("a"), &paths).expect("apply");
        let mode = fs::metadata(&paths.profile_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn claude_desktop_official_provider_restores_1p_mode() {
        let temp = TempDir::new().expect("tempdir");
        let paths = test_paths(temp.path());
        let direct = direct_provider("direct");
        let db = test_db();

        apply_provider_to_paths(&db, &direct, &paths).expect("apply direct provider");
        apply_provider_to_paths(&db, &official_provider(), &paths)
            .expect("restore official provider");

        let normal: Value = read_json_file(&paths.normal_config_path).expect("read normal config");
        let threep: Value = read_json_file(&paths.threep_config_path).expect("read 3p config");
        let meta: Value = read_json_file(&paths.meta_path).expect("read meta");

        assert_eq!(normal["deploymentMode"], json!("1p"));
        assert_eq!(threep["deploymentMode"], json!("1p"));
        let profile: Value = read_json_file(&paths.profile_path).expect("profile is kept");
        assert!(profile.get("inferenceGatewayApiKey").is_none());
        assert!(meta.get("appliedId").is_none());
    }

    #[test]
    fn claude_desktop_compatibility_filters_non_direct_providers() {
        let direct = direct_provider("direct");
        assert!(is_compatible_direct_provider(&direct));

        let mut claude_official = Provider::with_id(
            "claude-official".to_string(),
            "Claude Official".to_string(),
            json!({"env": {}}),
            Some("https://www.anthropic.com/claude-code".to_string()),
        );
        claude_official.category = Some("official".to_string());
        assert!(!is_compatible_direct_provider(&claude_official));

        let mut openai_format = direct_provider("openai");
        openai_format.meta = Some(ProviderMeta {
            api_format: Some("openai_chat".to_string()),
            ..Default::default()
        });
        assert!(!is_compatible_direct_provider(&openai_format));

        let mut copilot = direct_provider("copilot");
        copilot.meta = Some(ProviderMeta {
            provider_type: Some("github_copilot".to_string()),
            ..Default::default()
        });
        assert!(!is_compatible_direct_provider(&copilot));

        let mut full_url = direct_provider("full_url");
        full_url.meta = Some(ProviderMeta {
            is_full_url: Some(true),
            ..Default::default()
        });
        assert!(!is_compatible_direct_provider(&full_url));

        let missing_bearer = Provider::with_id(
            "x-api-key".to_string(),
            "x-api-key".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://gateway.example.com",
                    "ANTHROPIC_API_KEY": "sk-ant"
                }
            }),
            None,
        );
        assert!(!is_compatible_direct_provider(&missing_bearer));
    }
}
