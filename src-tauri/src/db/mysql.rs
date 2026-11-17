//! MySQL 驱动实现（mysql_async）

use crate::db::{fmt_float, quote_ident, returns_rows, split_statements};
use crate::model::*;
use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, Row as MyRow, SslOpts, Value as MyValue};
use std::time::Instant;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub async fn open(cfg: &Connection) -> Result<Pool, String> {
    let host = cfg.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let user = cfg.user.clone().unwrap_or_else(|| "root".into());
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(cfg.port.unwrap_or(3306))
        .user(Some(user))
        .pass(cfg.password.clone())
        .prefer_socket(false)
        .stmt_cache_size(128)
        .wait_timeout(Some(28_800));

    if let Some(db) = cfg.database.as_ref().filter(|d| !d.trim().is_empty()) {
        builder = builder.db_name(Some(db.clone()));
    }
    let ssl_enabled = matches!(
        cfg.ssl_mode.as_deref(),
        Some("required") | Some("require") | Some("verify") | Some("preferred")
    );
    if ssl_enabled {
        builder = builder.ssl_opts(Some(
            SslOpts::default().with_danger_skip_domain_validation(true),
        ));
    }
    let opts: Opts = builder.into();
    let pool = Pool::new(opts);
    let mut conn = pool.get_conn().await.map_err(|e| {
        format!(
            "无法连接到 MySQL（{}:{}）：{}",
            cfg.host.clone().unwrap_or_default(),
            cfg.port.unwrap_or(3306),
            e
        )
    })?;
    if let Some(cs) = cfg.charset.as_ref().filter(|c| !c.trim().is_empty()) {
        let safe: String = cs.chars().filter(|c| c.is_alphanumeric()).collect();
        let _ = conn.query_drop(format!("SET NAMES {safe}")).await;
    }
    conn.ping().await.map_err(err)?;
    drop(conn);
    Ok(pool)
}

pub async fn server_version(pool: &Pool) -> Result<String, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let v: Option<String> = conn.query_first("SELECT VERSION()").await.map_err(err)?;
    Ok(v.unwrap_or_default())
}

fn fmt_date(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8, us: u32) -> String {
    if us > 0 {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
    } else if h == 0 && mi == 0 && s == 0 {
        format!("{y:04}-{mo:02}-{d:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
    }
}

fn fmt_time(neg: bool, days: u32, h: u8, mi: u8, s: u8, us: u32) -> String {
    let sign = if neg { "-" } else { "" };
    let base = if days > 0 {
        format!("{sign}{days} {h:02}:{mi:02}:{s:02}")
    } else {
        format!("{sign}{h:02}:{mi:02}:{s:02}")
    };
    if us > 0 {
        format!("{base}.{us:06}")
    } else {
        base
    }
}

pub fn value_to_cell(v: &MyValue) -> Cell {
    Some(match v {
        MyValue::NULL => return None,
        MyValue::Bytes(b) => match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => b.iter().map(|x| format!("{x:02x}")).collect::<String>(),
        },
        MyValue::Int(i) => i.to_string(),
        MyValue::UInt(u) => u.to_string(),
        MyValue::Float(f) => fmt_float(*f as f64),
        MyValue::Double(d) => fmt_float(*d),
        MyValue::Date(y, mo, d, h, mi, s, us) => fmt_date(*y, *mo, *d, *h, *mi, *s, *us),
        MyValue::Time(neg, days, h, mi, s, us) => fmt_time(*neg, *days, *h, *mi, *s, *us),
    })
}

fn row_to_cells(row: MyRow) -> Row {
    row.unwrap().iter().map(value_to_cell).collect()
}

fn get(row: &MyRow, i: usize) -> Cell {
    row.as_ref(i).and_then(value_to_cell)
}

fn get_i64(row: &MyRow, i: usize) -> i64 {
    get(row, i)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

pub async fn databases(pool: &Pool) -> Result<Vec<String>, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let rows: Vec<MyRow> = conn.query("SHOW DATABASES").await.map_err(err)?;
    let mut out: Vec<String> = rows
        .iter()
        .filter_map(|r| get(r, 0))
        .filter(|n| n != "performance_schema" && n != "sys")
        .collect();
    out.sort_by(|a, b| {
        let sys = |s: &str| matches!(s, "information_schema" | "mysql");
        sys(a).cmp(&sys(b)).then(a.cmp(b))
    });
    Ok(out)
}

pub async fn tables(pool: &Pool, db: &str) -> Result<Vec<TableInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let sql = "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT \
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";
    let rows: Vec<MyRow> = conn.exec(sql, (db,)).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            name: get(r, 0).unwrap_or_default(),
            kind: match get(r, 1).as_deref() {
                Some(t) if t.contains("VIEW") => "view".into(),
                _ => "table".into(),
            },
            rows: get(r, 2).and_then(|v| v.parse::<i64>().ok()),
            comment: get(r, 3).filter(|c| !c.is_empty()),
        })
        .collect())
}

