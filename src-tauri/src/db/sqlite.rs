//! SQLite 驱动实现（rusqlite，bundled 编译）

use crate::db::fmt_float;
use crate::model::*;
use rusqlite::types::ValueRef as SqValue;
use rusqlite::{Connection, OpenFlags};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type SqliteHandle = Arc<Mutex<Connection>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

async fn run<T, F>(conn: SqliteHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let guard = conn.lock().map_err(|e| e.to_string())?;
        f(&guard)
    })
    .await
    .map_err(|e| format!("执行线程异常: {e}"))?
}

pub fn open(path: &str, read_only: bool) -> Result<SqliteHandle, String> {
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    };
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("无法打开 SQLite 文件（{path}）：{e}"))?;
    conn.busy_timeout(Duration::from_secs(15)).map_err(err)?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn value_to_cell(v: &SqValue<'_>) -> Cell {
    Some(match v {
        SqValue::Null => return None,
        SqValue::Integer(i) => i.to_string(),
        SqValue::Real(f) => fmt_float(*f),
        SqValue::Text(s) => String::from_utf8_lossy(s).to_string(),
        SqValue::Blob(b) => match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => b.iter().map(|x| format!("{x:02x}")).collect::<String>(),
        },
    })
}

pub async fn server_version(conn: SqliteHandle) -> Result<String, String> {
    run(conn, |c| {
        let v: String = c
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .map_err(err)?;
        Ok(format!("SQLite {v}"))
    })
    .await
}

pub async fn databases(conn: SqliteHandle) -> Result<Vec<String>, String> {
    run(conn, |c| {
        let mut stmt = c.prepare("PRAGMA database_list").map_err(err)?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .filter_map(|x| x.ok())
            .collect::<Vec<_>>();
        Ok(if names.is_empty() { vec!["main".into()] } else { names })
    })
    .await
}

pub async fn tables(conn: SqliteHandle, db: &str) -> Result<Vec<TableInfo>, String> {
    let prefix = if db.is_empty() || db == "main" {
        "main".to_string()
    } else {
        format!("\"{}\"", db.replace('"', "\"\""))
    };
    run(conn, move |c| {
        let sql = format!(
            "SELECT name, type FROM {prefix}.sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        let mut stmt = c.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TableInfo {
                    name: r.get::<_, String>(0)?,
                    kind: r.get::<_, String>(1)?,
                    rows: None,
                    comment: None,
                })
            })
            .map_err(err)?
            .filter_map(|x| x.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .await
}

pub async fn columns(conn: SqliteHandle, _db: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let table = table.to_string();
    run(conn, move |c| {
        let sql = format!("PRAGMA table_info({})", crate::db::quote_ident("sqlite", &table));
        let mut stmt = c.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                let notnull: i64 = r.get(3)?;
                let pk: i64 = r.get(5)?;
                Ok(ColumnInfo {
                    name: r.get::<_, String>(1)?,
                    data_type: r.get::<_, String>(2).unwrap_or_default(),
                    nullable: notnull == 0,
                    key: if pk > 0 { "PRI".into() } else { String::new() },
                    default_value: r.get::<_, Option<String>>(4).unwrap_or(None),
                    extra: String::new(),
                    comment: None,
                    position: r.get::<_, i64>(0).unwrap_or(0) + 1,
                    length: None,
                })
            })
            .map_err(err)?
            .filter_map(|x| x.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .await
}

pub async fn indexes(conn: SqliteHandle, _db: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let table = table.to_string();
    run(conn, move |c| {
        let list_sql = format!("PRAGMA index_list({})", crate::db::quote_ident("sqlite", &table));
        let mut stmt = c.prepare(&list_sql).map_err(err)?;
        let base = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2).unwrap_or(0) == 1,
                    r.get::<_, Option<String>>(3).unwrap_or(None),
                ))
            })
            .map_err(err)?
            .filter_map(|x| x.ok())
            .collect::<Vec<(String, bool, Option<String>)>>();
        drop(stmt);

        let mut out = Vec::new();
        for (name, unique, origin) in base {
            let info_sql = format!("PRAGMA index_info({})", crate::db::quote_ident("sqlite", &name));
            let mut s2 = c.prepare(&info_sql).map_err(err)?;
            let cols = s2
                .query_map([], |r| r.get::<_, Option<String>>(2))
                .map_err(err)?
                .filter_map(|x| x.ok().flatten())
                .collect::<Vec<String>>();
            out.push(IndexInfo {
                primary: origin.as_deref() == Some("pk"),
                name,
                columns: cols,
                unique,
            });
        }

        // INTEGER PRIMARY KEY（rowid 别名）不会出现在 index_list 中，需要补一条主键信息
        if !out.iter().any(|i| i.primary) {
            let pragma = format!("PRAGMA table_info({})", crate::db::quote_ident("sqlite", &table));
            let mut stmt2 = c.prepare(&pragma).map_err(err)?;
            let mut pk_cols = stmt2
                .query_map([], |r| {
                    let pk: i64 = r.get(5).unwrap_or(0);
                    let name: String = r.get(1)?;
                    Ok((pk, name))
                })
                .map_err(err)?
                .filter_map(|x| x.ok())
                .filter(|(pk, _)| *pk > 0)
                .collect::<Vec<(i64, String)>>();
            pk_cols.sort_by_key(|(pk, _)| *pk);
            if !pk_cols.is_empty() {
                out.push(IndexInfo {
                    name: "PRIMARY".into(),
                    columns: pk_cols.into_iter().map(|(_, n)| n).collect(),
                    unique: true,
                    primary: true,
                });
            }
        }
        Ok(out)
    })
    .await
}

