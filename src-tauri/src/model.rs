use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 数据库连接配置（内存模型；落盘时密码字段会被加密）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// mysql | sqlite
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    /// 明文仅存在于内存与 IPC；落盘时由 store 层加密
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// sqlite 文件路径
    #[serde(default)]
    pub file: Option<String>,
    /// 默认数据库 / schema
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_kind() -> String {
    "mysql".to_string()
}

impl Default for Connection {
    fn default() -> Self {
        let ts = now_ms();
        Self {
            id: new_id(),
            name: String::new(),
            kind: default_kind(),
            group_id: None,
            host: Some("127.0.0.1".into()),
            port: Some(3306),
            user: Some("root".into()),
            password: None,
            charset: Some("utf8mb4".into()),
            ssl_mode: Some("disabled".into()),
            file: None,
            database: None,
            read_only: false,
            color: None,
            created_at: ts,
            updated_at: ts,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub order: i64,
    #[serde(default = "default_true")]
    pub expanded: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme_id: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: f64,
    #[serde(default = "default_row_height")]
    pub row_height: f64,
    #[serde(default = "default_page_size")]
    pub page_size: i64,
    #[serde(default = "default_true")]
    pub confirm_destructive: bool,
    #[serde(default = "default_true")]
    pub show_line_numbers: bool,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub cloud: CloudSettings,
}

fn default_theme() -> String {
    "tomato-light".into()
}
fn default_font_size() -> f64 {
    13.0
}
fn default_editor_font_size() -> f64 {
    13.0
}
fn default_row_height() -> f64 {
    26.0
}
fn default_page_size() -> i64 {
    500
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme_id: default_theme(),
            font_size: default_font_size(),
            editor_font_size: default_editor_font_size(),
            row_height: default_row_height(),
            page_size: default_page_size(),
            confirm_destructive: true,
            show_line_numbers: true,
            language: "zh".into(),
            cloud: CloudSettings::default(),
        }
    }
}

/// 云同步配置：仅保存服务器地址与账号；同步口令不落盘（可选用 remember 保存加密口令）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub username: String,
    /// 云端 token（落盘时同样加密）
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    #[serde(default)]
    pub auto_push: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default = "default_version")]
    pub version: i64,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_version() -> i64 {
    1
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: 1,
            groups: Vec::new(),
            connections: Vec::new(),
            settings: Settings::default(),
            updated_at: now_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub version: Option<String>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// table | view
    pub kind: String,
    pub rows: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub default_value: Option<String>,
    pub extra: String,
    pub comment: Option<String>,
    pub position: i64,
    pub length: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

pub type Cell = Option<String>;
pub type Row = Vec<Cell>;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub statement: String,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Row>,
    pub rows_affected: i64,
    pub last_insert_id: Option<i64>,
    pub duration_ms: u64,
    pub message: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RowsPage {
    pub columns: Vec<ColumnMeta>,
    pub primary_key: Vec<String>,
    pub rows: Vec<Row>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkPair {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChange {
    /// update | insert | delete
    pub action: String,
    #[serde(default)]
    pub pk: Vec<PkPair>,
    #[serde(default)]
    pub values: Vec<PkPair>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: i64,
    pub errors: Vec<String>,
}

// ---------- 导入导出 ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub conn_id: String,
    pub database: String,
    /// 导出表名列表（与 sql 二选一）
    #[serde(default)]
    pub tables: Vec<String>,
    /// 直接导出查询结果
    #[serde(default)]
    pub sql: Option<String>,
    /// csv | json | sql
    pub format: String,
    pub file_path: String,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default = "default_delim")]
    pub delimiter: String,
    #[serde(default)]
    pub include_structure: bool,
    #[serde(default)]
    pub null_as: Option<String>,
    #[serde(default = "default_batch")]
    pub batch_size: i64,
}

fn default_delim() -> String {
    ",".into()
}
fn default_batch() -> i64 {
    1000
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows: i64,
    pub tables: i64,
    pub bytes: i64,
    pub file_path: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub conn_id: String,
    pub database: String,
    pub table: String,
    /// csv | json | sql
    pub format: String,
    pub file_path: String,
    #[serde(default = "default_true")]
    pub has_header: bool,
    #[serde(default = "default_delim")]
    pub delimiter: String,
    #[serde(default)]
    pub truncate_first: bool,
    #[serde(default)]
    pub create_table: bool,
    /// error | ignore
    #[serde(default = "default_on_error")]
    pub on_conflict: String,
    #[serde(default = "default_batch")]
    pub batch_size: i64,
    #[serde(default)]
    pub empty_as_null: bool,
}

fn default_on_error() -> String {
    "error".into()
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub inserted: i64,
    pub skipped: i64,
    pub failed: i64,
    pub errors: Vec<String>,
    pub duration_ms: u64,
    pub table: String,
}

// ---------- 结构比较 / 同步 ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequest {
    pub source_conn: String,
    pub source_db: String,
    pub target_conn: String,
    pub target_db: String,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub compare_data: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    /// missingInTarget | missingInSource | typeMismatch | ok
    pub status: String,
    pub source_type: String,
    pub target_type: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub name: String,
    /// onlySource | onlyTarget | both | same
    pub status: String,
    pub columns: Vec<ColumnDiff>,
    pub indexes: Vec<IndexDiff>,
    pub source_rows: i64,
    pub target_rows: i64,
    pub has_structure_change: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareReport {
    pub tables: Vec<TableDiff>,
    pub source_conn: String,
    pub target_conn: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub source_conn: String,
    pub source_db: String,
    pub target_conn: String,
    pub target_db: String,
    #[serde(default)]
    pub tables: Vec<String>,
    /// 创建缺失表
    #[serde(default = "default_true")]
    pub create_tables: bool,
    /// 添加缺失列
    #[serde(default = "default_true")]
    pub add_columns: bool,
    /// 创建缺失索引
    #[serde(default = "default_true")]
    pub create_indexes: bool,
    /// 复制数据（目标表已有数据时先清空）
    #[serde(default)]
    pub copy_data: bool,
    #[serde(default)]
    pub truncate_target: bool,
    #[serde(default)]
    pub drop_target_tables: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    pub table: String,
    pub sql: String,
    pub ok: bool,
    pub message: String,
    pub rows: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub steps: Vec<SyncStep>,
    pub succeeded: i64,
    pub failed: i64,
    pub duration_ms: u64,
}
