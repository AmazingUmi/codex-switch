//! Read-only, server-side grouping of usage records. Attribution lives only in Switch.
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::sql_helpers::fresh_input_sql;
use crate::services::usage_stats::effective_usage_log_filter;
use rusqlite::{Connection, ToSql};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordFilters {
    pub app_type: Option<String>,
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UsageRecordView {
    Session,
    Hour,
    Day,
    Details,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordGroup {
    pub id: String,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub app_type: String,
    pub start_at: i64,
    pub end_at: i64,
    pub bucket_start_at: Option<i64>,
    pub bucket_end_at: Option<i64>,
    pub record_count: u64,
    pub account_name: Option<String>,
    pub provider_name: Option<String>,
    pub account_ids: Vec<String>,
    pub provider_ids: Vec<String>,
    pub account_names: Vec<String>,
    pub provider_names: Vec<String>,
    pub models: Vec<String>,
    pub method: String,
    /// Fresh input, already normalized using the same expression as dashboard totals.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: String,
    pub unpriced_count: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub breakdown: Vec<UsageRecordGroup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedUsageRecords {
    pub data: Vec<UsageRecordGroup>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    /// Historical daily aggregates have no request/session IDs. Rebuild from
    /// native logs is required before they can appear as grouped records.
    pub legacy_rollup_count: u64,
}

struct Record {
    id: String,
    session: Option<String>,
    app: String,
    model: String,
    created: i64,
    account_id: Option<String>,
    account_name: Option<String>,
    provider_id: Option<String>,
    provider_name: Option<String>,
    method: String,
    input: u64,
    output: u64,
    read: u64,
    creation: u64,
    cost: Decimal,
    unpriced: bool,
    bucket_start: Option<i64>,
    bucket_end: Option<i64>,
}

#[derive(Default)]
struct Accumulator {
    row: UsageRecordGroup,
    cost: Decimal,
    methods: BTreeSet<String>,
    apps: BTreeSet<String>,
    accounts: BTreeMap<String, String>,
    providers: BTreeMap<String, String>,
    models: BTreeSet<String>,
    children: BTreeMap<String, Accumulator>,
}

impl Accumulator {
    fn add(&mut self, record: &Record, breakdown: bool) {
        if self.row.record_count == 0 {
            self.row.start_at = record.created;
            self.row.end_at = record.created;
            self.row.session_id = record.session.clone();
            self.row.bucket_start_at = record.bucket_start;
            self.row.bucket_end_at = record.bucket_end;
        }
        self.row.start_at = self.row.start_at.min(record.created);
        self.row.end_at = self.row.end_at.max(record.created);
        if self.row.session_id != record.session {
            self.row.session_id = None;
        }
        self.row.record_count += 1;
        self.row.input_tokens += record.input;
        self.row.output_tokens += record.output;
        self.row.cache_read_tokens += record.read;
        self.row.cache_creation_tokens += record.creation;
        self.row.unpriced_count += u64::from(record.unpriced);
        self.cost += record.cost;
        self.apps.insert(record.app.clone());
        self.methods.insert(record.method.clone());
        self.models.insert(record.model.clone());
        self.accounts.insert(
            record
                .account_id
                .clone()
                .unwrap_or_else(|| "__unassigned__".into()),
            record
                .account_name
                .clone()
                .unwrap_or_else(|| "Unassigned".into()),
        );
        self.providers.insert(
            record
                .provider_id
                .clone()
                .unwrap_or_else(|| "__unassigned__".into()),
            record
                .provider_name
                .clone()
                .unwrap_or_else(|| "Unassigned".into()),
        );
        if breakdown {
            let key = serde_json::to_string(&(
                &record.account_id,
                &record.provider_id,
                &record.model,
                &record.method,
            ))
            .expect("strings serialize");
            let child = self.children.entry(key.clone()).or_default();
            child.row.id = key;
            child.add(record, false);
        }
    }
    fn finish(mut self) -> UsageRecordGroup {
        self.row.app_type = if self.apps.len() == 1 {
            self.apps.into_iter().next().unwrap()
        } else {
            "mixed".into()
        };
        self.row.method = if self.methods.len() == 1 {
            self.methods.into_iter().next().unwrap()
        } else {
            "mixed".into()
        };
        self.row.account_name =
            (self.accounts.len() == 1).then(|| self.accounts.values().next().unwrap().clone());
        self.row.provider_name =
            (self.providers.len() == 1).then(|| self.providers.values().next().unwrap().clone());
        self.row.account_ids = self.accounts.keys().cloned().collect();
        self.row.account_names = self.accounts.into_values().collect();
        self.row.provider_ids = self.providers.keys().cloned().collect();
        self.row.provider_names = self.providers.into_values().collect();
        self.row.models = self.models.into_iter().collect();
        self.row.total_cost_usd = self.cost.normalize().to_string();
        self.row.breakdown = self
            .children
            .into_values()
            .map(Accumulator::finish)
            .collect();
        self.row
    }
}

/// Build one filtered read projection for counts, grouping and detail queries.
fn projection(
    filters: &UsageRecordFilters,
    view: UsageRecordView,
    time_zone: &str,
) -> Result<(String, Vec<Box<dyn ToSql>>), AppError> {
    if !matches!(time_zone, "local" | "UTC") {
        return Err(AppError::InvalidInput(
            "Time zone must be local or UTC".into(),
        ));
    }
    if filters
        .start_date
        .zip(filters.end_date)
        .is_some_and(|(start, end)| start > end)
    {
        return Err(AppError::InvalidInput(
            "Usage date range is reversed".into(),
        ));
    }
    let provider_id = "CASE WHEN a.request_id IS NOT NULL THEN a.provider_id WHEN l.provider_id = '_codex_session' THEN NULL ELSE l.provider_id END";
    let provider_name = "CASE WHEN a.request_id IS NOT NULL THEN a.provider_name WHEN l.provider_id = '_codex_session' THEN NULL ELSE COALESCE(p.name,l.provider_id) END";
    let mut conditions = vec![effective_usage_log_filter("l")];
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    for (value, expression) in [
        (&filters.app_type, "CASE WHEN l.app_type='claude-desktop' THEN 'claude' ELSE l.app_type END"),
        (&filters.model, "COALESCE(NULLIF(l.pricing_model,''),l.model)"),
        (&filters.session_id, "l.session_id"),
        (&filters.provider_name, "COALESCE(CASE WHEN a.request_id IS NOT NULL THEN a.provider_name WHEN l.provider_id = '_codex_session' THEN NULL ELSE COALESCE(p.name,l.provider_id) END,'Unassigned')"),
    ] {
        if let Some(value) = value { conditions.push(format!("{expression} = ?")); params.push(Box::new(value.clone())); }
    }
    for (value, expression) in [
        (&filters.account_id, "a.account_id"),
        (&filters.provider_id, provider_id),
    ] {
        if let Some(value) = value {
            if value == "__unassigned__" {
                conditions.push(format!("{expression} IS NULL"));
            } else {
                conditions.push(format!("{expression} = ?"));
                params.push(Box::new(value.clone()));
            }
        }
    }
    if let Some(start) = filters.start_date {
        conditions.push("l.created_at >= ?".into());
        params.push(Box::new(start));
    }
    if let Some(end) = filters.end_date {
        conditions.push("l.created_at <= ?".into());
        params.push(Box::new(end));
    }
    match filters.attribution.as_deref().unwrap_or("all") {
        "all" => (),
        "untagged" => conditions.push("a.request_id IS NULL".into()),
        method @ ("auto" | "manual") => {
            conditions.push("a.method = ?".into());
            params.push(Box::new(method.to_string()));
        }
        _ => return Err(AppError::InvalidInput("Invalid attribution filter".into())),
    }
    let modifiers = if time_zone == "local" {
        ",'unixepoch','localtime'"
    } else {
        ",'unixepoch'"
    };
    // Subtract local minutes/seconds from the original UTC timestamp. Repeated DST hours
    // retain separate UTC keys, and zones with half-hour offsets retain local boundaries.
    let hour = format!("l.created_at - CAST(strftime('%M',l.created_at{modifiers}) AS INTEGER)*60 - CAST(strftime('%S',l.created_at{modifiers}) AS INTEGER)");
    let day = format!("strftime('%Y-%m-%d',l.created_at{modifiers})");
    let day_start = if time_zone == "local" {
        "CAST(strftime('%s',l.created_at,'unixepoch','localtime','start of day','utc') AS INTEGER)"
    } else {
        "CAST(strftime('%s',l.created_at,'unixepoch','start of day') AS INTEGER)"
    };
    let day_end = if time_zone == "local" {
        "CAST(strftime('%s',l.created_at,'unixepoch','localtime','start of day','+1 day','utc') AS INTEGER)"
    } else {
        "CAST(strftime('%s',l.created_at,'unixepoch','start of day','+1 day') AS INTEGER)"
    };
    // Source is the subscription account or the API connection. Official
    // configuration IDs do not split one subscription account's time bucket;
    // API credential labels likewise do not split one connection's bucket.
    // Raw identity tuples are retained in the breakdown for provenance.
    let identity = format!(
        "CASE WHEN a.account_id IS NOT NULL AND substr(a.account_id,1,4)<>'api:' \
         THEN 'account:' || hex(a.account_id) \
         WHEN ({provider_id}) IS NOT NULL THEN 'provider:' || hex({provider_id}) \
         ELSE 'unassigned' END"
    );
    let (group, bucket_start, bucket_end) = match view {
        UsageRecordView::Session => ("'session:' || hex(l.app_type) || ':' || CASE WHEN NULLIF(l.session_id,'') IS NULL THEN 'request:' || hex(l.request_id) ELSE hex(l.session_id) END".to_string(), "NULL".to_string(), "NULL".to_string()),
        UsageRecordView::Details => ("'request:' || hex(l.request_id)".to_string(), "NULL".to_string(), "NULL".to_string()),
        UsageRecordView::Hour => (format!("'hour:' || ({hour}) || ':' || {identity}"), hour.clone(), format!("({hour})+3600")),
        UsageRecordView::Day => (format!("'day:' || ({day}) || ':' || {identity}"),day_start.to_string(),day_end.to_string()),
    };
    Ok((format!("WITH records AS (SELECT l.request_id, NULLIF(l.session_id,'') AS session_id,l.app_type,l.model,l.created_at,a.account_id,a.account_name,{provider_id} AS provider_id,{provider_name} AS provider_name,COALESCE(a.method,'untagged') AS method,{} AS input_tokens,l.output_tokens,l.cache_read_tokens,l.cache_creation_tokens,l.total_cost_usd,CASE WHEN l.status_code >= 200 AND l.status_code < 300 AND (l.input_tokens+l.output_tokens+l.cache_read_tokens+l.cache_creation_tokens)>0 AND CAST(l.total_cost_usd AS REAL)=0 AND CAST(COALESCE(l.cost_multiplier,'1') AS REAL)<>0 THEN 1 ELSE 0 END AS unpriced,{group} AS group_key,{bucket_start} AS bucket_start,{bucket_end} AS bucket_end FROM proxy_request_logs l LEFT JOIN usage_record_attributions a ON a.request_id=l.request_id LEFT JOIN providers p ON p.id=l.provider_id AND p.app_type=l.app_type WHERE {})", fresh_input_sql("l"),conditions.join(" AND ")),params))
}

pub(crate) fn query_usage_records(
    conn: &Connection,
    filters: &UsageRecordFilters,
    view: UsageRecordView,
    page: u32,
    page_size: u32,
    time_zone: &str,
) -> Result<PaginatedUsageRecords, AppError> {
    if page_size == 0 || page_size > 200 {
        return Err(AppError::InvalidInput(
            "Page size must be between 1 and 200".into(),
        ));
    }
    let (base, mut params) = projection(filters, view, time_zone)?;
    let legacy_rollup_count = legacy_rollup_count(conn, filters)?;
    let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let total = conn.query_row(
        &format!("{base} SELECT COUNT(*) FROM (SELECT group_key FROM records GROUP BY group_key)"),
        refs.as_slice(),
        |row| row.get::<_, i64>(0),
    )? as u64;
    let mut group_stmt = conn.prepare(&format!("{base} SELECT group_key FROM records GROUP BY group_key ORDER BY MAX(created_at) DESC,group_key ASC LIMIT ? OFFSET ?"))?;
    params.push(Box::new(i64::from(page_size)));
    params.push(Box::new(i64::from(page) * i64::from(page_size)));
    let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let keys = group_stmt
        .query_map(refs.as_slice(), |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    params.truncate(params.len() - 2);
    if keys.is_empty() {
        return Ok(PaginatedUsageRecords {
            data: vec![],
            total,
            page,
            page_size,
            legacy_rollup_count,
        });
    }
    let placeholders = vec!["?"; keys.len()].join(",");
    for key in &keys {
        params.push(Box::new(key.clone()));
    }
    let sql = format!("{base} SELECT request_id,session_id,app_type,model,created_at,account_id,account_name,provider_id,provider_name,method,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_cost_usd,unpriced,group_key,bucket_start,bucket_end FROM records WHERE group_key IN ({placeholders}) ORDER BY created_at,request_id");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut rows = stmt.query(refs.as_slice())?;
    let mut groups: BTreeMap<String, Accumulator> = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let cost_string: String = row.get(14)?;
        let cost = Decimal::from_str(&cost_string)
            .map_err(|_| AppError::Database("Invalid stored usage cost".into()))?;
        let record = Record {
            id: row.get(0)?,
            // A time bucket is selected by time and identity even when it happens
            // to contain one session; exposing that session would broaden tags.
            session: if matches!(view, UsageRecordView::Session | UsageRecordView::Details) {
                row.get(1)?
            } else {
                None
            },
            app: row.get(2)?,
            model: row.get(3)?,
            created: row.get(4)?,
            account_id: row.get(5)?,
            account_name: row.get(6)?,
            provider_id: row.get(7)?,
            provider_name: row.get(8)?,
            method: row.get(9)?,
            input: row.get::<_, i64>(10)?.max(0) as u64,
            output: row.get::<_, i64>(11)?.max(0) as u64,
            read: row.get::<_, i64>(12)?.max(0) as u64,
            creation: row.get::<_, i64>(13)?.max(0) as u64,
            cost,
            unpriced: row.get::<_, i64>(15)? != 0,
            bucket_start: row.get(17)?,
            bucket_end: row.get(18)?,
        };
        let key: String = row.get(16)?;
        let group = groups.entry(key.clone()).or_default();
        group.row.id = key;
        if view == UsageRecordView::Details
            || (view == UsageRecordView::Session && record.session.is_none())
        {
            group.row.request_id = Some(record.id.clone());
        }
        group.add(&record, view != UsageRecordView::Details);
    }
    Ok(PaginatedUsageRecords {
        data: keys
            .into_iter()
            .filter_map(|key| groups.remove(&key).map(Accumulator::finish))
            .collect(),
        total,
        page,
        page_size,
        legacy_rollup_count,
    })
}

fn legacy_rollup_count(conn: &Connection, filters: &UsageRecordFilters) -> Result<u64, AppError> {
    if filters.session_id.is_some()
        || filters
            .app_type
            .as_deref()
            .is_some_and(|value| value != "codex")
        || filters
            .account_id
            .as_deref()
            .is_some_and(|value| value != "__unassigned__")
        || filters
            .provider_id
            .as_deref()
            .is_some_and(|value| value != "__unassigned__")
        || filters
            .provider_name
            .as_deref()
            .is_some_and(|value| value != "Unassigned")
        || matches!(filters.attribution.as_deref(), Some("auto" | "manual"))
    {
        return Ok(0);
    }
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_daily_rollups')", [], |row|row.get(0))?;
    if !exists {
        return Ok(0);
    }
    let bounds = crate::services::usage_stats::compute_rollup_date_bounds(
        filters.start_date,
        filters.end_date,
    )?;
    if bounds.is_empty {
        return Ok(0);
    }
    let mut conditions = vec![
        "r.app_type='codex'".to_string(),
        "r.provider_id='_codex_session'".to_string(),
    ];
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    for (value, column) in [
        (&bounds.start, "r.date >= ?"),
        (&bounds.end, "r.date <= ?"),
        (
            &filters.model,
            "COALESCE(NULLIF(r.pricing_model,''),r.model)=?",
        ),
    ] {
        if let Some(value) = value {
            conditions.push(column.to_string());
            params.push(Box::new(value.clone()));
        }
    }
    let refs: Vec<&dyn ToSql> = params.iter().map(|value| value.as_ref()).collect();
    Ok(conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(r.request_count),0) FROM usage_daily_rollups r WHERE {}",
                conditions.join(" AND ")
            ),
            refs.as_slice(),
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64)
}

impl Database {
    pub fn get_usage_records(
        &self,
        filters: &UsageRecordFilters,
        view: UsageRecordView,
        page: u32,
        page_size: u32,
        time_zone: &str,
    ) -> Result<PaginatedUsageRecords, AppError> {
        let conn = lock_conn!(self.conn);
        query_usage_records(&conn, filters, view, page, page_size, time_zone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE proxy_request_logs(request_id TEXT PRIMARY KEY,session_id TEXT,app_type TEXT,model TEXT,pricing_model TEXT,created_at INTEGER,provider_id TEXT,data_source TEXT,status_code INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,input_token_semantics INTEGER,total_cost_usd TEXT,cost_multiplier TEXT); CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT); CREATE TABLE usage_record_attributions(request_id TEXT PRIMARY KEY,account_id TEXT,account_name TEXT,provider_id TEXT,provider_name TEXT,method TEXT,tagged_at INTEGER);").unwrap();
        conn
    }
    fn insert(
        conn: &Connection,
        id: &str,
        session: &str,
        time: i64,
        identity: Option<&str>,
        source: &str,
    ) {
        conn.execute("INSERT INTO proxy_request_logs VALUES(?1,?2,'codex','deepseek', 'deepseek',?3,'_codex_session',?4,200,100,5,30,20,1,'0.000001','1')",params![id,session,time,source]).unwrap();
        if let Some(identity) = identity {
            conn.execute(
                "INSERT INTO usage_record_attributions VALUES(?1,?2,?2,?2,?2,'manual',0)",
                params![id, identity],
            )
            .unwrap();
        }
    }
    fn query(
        conn: &Connection,
        view: UsageRecordView,
        page: u32,
        size: u32,
    ) -> PaginatedUsageRecords {
        query_usage_records(
            conn,
            &UsageRecordFilters::default(),
            view,
            page,
            size,
            "UTC",
        )
        .unwrap()
    }
    #[test]
    fn groups_before_pagination_and_preserves_exact_cost_and_fresh_tokens() {
        let conn = connection();
        for index in 0..31 {
            insert(
                &conn,
                &format!("r{index}"),
                "large",
                1000 + index,
                Some("a"),
                "codex_session",
            );
        }
        insert(&conn, "other", "other", 500, None, "codex_session");
        let first = query(&conn, UsageRecordView::Session, 0, 1);
        assert_eq!(first.total, 2);
        assert_eq!(first.data.len(), 1);
        let group = &first.data[0];
        assert_eq!(group.record_count, 31);
        assert_eq!(group.total_cost_usd, "0.000031");
        assert_eq!(group.input_tokens, 31 * 50);
        assert_eq!(group.cache_read_tokens, 31 * 30);
        assert_eq!(group.cache_creation_tokens, 31 * 20);
        let details = query(&conn, UsageRecordView::Details, 0, 100);
        assert_eq!(
            details
                .data
                .iter()
                .map(|r| Decimal::from_str(&r.total_cost_usd).unwrap())
                .sum::<Decimal>(),
            Decimal::from_str("0.000032").unwrap()
        );
        assert_eq!(
            query(&conn, UsageRecordView::Session, 1, 1).data[0]
                .session_id
                .as_deref(),
            Some("other")
        );
    }
    #[test]
    fn same_session_keeps_multiple_identities_and_untagged_breakdown() {
        let conn = connection();
        insert(&conn, "one", "thread", 1000, Some("a"), "codex_session");
        insert(&conn, "two", "thread", 1100, Some("b"), "codex_session");
        insert(&conn, "three", "thread", 1200, None, "codex_session");
        let result = query(&conn, UsageRecordView::Session, 0, 10);
        assert_eq!(result.total, 1);
        let group = &result.data[0];
        assert_eq!(group.account_ids, vec!["__unassigned__", "a", "b"]);
        assert_eq!(group.method, "mixed");
        assert!(group.provider_name.is_none());
        assert_eq!(group.breakdown.len(), 3);
        assert_eq!(
            group.breakdown.iter().map(|g| g.record_count).sum::<u64>(),
            group.record_count
        );
    }
    #[test]
    fn hourly_identity_boundaries_and_filters_are_applied_before_grouping() {
        let conn = connection();
        insert(&conn, "one", "thread", 3600, Some("a"), "codex_session");
        insert(&conn, "two", "thread", 3650, Some("b"), "codex_session");
        insert(&conn, "three", "thread", 7200, Some("a"), "codex_session");
        let hours = query(&conn, UsageRecordView::Hour, 0, 10);
        assert_eq!(hours.total, 3);
        assert_eq!(hours.data[0].bucket_start_at, Some(7200));
        assert_eq!(hours.data[0].bucket_end_at, Some(10800));
        assert!(hours.data.iter().all(|group| group.session_id.is_none()));
        let filters = UsageRecordFilters {
            start_date: Some(3601),
            end_date: Some(7199),
            ..Default::default()
        };
        let filtered =
            query_usage_records(&conn, &filters, UsageRecordView::Session, 0, 10, "UTC").unwrap();
        assert_eq!(filtered.data[0].record_count, 1);
        assert_eq!(filtered.data[0].account_name.as_deref(), Some("b"));
        let days = query(&conn, UsageRecordView::Day, 0, 10);
        assert_eq!(days.total, 2);
        assert_eq!(days.data[0].bucket_start_at, Some(0));
        assert_eq!(days.data[0].bucket_end_at, Some(86400));
    }

    #[test]
    fn time_buckets_group_by_subscription_or_api_source_and_keep_provenance() {
        let conn = connection();
        insert(
            &conn,
            "account-first",
            "thread",
            3600,
            Some("account-a"),
            "codex_session",
        );
        insert(
            &conn,
            "account-second",
            "thread",
            3610,
            Some("account-a"),
            "codex_session",
        );
        conn.execute("UPDATE usage_record_attributions SET provider_id='official-b',provider_name='Official B' WHERE request_id='account-second'",[]).unwrap();
        insert(
            &conn,
            "other-account",
            "thread",
            3620,
            Some("account-b"),
            "codex_session",
        );
        insert(&conn, "unknown", "thread", 3630, None, "codex_session");
        insert(
            &conn,
            "api-one",
            "api-thread",
            3640,
            Some("api:connection"),
            "codex_session",
        );
        insert(
            &conn,
            "api-two",
            "api-thread",
            3650,
            Some("api:old-credential-label"),
            "codex_session",
        );
        conn.execute("UPDATE usage_record_attributions SET provider_id='connection',provider_name='API connection' WHERE request_id IN('api-one','api-two')",[]).unwrap();
        insert(
            &conn,
            "api-legacy",
            "api-thread",
            3660,
            None,
            "codex_session",
        );
        conn.execute(
            "UPDATE proxy_request_logs SET provider_id='connection' WHERE request_id='api-legacy'",
            [],
        )
        .unwrap();
        let hours = query(&conn, UsageRecordView::Hour, 0, 10);
        assert_eq!(hours.total, 4);
        let account = hours
            .data
            .iter()
            .find(|group| group.account_ids == vec!["account-a"])
            .unwrap();
        assert_eq!(account.record_count, 2);
        assert_eq!(account.provider_ids, vec!["account-a", "official-b"]);
        assert_eq!(account.breakdown.len(), 2);
        assert_eq!(account.total_cost_usd, "0.000002");
        let api = hours
            .data
            .iter()
            .find(|group| group.provider_ids == vec!["connection"])
            .unwrap();
        assert_eq!(api.record_count, 3);
        assert_eq!(api.breakdown.len(), 3);
        assert_eq!(api.total_cost_usd, "0.000003");
        assert!(hours
            .data
            .iter()
            .any(|group| group.provider_ids == vec!["__unassigned__"] && group.record_count == 1));
        assert_eq!(
            hours
                .data
                .iter()
                .map(|group| group.input_tokens)
                .sum::<u64>(),
            7 * 50
        );
        assert_eq!(
            hours
                .data
                .iter()
                .map(|group| Decimal::from_str(&group.total_cost_usd).unwrap())
                .sum::<Decimal>(),
            Decimal::from_str("0.000007").unwrap()
        );
        assert_eq!(query(&conn, UsageRecordView::Day, 0, 10).total, 4);
        let filters = UsageRecordFilters {
            account_id: Some("account-a".into()),
            ..Default::default()
        };
        let scoped =
            query_usage_records(&conn, &filters, UsageRecordView::Hour, 0, 10, "UTC").unwrap();
        assert_eq!(scoped.total, 1);
        assert_eq!(scoped.data[0].record_count, 2);
    }
    #[test]
    fn cross_source_dedup_matches_dashboard_and_untagged_filter_is_durable() {
        let conn = connection();
        insert(&conn, "session", "thread", 1000, None, "codex_session");
        insert(&conn, "proxy", "thread", 1005, Some("a"), "proxy");
        let result = query(&conn, UsageRecordView::Session, 0, 10);
        assert_eq!(result.data[0].record_count, 1);
        let filters = UsageRecordFilters {
            attribution: Some("untagged".into()),
            ..Default::default()
        };
        assert_eq!(
            query_usage_records(&conn, &filters, UsageRecordView::Details, 0, 10, "UTC")
                .unwrap()
                .total,
            0
        );
        let filters = UsageRecordFilters {
            session_id: Some("thread".into()),
            account_id: Some("a".into()),
            ..Default::default()
        };
        assert_eq!(
            query_usage_records(&conn, &filters, UsageRecordView::Details, 0, 10, "UTC")
                .unwrap()
                .data[0]
                .request_id
                .as_deref(),
            Some("proxy")
        );
        assert!(query_usage_records(
            &conn,
            &filters,
            UsageRecordView::Hour,
            0,
            10,
            "America/Los_Angeles"
        )
        .is_err());
    }

    #[test]
    fn unknown_identity_filters_and_missing_pricing_are_visible() {
        let conn = connection();
        insert(&conn, "missing", "thread", 1000, None, "codex_session");
        insert(&conn, "free", "thread", 1100, None, "codex_session");
        conn.execute(
            "UPDATE proxy_request_logs SET total_cost_usd='0',pricing_model=NULL",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE proxy_request_logs SET cost_multiplier='0' WHERE request_id='free'",
            [],
        )
        .unwrap();
        let filters = UsageRecordFilters {
            provider_name: Some("Unassigned".into()),
            account_id: Some("__unassigned__".into()),
            provider_id: Some("__unassigned__".into()),
            ..Default::default()
        };
        let grouped =
            query_usage_records(&conn, &filters, UsageRecordView::Session, 0, 10, "UTC").unwrap();
        assert_eq!(grouped.total, 1);
        assert_eq!(grouped.data[0].record_count, 2);
        assert_eq!(grouped.data[0].unpriced_count, 1);
        assert_eq!(grouped.data[0].total_cost_usd, "0");
    }

    #[test]
    fn native_local_buckets_match_calendar_and_retain_utc_bounds() {
        use chrono::{Datelike, Local, TimeZone, Timelike};
        let conn = connection();
        // Falls on the repeated-hour date in North American DST zones. Other
        // system zones are checked against their own actual local calendar.
        let timestamp = 1762075800;
        insert(&conn, "local", "thread", timestamp, None, "codex_session");
        let local = Local.timestamp_opt(timestamp, 0).single().unwrap();
        let hourly = query_usage_records(
            &conn,
            &UsageRecordFilters::default(),
            UsageRecordView::Hour,
            0,
            10,
            "local",
        )
        .unwrap();
        assert_eq!(
            hourly.data[0].bucket_start_at,
            Some(timestamp - i64::from(local.minute()) * 60 - i64::from(local.second()))
        );
        let daily = query_usage_records(
            &conn,
            &UsageRecordFilters::default(),
            UsageRecordView::Day,
            0,
            10,
            "local",
        )
        .unwrap();
        let start = Local
            .timestamp_opt(daily.data[0].bucket_start_at.unwrap(), 0)
            .single()
            .unwrap();
        let end = Local
            .timestamp_opt(daily.data[0].bucket_end_at.unwrap(), 0)
            .single()
            .unwrap();
        assert_eq!(start.date_naive(), local.date_naive());
        assert_eq!((start.hour(), start.minute(), start.second()), (0, 0, 0));
        assert_eq!(end.ordinal(), start.ordinal() + 1);
        assert_eq!((end.hour(), end.minute(), end.second()), (0, 0, 0));
    }

    #[test]
    fn legacy_daily_counts_are_reported_without_fabricating_session_records() {
        let conn = connection();
        conn.execute_batch("CREATE TABLE usage_daily_rollups(date TEXT,app_type TEXT,provider_id TEXT,model TEXT,pricing_model TEXT,request_count INTEGER); INSERT INTO usage_daily_rollups VALUES('2020-01-01','codex','_codex_session','deepseek','deepseek',12);").unwrap();
        let result = query(&conn, UsageRecordView::Session, 0, 10);
        assert_eq!(result.legacy_rollup_count, 12);
        assert_eq!(result.total, 0);
        assert!(result.data.is_empty());
        let filters = UsageRecordFilters {
            account_id: Some("a".into()),
            ..Default::default()
        };
        assert_eq!(
            query_usage_records(&conn, &filters, UsageRecordView::Session, 0, 10, "UTC")
                .unwrap()
                .legacy_rollup_count,
            0
        );
        let filters = UsageRecordFilters {
            model: Some("other".into()),
            ..Default::default()
        };
        assert_eq!(
            query_usage_records(&conn, &filters, UsageRecordView::Session, 0, 10, "UTC")
                .unwrap()
                .legacy_rollup_count,
            0
        );
    }

    #[test]
    fn records_without_sessions_keep_exact_request_selectors() {
        let conn = connection();
        insert(&conn, "one", "", 1000, None, "codex_session");
        insert(&conn, "two", "", 1000, None, "codex_session");
        let result = query(&conn, UsageRecordView::Session, 0, 10);
        assert_eq!(result.total, 2);
        let ids: BTreeSet<_> = result
            .data
            .iter()
            .map(|group| group.request_id.as_deref().unwrap())
            .collect();
        assert_eq!(ids, BTreeSet::from(["one", "two"]));
    }
}