pub async fn ddl(conn: SqliteHandle, _db: &str, table: &str) -> Result<String, String> {
    let table = table.to_string();
    run(conn, move |c| {
        let sql: Option<String> = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = ?1",
                (table.as_str(),),
                |r| r.get(0),
            )
            .ok();
        Ok(sql.unwrap_or_else(|| "-- 无法获取建表语句".into()))
    })
    .await
}

pub async fn row_count(conn: SqliteHandle, _db: &str, table: &str) -> Result<i64, String> {
    let table = table.to_string();
    run(conn, move |c| {
        let sql = format!(
            "SELECT COUNT(*) FROM {}",
            crate::db::quote_ident("sqlite", &table)
        );
        let v: i64 = c.query_row(&sql, [], |r| r.get(0)).map_err(err)?;
        Ok(v)
    })
    .await
}

pub async fn query(
    conn: SqliteHandle,
    _db: &str,
    sql: &str,
    max_rows: usize,
) -> Result<Vec<QueryResult>, String> {
    let statements = if sql.trim().is_empty() {
        Vec::new()
    } else {
        crate::db::split_statements(sql)
    };
    let mut out = Vec::new();
    for stmt in statements {
        let started = Instant::now();
        let stmt_owned = stmt.clone();
        let res = run(conn.clone(), move |c| exec_one(c, &stmt_owned, max_rows)).await;
        match res {
            Ok(mut r) => {
                r.duration_ms = started.elapsed().as_millis() as u64;
                out.push(r);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

fn exec_one(c: &Connection, sql: &str, max_rows: usize) -> Result<QueryResult, String> {
    let mut stmt = c
        .prepare(sql)
        .map_err(|e| format!("SQL 解析失败：{e}\n语句：{sql}"))?;
    let ncols = stmt.column_count();
    if ncols == 0 {
        let affected = c.execute(sql, []).map_err(|e| format!("执行失败：{e}"))?;
        return Ok(QueryResult {
            statement: sql.chars().take(400).collect(),
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: affected as i64,
            last_insert_id: Some(c.last_insert_rowid()),
            duration_ms: 0,
            message: format!("影响 {affected} 行"),
            truncated: false,
        });
    }
    let mut names: Vec<ColumnMeta> = Vec::with_capacity(ncols);
    for i in 0..ncols {
        names.push(ColumnMeta {
            name: stmt.column_name(i).unwrap_or("?").to_string(),
            data_type: String::new(),
        });
    }
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut cursor = stmt.query([]).map_err(|e| format!("执行失败：{e}"))?;
    while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
        if max_rows > 0 && rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let mut cells: Row = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v = row.get_ref(i).map_err(|e| e.to_string())?;
            cells.push(value_to_cell(&v));
        }
        rows.push(cells);
    }
    Ok(QueryResult {
        statement: sql.chars().take(400).collect(),
        columns: names,
        message: format!("{} 行", rows.len()),
        rows,
        rows_affected: 0,
        last_insert_id: None,
        duration_ms: 0,
        truncated,
    })
}
