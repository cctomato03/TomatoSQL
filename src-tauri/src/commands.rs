//! 前端可调用的 Tauri 命令。

use crate::db::{AppState, Conn};
use crate::model::*;
use crate::{store, sync, transfer};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn ws_load(app: AppHandle) -> Workspace {
    store::load(&app)
}

#[tauri::command]
pub fn ws_save(app: AppHandle, ws: Workspace) -> Result<(), String> {
    store::save(&app, &ws)
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let dir = store::data_dir(&app)?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn conn_test(cfg: Connection) -> TestResult {
    Conn::test(&cfg).await
}

#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    conn_id: String,
    cfg: Connection,
) -> Result<String, String> {
    state.remove(&conn_id);
    let conn = Conn::connect(&cfg).await?;
    let engine = conn.engine().to_string();
    state.put(&conn_id, conn)?;
    Ok(engine)
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    state.remove(&conn_id);
    Ok(())
}

#[tauri::command]
pub async fn db_is_open(state: State<'_, AppState>, conn_id: String) -> Result<bool, String> {
    Ok(state.is_open(&conn_id))
}

#[tauri::command]
pub async fn db_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    state.conn(&conn_id)?.databases().await
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    state.conn(&conn_id)?.tables(&database).await
}

#[tauri::command]
pub async fn db_columns(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    state.conn(&conn_id)?.columns(&database, &table).await
}

#[tauri::command]
pub async fn db_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    state.conn(&conn_id)?.indexes(&database, &table).await
}

