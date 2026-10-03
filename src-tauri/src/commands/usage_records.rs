use crate::error::AppError;
use crate::services::usage_attribution::{
    self, UsageAttributionChoice, UsageAttributionResult, UsageAttributionSelector,
};
use crate::services::usage_records::{PaginatedUsageRecords, UsageRecordFilters, UsageRecordView};
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_usage_records(
    state: State<'_, AppState>,
    filters: UsageRecordFilters,
    view: UsageRecordView,
    page: u32,
    page_size: u32,
    time_zone: Option<String>,
) -> Result<PaginatedUsageRecords, AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.get_usage_records(
            &filters,
            view,
            page,
            page_size,
            time_zone.as_deref().unwrap_or("local"),
        )
    })
    .await
    .map_err(|error| AppError::Message(format!("Usage query task failed: {error}")))?
}

#[tauri::command]
pub async fn get_usage_attribution_choices(
    state: State<'_, AppState>,
) -> Result<Vec<UsageAttributionChoice>, AppError> {
    usage_attribution::get_usage_attribution_choices(&state.db, &state.codex_oauth_manager).await
}

#[tauri::command]
pub fn preview_usage_attribution(
    state: State<'_, AppState>,
    selector: UsageAttributionSelector,
    only_untagged: bool,
) -> Result<usize, AppError> {
    usage_attribution::count_usage_attribution_records(&state.db, &selector, only_untagged)
}

#[tauri::command]
pub async fn set_usage_attribution(
    state: State<'_, AppState>,
    selector: UsageAttributionSelector,
    choice_id: String,
    only_untagged: bool,
) -> Result<UsageAttributionResult, AppError> {
    let choices =
        usage_attribution::get_usage_attribution_choices(&state.db, &state.codex_oauth_manager)
            .await?;
    let choice = choices
        .into_iter()
        .find(|choice| choice.id == choice_id)
        .ok_or_else(|| AppError::InvalidInput("Unknown attribution account".into()))?;
    let result =
        usage_attribution::apply_usage_attribution(&state.db, &selector, &choice, only_untagged)?;
    if result.count > 0 {
        crate::usage_events::notify_log_recorded();
    }
    Ok(result)
}

#[tauri::command]
pub fn undo_usage_attribution(
    state: State<'_, AppState>,
    action_id: i64,
) -> Result<usize, AppError> {
    let count = usage_attribution::undo_usage_attribution(&state.db, action_id)?;
    if count > 0 {
        crate::usage_events::notify_log_recorded();
    }
    Ok(count)
}