pub async fn columns(pool: &Pool, db: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let sql = "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, \
               COLUMN_COMMENT, ORDINAL_POSITION, CHARACTER_MAXIMUM_LENGTH \
               FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               ORDER BY ORDINAL_POSITION";
    let rows: Vec<MyRow> = conn.exec(sql, (db, table)).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: get(r, 0).unwrap_or_default(),
            data_type: get(r, 1).unwrap_or_default(),
            nullable: get(r, 2).as_deref() == Some("YES"),
            key: get(r, 3).unwrap_or_default(),
            default_value: get(r, 4),
            extra: get(r, 5).unwrap_or_default(),
            comment: get(r, 6),
            position: get_i64(r, 7),
            length: get(r, 8).and_then(|v| v.parse::<i64>().ok()),
        })
        .collect())
}

pub async fn indexes(pool: &Pool, db: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let sql = "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
               FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               ORDER BY INDEX_NAME, SEQ_IN_INDEX";
    let rows: Vec<MyRow> = conn.exec(sql, (db, table)).await.map_err(err)?;
    let mut out: Vec<IndexInfo> = Vec::new();
    for r in rows.iter() {
        let name = get(r, 0).unwrap_or_default();
        let col = get(r, 1).unwrap_or_default();
        let non_unique = get_i64(r, 2) != 0;
        match out.iter_mut().find(|i| i.name == name) {
            Some(idx) => idx.columns.push(col),
            None => out.push(IndexInfo {
                primary: name == "PRIMARY",
                name,
                columns: vec![col],
                unique: !non_unique,
            }),
        }
    }
    Ok(out)
}

pub async fn ddl(pool: &Pool, db: &str, table: &str) -> Result<String, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let sql = format!("SHOW CREATE TABLE {}", crate::db::qualified("mysql", db, table));
    let row: Option<MyRow> = conn.query_first(sql).await.map_err(err)?;
    Ok(row
        .as_ref()
        .and_then(|r| get(r, 1))
        .unwrap_or_else(|| "-- 无法获取建表语句".into()))
}

pub async fn row_count(pool: &Pool, db: &str, table: &str) -> Result<i64, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    let sql = format!(
        "SELECT COUNT(*) FROM {}",
        crate::db::qualified("mysql", db, table)
    );
    let v: Option<i64> = conn.query_first(sql).await.map_err(err)?;
    Ok(v.unwrap_or(0))
}

pub async fn query(
    pool: &Pool,
    db: &str,
    sql: &str,
    max_rows: usize,
) -> Result<Vec<QueryResult>, String> {
    let mut conn = pool.get_conn().await.map_err(err)?;
    if !db.trim().is_empty() {
        let use_sql = format!("USE {}", quote_ident("mysql", db));
        if let Err(e) = conn.query_drop(&use_sql).await {
            return Err(format!("切换数据库失败（{db}）：{e}"));
        }
    }
    let statements = if sql.trim().is_empty() {
        Vec::new()
    } else {
        split_statements(sql)
    };
    let mut out = Vec::new();
    for stmt in statements {
        let started = Instant::now();
        let has_rows = returns_rows(&stmt);
        let mut res = conn.query_iter(stmt.as_str()).await.map_err(|e| {
            format!(
                "执行失败：{e}\n语句：{}",
                stmt.chars().take(300).collect::<String>()
            )
        })?;
        let mut columns: Vec<ColumnMeta> = Vec::new();
        if let Some(cols) = res.columns() {
            columns = cols
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name_str().to_string(),
                    data_type: format!("{:?}", c.column_type()),
                })
                .collect();
        }
        let mut rows: Vec<MyRow> = res.collect().await.map_err(err)?;
        let affected = res.affected_rows() as i64;
        let last_id = res.last_insert_id().map(|v| v as i64);
        let truncated = max_rows > 0 && rows.len() > max_rows;
        if truncated {
            rows.truncate(max_rows);
        }
        let data: Vec<Row> = rows.into_iter().map(row_to_cells).collect();
        if columns.is_empty() && !data.is_empty() {
            columns = (0..data[0].len())
                .map(|i| ColumnMeta {
                    name: format!("col{}", i + 1),
                    data_type: String::new(),
                })
                .collect();
        }
        let message = if has_rows && !data.is_empty() {
            format!("{} 行", data.len())
        } else {
            format!("影响 {affected} 行")
        };
        out.push(QueryResult {
            statement: stmt.chars().take(400).collect(),
            columns,
            rows: data,
            rows_affected: affected,
            last_insert_id: last_id,
            duration_ms: started.elapsed().as_millis() as u64,
            message,
            truncated,
        });
    }
    Ok(out)
}
