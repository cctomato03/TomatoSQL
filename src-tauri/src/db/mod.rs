//! 数据库连接与会话管理：MySQL 使用 mysql_async 连接池，SQLite 使用 rusqlite（阻塞调用放入阻塞线程池）。

pub mod ddl;
pub mod mysql;
pub mod sqlite;

use crate::model::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub enum Conn {
    MySql(Arc<mysql_async::Pool>),
    Sqlite(Arc<Mutex<rusqlite::Connection>>),
}

#[derive(Default)]
pub struct AppState {
    pub conns: Mutex<HashMap<String, Conn>>,
}

impl AppState {
    pub fn conn(&self, conn_id: &str) -> Result<Conn, String> {
        self.conns
            .lock()
            .map_err(|e| e.to_string())?
            .get(conn_id)
            .cloned()
            .ok_or_else(|| "连接尚未打开，请先点击连接".to_string())
    }

    #[allow(dead_code)]
    pub fn mysql(&self, conn_id: &str) -> Result<Arc<mysql_async::Pool>, String> {
        let guard = self.conns.lock().map_err(|e| e.to_string())?;
        match guard.get(conn_id) {
            Some(Conn::MySql(pool)) => Ok(pool.clone()),
            Some(_) => Err("连接类型不匹配".into()),
            None => Err("连接未打开，请先连接".into()),
        }
    }

    #[allow(dead_code)]
    pub fn sqlite(
        &self,
        conn_id: &str,
    ) -> Result<Arc<Mutex<rusqlite::Connection>>, String> {
        let guard = self.conns.lock().map_err(|e| e.to_string())?;
        match guard.get(conn_id) {
            Some(Conn::Sqlite(conn)) => Ok(conn.clone()),
            Some(_) => Err("连接类型不匹配".into()),
            None => Err("连接未打开，请先连接".into()),
        }
    }

    pub fn put(&self, conn_id: &str, conn: Conn) -> Result<(), String> {
        let mut guard = self.conns.lock().map_err(|e| e.to_string())?;
        guard.insert(conn_id.to_string(), conn);
        Ok(())
    }

    pub fn remove(&self, conn_id: &str) -> bool {
        self.conns
            .lock()
            .map(|mut g| g.remove(conn_id).is_some())
            .unwrap_or(false)
    }

    pub fn is_open(&self, conn_id: &str) -> bool {
        self.conns
            .lock()
            .map(|g| g.contains_key(conn_id))
            .unwrap_or(false)
    }
}

