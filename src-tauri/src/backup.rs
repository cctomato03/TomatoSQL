//! 数据库备份：把整库导出为 SQL 文件（结构 + 数据），支持列出、恢复、删除。

use crate::db::Conn;
use crate::model::*;
use crate::transfer;
use std::fs;
use std::path::{Path, PathBuf};

fn safe_name(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect()
}

/// 备份目录：<data_dir>/backups/<connId>/
pub fn conn_dir(data_dir: &Path, conn_id: &str) -> PathBuf {
    data_dir.join("backups").join(safe_name(conn_id))
}

pub fn list(dir: &Path) -> Vec<BackupFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<BackupFile> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "sql").unwrap_or(false))
        .map(|e| {
            let meta = e.metadata().ok();
            BackupFile {
                name: e.file_name().to_string_lossy().to_string(),
                path: e.path().to_string_lossy().to_string(),
                size: meta.as_ref().map(|m| m.len() as i64).unwrap_or(0),
                modified_at: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            }
        })
        .collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

/// 新建备份：整库导出为 SQL（含结构 + 数据）
pub async fn create(
    conn: &Conn,
    data_dir: &Path,
    conn_id: &str,
    database: &str,
) -> Result<BackupFile, String> {
    let dir = conn_dir(data_dir, conn_id);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建备份目录：{e}"))?;

    let tables = conn.tables(database).await?;
    let names: Vec<String> = tables
        .iter()
        .filter(|t| t.kind == "table")
        .map(|t| t.name.clone())
        .collect();
    if names.is_empty() {
        return Err("该数据库没有可备份的表".into());
    }

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = format!("{}-{}.sql", safe_name(if database.is_empty() { "main" } else { database }), stamp);
    let path = dir.join(&file_name);

    let req = ExportRequest {
        conn_id: conn_id.to_string(),
        database: database.to_string(),
        tables: names,
        sql: None,
        format: "sql".into(),
        file_path: path.to_string_lossy().to_string(),
        include_header: true,
        delimiter: ",".into(),
        include_structure: true,
        include_data: true,
        null_as: None,
        batch_size: 1000,
        single_file: true,
    };
    transfer::export(conn, &req).await?;

    let meta = fs::metadata(&path).map_err(|e| format!("备份文件读取失败：{e}"))?;
    Ok(BackupFile {
        name: file_name,
        path: path.to_string_lossy().to_string(),
        size: meta.len() as i64,
        modified_at: chrono::Utc::now().timestamp_millis(),
    })
}

/// 用备份文件恢复（执行脚本）
pub async fn restore(conn: &Conn, database: &str, path: &str) -> Result<ImportResult, String> {
    let req = ImportRequest {
        conn_id: String::new(),
        database: database.to_string(),
        table: String::new(),
        format: "sql".into(),
        file_path: path.to_string(),
        has_header: false,
        delimiter: ",".into(),
        truncate_first: false,
        create_table: true,
        on_conflict: "error".into(),
        batch_size: 500,
        empty_as_null: false,
    };
    transfer::import(conn, &req).await
}

pub fn delete(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.extension().map(|x| x != "sql").unwrap_or(true) {
        return Err("只允许删除 .sql 备份文件".into());
    }
    fs::remove_file(p).map_err(|e| format!("删除失败：{e}"))
}
