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

// ---------------- 表级操作 ----------------

#[tauri::command]
pub async fn db_drop_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<(), String> {
    let conn = state.conn(&conn_id)?;
    let sql = format!(
        "DROP TABLE IF EXISTS {}",
        crate::db::qualified(conn.engine(), &database, &table)
    );
    conn.exec_sql(&database, &sql).await?;
    Ok(())
}

/// 清空表：DELETE FROM（保留自增计数，可回滚）
#[tauri::command]
pub async fn db_clear_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<i64, String> {
    let conn = state.conn(&conn_id)?;
    let sql = format!(
        "DELETE FROM {}",
        crate::db::qualified(conn.engine(), &database, &table)
    );
    conn.exec_sql(&database, &sql).await
}

/// 截断表：MySQL 用 TRUNCATE（并重置自增），SQLite 用 DELETE + 重置 sqlite_sequence
#[tauri::command]
pub async fn db_truncate_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<(), String> {
    let conn = state.conn(&conn_id)?;
    let engine = conn.engine();
    let q = crate::db::qualified(engine, &database, &table);
    if engine == "mysql" {
        conn.exec_sql(&database, &format!("TRUNCATE TABLE {q}"))
            .await?;
    } else {
        conn.exec_sql(&database, &format!("DELETE FROM {q}")).await?;
        let _ = conn
            .exec_sql(
                &database,
                &format!(
                    "DELETE FROM sqlite_sequence WHERE name = '{}'",
                    table.replace('\'', "''")
                ),
            )
            .await;
    }
    Ok(())
}

/// 复制表：仅结构 / 结构 + 数据
#[tauri::command]
pub async fn db_copy_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    new_name: String,
    with_data: bool,
) -> Result<(), String> {
    let conn = state.conn(&conn_id)?;
    let engine = conn.engine();
    let safe = safe_ident(new_name.trim());
    if safe.is_empty() {
        return Err("新表名不合法".into());
    }
    if safe == table {
        return Err("新表名不能与原表相同".into());
    }
    let src = crate::db::qualified(engine, &database, &table);
    let dst = crate::db::qualified(engine, &database, &safe);
    let exists = conn
        .tables(&database)
        .await?
        .iter()
        .any(|t| t.name.eq_ignore_ascii_case(&safe));
    if exists {
        return Err(format!("表 {safe} 已存在"));
    }
    if engine == "mysql" {
        conn.exec_sql(&database, &format!("CREATE TABLE {dst} LIKE {src}"))
            .await?;
        if with_data {
            conn.exec_sql(&database, &format!("INSERT INTO {dst} SELECT * FROM {src}"))
                .await?;
        }
    } else {
        let select = if with_data {
            format!("SELECT * FROM {src}")
        } else {
            format!("SELECT * FROM {src} WHERE 1 = 0")
        };
        conn.exec_sql(&database, &format!("CREATE TABLE {dst} AS {select}"))
            .await?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignChange {
    #[serde(default)]
    pub added: Vec<ColumnInfo>,
    #[serde(default)]
    pub dropped: Vec<String>,
    /// 需要修改类型/可空性的列（仅 MySQL 支持）
    #[serde(default)]
    pub modified: Vec<ColumnInfo>,
}

/// 设计表：按差异生成 ALTER TABLE 并执行
#[tauri::command]
pub async fn db_apply_table_design(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    change: DesignChange,
) -> Result<Vec<String>, String> {
    let conn = state.conn(&conn_id)?;
    let engine = conn.engine();
    let mut executed: Vec<String> = Vec::new();

    if change.added.is_empty() && change.dropped.is_empty() && change.modified.is_empty() {
        return Err("没有要应用的修改".into());
    }

    for col in &change.added {
        let sql = crate::db::ddl::add_column(engine, engine, &table, col);
        conn.exec_sql(&database, &sql).await?;
        executed.push(sql);
    }
    for name in &change.dropped {
        let sql = format!(
            "ALTER TABLE {} DROP COLUMN {}",
            crate::db::qualified(engine, &database, &table),
            crate::db::quote_ident(engine, name)
        );
        conn.exec_sql(&database, &sql).await?;
        executed.push(sql);
    }
    if !change.modified.is_empty() {
        if engine == "sqlite" {
            return Err("SQLite 不支持修改已有列的类型/可空性（已完成的增删列已生效）".into());
        }
        for col in &change.modified {
            let ty = if col.data_type.trim().is_empty() { "TEXT".to_string() } else { col.data_type.clone() };
            let mut sql = format!(
                "ALTER TABLE {} MODIFY COLUMN {} {}",
                crate::db::qualified(engine, &database, &table),
                crate::db::quote_ident(engine, &col.name),
                ty
            );
            if !col.nullable {
                sql.push_str(" NOT NULL");
            }
            if let Some(def) = col.default_value.as_ref().filter(|d| !d.is_empty()) {
                sql.push_str(&format!(" DEFAULT {def}"));
            }
            conn.exec_sql(&database, &sql).await?;
            executed.push(sql);
        }
    }
    Ok(executed)
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