/// 按引擎分派：让上层逻辑复用同一套接口
impl Conn {
    pub fn engine(&self) -> &'static str {
        match self {
            Conn::MySql(_) => "mysql",
            Conn::Sqlite(_) => "sqlite",
        }
    }

    pub async fn databases(&self) -> Result<Vec<String>, String> {
        match self {
            Conn::MySql(pool) => mysql::databases(pool).await,
            Conn::Sqlite(conn) => sqlite::databases(conn.clone()).await,
        }
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<TableInfo>, String> {
        match self {
            Conn::MySql(pool) => mysql::tables(pool, db).await,
            Conn::Sqlite(conn) => sqlite::tables(conn.clone(), db).await,
        }
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
        match self {
            Conn::MySql(pool) => mysql::columns(pool, db, table).await,
            Conn::Sqlite(conn) => sqlite::columns(conn.clone(), db, table).await,
        }
    }

    pub async fn indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
        match self {
            Conn::MySql(pool) => mysql::indexes(pool, db, table).await,
            Conn::Sqlite(conn) => sqlite::indexes(conn.clone(), db, table).await,
        }
    }

    pub async fn routines(&self, db: &str) -> Result<Vec<RoutineInfo>, String> {
        match self {
            Conn::MySql(pool) => mysql::routines(pool, db).await,
            Conn::Sqlite(conn) => sqlite::routines(conn.clone(), db).await,
        }
    }

    pub async fn ddl(&self, db: &str, table: &str) -> Result<String, String> {        match self {
            Conn::MySql(pool) => mysql::ddl(pool, db, table).await,
            Conn::Sqlite(conn) => sqlite::ddl(conn.clone(), db, table).await,
        }
    }

    pub async fn query(
        &self,
        db: &str,
        sql: &str,
        max_rows: usize,
    ) -> Result<Vec<QueryResult>, String> {
        match self {
            Conn::MySql(pool) => mysql::query(pool, db, sql, max_rows).await,
            Conn::Sqlite(conn) => sqlite::query(conn.clone(), db, sql, max_rows).await,
        }
    }

    pub async fn row_count(&self, db: &str, table: &str) -> Result<i64, String> {
        match self {
            Conn::MySql(pool) => mysql::row_count(pool, db, table).await,
            Conn::Sqlite(conn) => sqlite::row_count(conn.clone(), db, table).await,
        }
    }

    /// 执行单条语句（导入/同步内部使用）
    pub async fn exec_sql(&self, db: &str, sql: &str) -> Result<i64, String> {
        let results = self.query(db, sql, 0).await?;
        Ok(results
            .last()
            .map(|r| {
                if r.rows_affected > 0 {
                    r.rows_affected
                } else {
                    r.rows.len() as i64
                }
            })
            .unwrap_or(0))
    }

    /// 分块读取整表 / 指定列
    pub async fn select_columns(
        &self,
        db: &str,
        table: &str,
        cols: &[String],
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Row>, String> {
        let engine = self.engine();
        let col_list = if cols.is_empty() {
            "*".to_string()
        } else {
            cols.iter()
                .map(|c| quote_ident(engine, c))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let sql = format!(
            "SELECT {} FROM {} LIMIT {} OFFSET {}",
            col_list,
            qualified(engine, db, table),
            limit,
            offset.max(0)
        );
        let mut results = self.query(db, &sql, 0).await?;
        if results.is_empty() {
            return Ok(Vec::new());
        }
        Ok(results.remove(0).rows)
    }

    /// 分页读取表数据
    pub async fn fetch_rows(
        &self,
        db: &str,
        table: &str,
        limit: i64,
        offset: i64,
        where_clause: Option<&str>,
        order_by: Option<&str>,
    ) -> Result<RowsPage, String> {
        let started = std::time::Instant::now();
        let engine = self.engine();
        let full = qualified(engine, db, table);
        let mut sql = format!("SELECT * FROM {full}");
        if let Some(w) = where_clause.filter(|w| !w.trim().is_empty()) {
            sql.push_str(&format!(" WHERE {w}"));
        }
        if let Some(o) = order_by.filter(|o| !o.trim().is_empty()) {
            sql.push_str(&format!(" ORDER BY {o}"));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset.max(0)));
        let mut results = self.query(db, &sql, 0).await?;
        let first = if results.is_empty() {
            QueryResult::default()
        } else {
            results.remove(0)
        };

        let mut count_sql = format!("SELECT COUNT(*) AS total FROM {full}");
        if let Some(w) = where_clause.filter(|w| !w.trim().is_empty()) {
            count_sql.push_str(&format!(" WHERE {w}"));
        }
        let total = match self.query(db, &count_sql, 0).await {
            Ok(mut r) if !r.is_empty() => r
                .remove(0)
                .rows
                .first()
                .and_then(|row| row.first().cloned().flatten())
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0),
            _ => 0,
        };
        let primary_key = self.primary_key(db, table).await.unwrap_or_default();
        Ok(RowsPage {
            columns: first.columns,
            primary_key,
            rows: first.rows,
            total,
            limit,
            offset,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// 批量插入（字面量拼接，跨引擎通用）
    pub async fn insert_rows(
        &self,
        db: &str,
        table: &str,
        cols: &[String],
        rows: &[Row],
        ignore_dup: bool,
    ) -> Result<i64, String> {
        if rows.is_empty() {
            return Ok(0);
        }
        let engine = self.engine();
        let col_list = cols
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_sql = qualified(engine, db, table);
        let prefix = if engine == "mysql" {
            if ignore_dup {
                format!("INSERT IGNORE INTO {table_sql} ({col_list}) VALUES ")
            } else {
                format!("INSERT INTO {table_sql} ({col_list}) VALUES ")
            }
        } else if ignore_dup {
            format!("INSERT OR IGNORE INTO {table_sql} ({col_list}) VALUES ")
        } else {
            format!("INSERT INTO {table_sql} ({col_list}) VALUES ")
        };
        let mut inserted = 0i64;
        for chunk in rows.chunks(200) {
            let values = chunk
                .iter()
                .map(|row| {
                    let cells = row
                        .iter()
                        .map(|c| sql_literal(engine, c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({cells})")
                })
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("{prefix}{values}");
            let affected = self.exec_sql(db, &sql).await?;
            inserted += if affected > 0 { affected } else { chunk.len() as i64 };
        }
        Ok(inserted)
    }

    /// 主键列
    pub async fn primary_key(&self, db: &str, table: &str) -> Result<Vec<String>, String> {
        let cols = self.columns(db, table).await?;
        Ok(cols
            .into_iter()
            .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
            .map(|c| c.name)
            .collect())
    }

    /// 打开连接
    pub async fn connect(cfg: &Connection) -> Result<Conn, String> {
        if cfg.kind == "sqlite" {
            let path = cfg
                .file
                .clone()
                .filter(|p| !p.trim().is_empty())
                .ok_or("SQLite 连接缺少数据库文件路径")?;
            sqlite::open(&path, cfg.read_only).map(Conn::Sqlite)
        } else {
            mysql::open(cfg).await.map(|p| Conn::MySql(Arc::new(p)))
        }
    }

    /// 测试连接
    pub async fn test(cfg: &Connection) -> TestResult {
        let started = std::time::Instant::now();
        match Self::connect(cfg).await {
            Ok(conn) => {
                let version = match &conn {
                    Conn::MySql(pool) => mysql::server_version(pool).await.ok(),
                    Conn::Sqlite(conn) => sqlite::server_version(conn.clone()).await.ok(),
                };
                TestResult {
                    ok: true,
                    message: "连接成功".into(),
                    version,
                    latency_ms: started.elapsed().as_millis() as u64,
                }
            }
            Err(err) => TestResult {
                ok: false,
                message: err,
                version: None,
                latency_ms: started.elapsed().as_millis() as u64,
            },
        }
    }
}

/// 拆分 SQL 脚本为单条语句（处理字符串、反引号、注释）
pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    let n = bytes.len();
    let mut quote: Option<char> = None;
    while i < n {
        let c = bytes[i];
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && q != '`' && i + 1 < n {
                // 转义字符：整体跳过
                cur.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                // 处理 '' 或 "" 重复转义
                if i + 1 < n && bytes[i + 1] == q {
                    cur.push(q);
                    i += 2;
                    continue;
                }
                quote = None;
            }
            i += 1;
            continue;
        }
        // 注释
        if c == '-' && i + 1 < n && bytes[i + 1] == '-' {
            while i < n && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '#' {
            while i < n && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && bytes[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            quote = Some(c);
            cur.push(c);
            i += 1;
            continue;
        }
        if c == ';' {
            let t = cur.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    let t = cur.trim().to_string();
    if !t.is_empty() {
        out.push(t);
    }
    out
}

/// 生成 INSERT 语句：values 为空时插入一行全默认值
pub fn build_insert(engine: &str, db: &str, table: &str, values: &[PkPair]) -> String {
    let table_sql = qualified(engine, db, table);
    if values.is_empty() {
        return if engine == "mysql" {
            format!("INSERT INTO {table_sql} () VALUES ()")
        } else {
            format!("INSERT INTO {table_sql} DEFAULT VALUES")
        };
    }
    let cols = values
        .iter()
        .map(|v| quote_ident(engine, &v.column))
        .collect::<Vec<_>>()
        .join(", ");
    let vals = values
        .iter()
        .map(|v| sql_literal(engine, &v.value))
        .collect::<Vec<_>>()
        .join(", ");
    format!("INSERT INTO {table_sql} ({cols}) VALUES ({vals})")
}

/// 判断语句是否返回结果集
pub fn returns_rows(sql: &str) -> bool {
    let s = sql.trim_start().to_ascii_lowercase();
    s.starts_with("select")
        || s.starts_with("with")
        || s.starts_with("show")
        || s.starts_with("describe")
        || s.starts_with("desc ")
        || s.starts_with("explain")
        || s.starts_with("pragma")
        || s.starts_with("values")
}

/// 引号包裹标识符
pub fn quote_ident(engine: &str, name: &str) -> String {
    if engine == "mysql" {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

/// 生成带库名的完整表名
pub fn qualified(engine: &str, db: &str, table: &str) -> String {
    if engine == "mysql" && !db.is_empty() {
        format!("{}.{}", quote_ident(engine, db), quote_ident(engine, table))
    } else {
        quote_ident(engine, table)
    }
}

/// 字面量转义（仅用于生成 SQL 文本，如导出脚本）
pub fn sql_literal(engine: &str, value: &Cell) -> String {
    match value {
        None => "NULL".to_string(),
        Some(v) => {
            if engine == "mysql" {
                format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
            } else {
                format!("'{}'", v.replace('\'', "''"))
            }
        }
    }
}

pub fn fmt_float(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else {
        let s = format!("{v}");
        s
    }
}