#[tauri::command]
pub async fn db_routines(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<RoutineInfo>, String> {
    state.conn(&conn_id)?.routines(&database).await
}

// ---------------- 数据库级 DDL ----------------

fn safe_ident(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect()
}

#[tauri::command]
pub async fn db_create_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    charset: Option<String>,
) -> Result<(), String> {
    let conn = state.conn(&conn_id)?;
    if conn.engine() == "sqlite" {
        return Err("SQLite 的数据库就是一个文件，请用「新建数据库」选择新文件路径".into());
    }
    let safe = safe_ident(name.trim());
    if safe.is_empty() {
        return Err("数据库名不合法".into());
    }
    let cs: String = charset
        .unwrap_or_else(|| "utf8mb4".into())
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    let cs = if cs.is_empty() { "utf8mb4".to_string() } else { cs };
    let sql = format!(
        "CREATE DATABASE {} CHARACTER SET {}",
        crate::db::quote_ident("mysql", &safe),
        cs
    );
    conn.exec_sql("", &sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn db_drop_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), String> {
    let conn = state.conn(&conn_id)?;
    if conn.engine() == "sqlite" {
        return Err("SQLite 数据库即文件；请删除文件或移除对应连接".into());
    }
    let safe = safe_ident(name.trim());
    if safe.is_empty() {
        return Err("数据库名不合法".into());
    }
    let sql = format!("DROP DATABASE IF EXISTS {}", crate::db::quote_ident("mysql", &safe));
    conn.exec_sql("", &sql).await?;
    Ok(())
}

/// 创建（或确认存在）一个 SQLite 数据库文件
#[tauri::command]
pub fn db_touch_sqlite_file(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    let p = std::path::Path::new(&path);
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录：{e}"))?;
        }
    }
    let conn = rusqlite::Connection::open(p).map_err(|e| format!("无法创建 SQLite 文件：{e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("初始化失败：{e}"))?;
    Ok(())
}

// ---------------- 备份 ----------------

#[tauri::command]
pub fn backup_list(
    app: AppHandle,
    conn_id: String,
    _database: String,
) -> Result<Vec<BackupFile>, String> {
    let dir = store::data_dir(&app)?;
    Ok(crate::backup::list(&crate::backup::conn_dir(&dir, &conn_id)))
}

#[tauri::command]
pub async fn backup_create(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<BackupFile, String> {
    let conn = state.conn(&conn_id)?;
    let dir = store::data_dir(&app)?;
    crate::backup::create(&conn, &dir, &conn_id, &database).await
}

#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    path: String,
) -> Result<ImportResult, String> {
    let conn = state.conn(&conn_id)?;
    crate::backup::restore(&conn, &database, &path).await
}

#[tauri::command]
pub fn backup_delete(path: String) -> Result<(), String> {
    crate::backup::delete(&path)
}

#[tauri::command]
pub fn backup_dir(app: AppHandle, conn_id: String) -> Result<String, String> {
    let dir = store::data_dir(&app)?;
    let path = crate::backup::conn_dir(&dir, &conn_id);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn db_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    state.conn(&conn_id)?.ddl(&database, &table).await
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    sql: String,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    state
        .conn(&conn_id)?
        .query(&database, &sql, max_rows.unwrap_or(5000))
        .await
}

#[tauri::command]
pub async fn db_fetch_rows(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    limit: i64,
    offset: i64,
    where_clause: Option<String>,
    order_by: Option<String>,
) -> Result<RowsPage, String> {
    state
        .conn(&conn_id)?
        .fetch_rows(
            &database,
            &table,
            limit,
            offset,
            where_clause.as_deref(),
            order_by.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn db_row_count(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<i64, String> {
    state.conn(&conn_id)?.row_count(&database, &table).await
}

/// 新增一行：values 为空表示"全默认值"，否则按给定列值插入
#[tauri::command]
pub async fn db_insert_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    values: Vec<PkPair>,
) -> Result<i64, String> {
    let conn = state.conn(&conn_id)?;
    let sql = crate::db::build_insert(conn.engine(), &database, &table, &values);
    let results = conn.query(&database, &sql, 1).await?;
    Ok(results.last().and_then(|r| r.last_insert_id).unwrap_or(0))
}

#[tauri::command]
pub async fn db_apply_changes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    changes: Vec<RowChange>,
) -> Result<ApplyResult, String> {
    let conn = state.conn(&conn_id)?;
    let engine = conn.engine();
    let table_sql = crate::db::qualified(engine, &database, &table);
    let mut result = ApplyResult::default();

    for change in changes {
        let pk_clause = change
            .pk
            .iter()
            .map(|p| {
                format!(
                    "{} {}",
                    crate::db::quote_ident(engine, &p.column),
                    if p.value.is_none() {
                        "IS NULL".to_string()
                    } else {
                        format!("= {}", crate::db::sql_literal(engine, &p.value))
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ");

        let sql = match change.action.as_str() {
            "delete" => format!("DELETE FROM {table_sql} WHERE {pk_clause}"),
            "update" => {
                let sets = change
                    .values
                    .iter()
                    .map(|v| {
                        format!(
                            "{} = {}",
                            crate::db::quote_ident(engine, &v.column),
                            crate::db::sql_literal(engine, &v.value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("UPDATE {table_sql} SET {sets} WHERE {pk_clause}")
            }
            _ => {
                let cols = change
                    .values
                    .iter()
                    .map(|v| crate::db::quote_ident(engine, &v.column))
                    .collect::<Vec<_>>()
                    .join(", ");
                let vals = change
                    .values
                    .iter()
                    .map(|v| crate::db::sql_literal(engine, &v.value))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("INSERT INTO {table_sql} ({cols}) VALUES ({vals})")
            }
        };

        match conn.exec_sql(&database, &sql).await {
            Ok(_) => result.applied += 1,
            Err(e) => {
                if result.errors.len() < 20 {
                    result.errors.push(format!("{sql} → {e}"));
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn export_data(
    state: State<'_, AppState>,
    req: ExportRequest,
) -> Result<ExportResult, String> {
    let conn = state.conn(&req.conn_id)?;
    transfer::export(&conn, &req).await
}

#[tauri::command]
pub async fn import_data(
    state: State<'_, AppState>,
    req: ImportRequest,
) -> Result<ImportResult, String> {
    let conn = state.conn(&req.conn_id)?;
    transfer::import(&conn, &req).await
}

#[tauri::command]
pub async fn db_compare(
    state: State<'_, AppState>,
    req: CompareRequest,
) -> Result<CompareReport, String> {
    let src = state.conn(&req.source_conn)?;
    let dst = state.conn(&req.target_conn)?;
    sync::compare(
        &src,
        &req.source_db,
        &dst,
        &req.target_db,
        &req.tables,
        req.compare_data,
    )
    .await
}

#[tauri::command]
pub async fn db_apply_sync(
    state: State<'_, AppState>,
    req: SyncRequest,
) -> Result<SyncResult, String> {
    let src = state.conn(&req.source_conn)?;
    let dst = state.conn(&req.target_conn)?;
    sync::apply(&src, &req.source_db, &dst, &req.target_db, &req).await
}
