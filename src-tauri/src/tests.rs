//! 核心引擎集成测试：SQLite 全链路（查询 / 分页 / 导入导出 / 结构比较 / 同步）

use crate::db::Conn;
use crate::model::*;
use std::path::PathBuf;

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tomato-sql-test-{}", crate::model::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sqlite_cfg(path: &PathBuf) -> Connection {
    let mut cfg = Connection::default();
    cfg.kind = "sqlite".into();
    cfg.file = Some(path.to_string_lossy().to_string());
    cfg
}

async fn open(path: &PathBuf) -> Conn {
    Conn::connect(&sqlite_cfg(path)).await.expect("打开 sqlite 失败")
}

async fn seed(conn: &Conn) {
    conn.exec_sql(
        "",
        "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER, note TEXT);",
    )
    .await
    .unwrap();
    conn.exec_sql(
        "",
        "INSERT INTO users (name, age, note) VALUES ('张三', 30, NULL), ('李四', 25, 'vip'), ('王五', 41, 'a,b');",
    )
    .await
    .unwrap();
    conn.exec_sql("", "CREATE INDEX idx_users_age ON users (age);")
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_metadata_and_queries() {
    let dir = temp_dir();
    let cfg = sqlite_cfg(&dir.join("a.db"));
    let conn = Conn::connect(&cfg).await.unwrap();
    seed(&conn).await;

    assert_eq!(conn.databases().await.unwrap(), vec!["main".to_string()]);

    let tables = conn.tables("main").await.unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].name, "users");
    assert_eq!(tables[0].kind, "table");

    let cols = conn.columns("main", "users").await.unwrap();
    assert_eq!(cols.len(), 4);
    assert_eq!(cols[0].name, "id");
    assert_eq!(cols[0].key, "PRI");
    assert!(cols.iter().find(|c| c.name == "name").unwrap().nullable == false);

    let idx = conn.indexes("main", "users").await.unwrap();
    assert!(idx.iter().any(|i| i.name == "idx_users_age"));
    assert!(idx.iter().any(|i| i.primary));

    let ddl = conn.ddl("main", "users").await.unwrap();
    assert!(ddl.to_uppercase().contains("CREATE TABLE"));

    let res = conn.query("main", "SELECT id, name, age FROM users ORDER BY id", 100).await.unwrap();
    assert_eq!(res.len(), 1);
    assert_eq!(res[0].rows.len(), 3);
    assert_eq!(res[0].columns[1].name, "name");
    assert_eq!(res[0].rows[0][1].as_deref(), Some("张三"));

    // NULL 值保留
    let res = conn.query("main", "SELECT note FROM users WHERE id = 1", 10).await.unwrap();
    assert_eq!(res[0].rows[0][0], None);

    // 多语句拆分
    let res = conn
        .query("main", "SELECT 1 AS a; SELECT 2 AS b;", 10)
        .await
        .unwrap();
    assert_eq!(res.len(), 2);

    // 分页
    let page = conn.fetch_rows("main", "users", 2, 0, None, None).await.unwrap();
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.total, 3);
    assert_eq!(page.primary_key, vec!["id".to_string()]);

    let page2 = conn.fetch_rows("main", "users", 2, 2, Some("age > 20"), None).await.unwrap();
    assert_eq!(page2.rows.len(), 1);
    assert_eq!(page2.total, 3);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn sqlite_export_and_import() {
    let dir = temp_dir();
    let conn = open(&dir.join("a.db")).await;
    seed(&conn).await;

    // CSV
    let csv_path = dir.join("users.csv").to_string_lossy().to_string();
    let out = crate::transfer::export(
        &conn,
        &ExportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            tables: vec!["users".into()],
            sql: None,
            format: "csv".into(),
            file_path: csv_path.clone(),
            include_header: true,
            delimiter: ",".into(),
            include_structure: false,
            null_as: None,
            batch_size: 100,
        },
    )
    .await
    .unwrap();
    assert_eq!(out.rows, 3);
    let text = std::fs::read_to_string(&csv_path).unwrap();
    assert!(text.contains("id,name,age,note"));
    assert!(text.contains("张三"));
    // 含逗号的字段需要被引号包裹
    assert!(text.contains("\"a,b\""));

    // JSON
    let json_path = dir.join("users.json").to_string_lossy().to_string();
    crate::transfer::export(
        &conn,
        &ExportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            tables: vec!["users".into()],
            sql: None,
            format: "json".into(),
            file_path: json_path.clone(),
            include_header: true,
            delimiter: ",".into(),
            include_structure: false,
            null_as: None,
            batch_size: 100,
        },
    )
    .await
    .unwrap();
    let json = std::fs::read_to_string(&json_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 3);

    // SQL
    let sql_path = dir.join("users.sql").to_string_lossy().to_string();
    crate::transfer::export(
        &conn,
        &ExportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            tables: vec!["users".into()],
            sql: None,
            format: "sql".into(),
            file_path: sql_path.clone(),
            include_header: true,
            delimiter: ",".into(),
            include_structure: true,
            null_as: None,
            batch_size: 100,
        },
    )
    .await
    .unwrap();
    let sql = std::fs::read_to_string(&sql_path).unwrap();
    assert!(sql.contains("CREATE TABLE"));
    assert!(sql.contains("INSERT INTO"));

    // 导入 CSV 到新表（自动建表）
    let res = crate::transfer::import(
        &conn,
        &ImportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            table: "users_copy".into(),
            format: "csv".into(),
            file_path: csv_path.clone(),
            has_header: true,
            delimiter: ",".into(),
            truncate_first: false,
            create_table: true,
            on_conflict: "error".into(),
            batch_size: 100,
            empty_as_null: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(res.inserted, 3, "错误: {:?}", res.errors);

    let cnt = conn.row_count("main", "users_copy").await.unwrap();
    assert_eq!(cnt, 3);

    // 导入 SQL 脚本
    let res = crate::transfer::import(
        &conn,
        &ImportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            table: "".into(),
            format: "sql".into(),
            file_path: sql_path,
            has_header: false,
            delimiter: ",".into(),
            truncate_first: false,
            create_table: true,
            on_conflict: "error".into(),
            batch_size: 100,
            empty_as_null: false,
        },
    )
    .await
    .unwrap();
    assert!(res.failed <= 1, "SQL 导入失败: {:?}", res.errors);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn sqlite_compare_and_sync() {
    let dir = temp_dir();
    let src = open(&dir.join("src.db")).await;
    seed(&src).await;

    let dst = open(&dir.join("dst.db")).await;
    dst.exec_sql("", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);")
        .await
        .unwrap();
    dst.exec_sql("", "INSERT INTO users (id, name) VALUES (99, '已存在');")
        .await
        .unwrap();

    let report = crate::sync::compare(&src, "main", &dst, "main", &[], true)
        .await
        .unwrap();
    let users = report.tables.iter().find(|t| t.name == "users").unwrap();
    assert_eq!(users.status, "both");
    assert!(users.has_structure_change);
    assert!(users
        .columns
        .iter()
        .any(|c| c.name == "age" && c.status == "missingInTarget"));
    assert_eq!(users.source_rows, 3);

    let res = crate::sync::apply(
        &src,
        "main",
        &dst,
        "main",
        &SyncRequest {
            source_conn: "s".into(),
            source_db: "main".into(),
            target_conn: "d".into(),
            target_db: "main".into(),
            tables: vec!["users".into()],
            create_tables: true,
            add_columns: true,
            create_indexes: true,
            copy_data: true,
            truncate_target: true,
            drop_target_tables: false,
        },
    )
    .await
    .unwrap();
    assert!(res.failed == 0, "同步失败步骤: {:?}", res.steps.iter().filter(|s| !s.ok).collect::<Vec<_>>());

    let cols = dst.columns("main", "users").await.unwrap();
    assert!(cols.iter().any(|c| c.name == "age"));
    let cnt = dst.row_count("main", "users").await.unwrap();
    assert_eq!(cnt, 3);

    // 复制到另一个库（跨文件 = 模拟跨库迁移），验证新表能整表创建
    let dst2 = open(&dir.join("dst2.db")).await;
    let res = crate::sync::apply(
        &src,
        "main",
        &dst2,
        "main",
        &SyncRequest {
            source_conn: "s".into(),
            source_db: "main".into(),
            target_conn: "d2".into(),
            target_db: "main".into(),
            tables: Vec::new(),
            create_tables: true,
            add_columns: true,
            create_indexes: true,
            copy_data: true,
            truncate_target: false,
            drop_target_tables: false,
        },
    )
    .await
    .unwrap();
    assert!(res.failed == 0);
    let tables = dst2.tables("main").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "users"));
    assert_eq!(dst2.row_count("main", "users").await.unwrap(), 3);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn apply_row_changes_via_sql() {
    let dir = temp_dir();
    let conn = open(&dir.join("a.db")).await;
    seed(&conn).await;

    // UPDATE
    let n = conn
        .exec_sql("main", "UPDATE users SET age = 99 WHERE id = 2")
        .await
        .unwrap();
    assert_eq!(n, 1);
    let res = conn.query("main", "SELECT age FROM users WHERE id = 2", 10).await.unwrap();
    assert_eq!(res[0].rows[0][0].as_deref(), Some("99"));

    // DELETE
    conn.exec_sql("main", "DELETE FROM users WHERE id = 3").await.unwrap();
    assert_eq!(conn.row_count("main", "users").await.unwrap(), 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn crypto_roundtrip() {
    let dir = temp_dir();
    crate::crypto::init(&dir);
    let secret = "p@ssw0rd-中文-🔐";
    let enc = crate::crypto::encrypt(secret);
    assert!(enc.starts_with("enc:v1:"));
    assert_ne!(enc, secret);
    assert_eq!(crate::crypto::decrypt(&enc), secret);
    // 非密文原样返回
    assert_eq!(crate::crypto::decrypt("plain"), "plain");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn workspace_file_encrypts_password() {
    let dir = temp_dir();
    crate::crypto::init(&dir);
    let mut ws = Workspace::default();
    let mut conn = Connection::default();
    conn.name = "本地".into();
    conn.password = Some("topsecret".into());
    ws.connections.push(conn);
    ws.settings.cloud.token = Some("cloud-token-abc".into());

    let text = crate::store::encode(&ws).unwrap();
    assert!(!text.contains("topsecret"), "密码不应明文出现在文件中");
    assert!(!text.contains("cloud-token-abc"), "云端 token 不应明文出现在文件中");
    assert!(text.contains("enc:v1:"));

    let back = crate::store::decode(&text).unwrap();
    assert_eq!(back.connections[0].password.as_deref(), Some("topsecret"));
    assert_eq!(back.settings.cloud.token.as_deref(), Some("cloud-token-abc"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_csv_without_header_uses_target_columns() {
    let dir = temp_dir();
    let conn = open(&dir.join("a.db")).await;
    conn.exec_sql("", "CREATE TABLE t2 (a INTEGER, b TEXT);").await.unwrap();
    let csv = dir.join("noheader.csv");
    std::fs::write(&csv, "1,alpha\n2,beta\n").unwrap();

    let res = crate::transfer::import(
        &conn,
        &ImportRequest {
            conn_id: "t".into(),
            database: "main".into(),
            table: "t2".into(),
            format: "csv".into(),
            file_path: csv.to_string_lossy().to_string(),
            has_header: false,
            delimiter: ",".into(),
            truncate_first: false,
            create_table: false,
            on_conflict: "error".into(),
            batch_size: 100,
            empty_as_null: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(res.inserted, 2, "错误: {:?}", res.errors);

    let rows = conn
        .query("main", "SELECT a, b FROM t2 ORDER BY a", 10)
        .await
        .unwrap();
    assert_eq!(rows[0].rows[0][1].as_deref(), Some("alpha"));
    assert_eq!(rows[0].rows[1][1].as_deref(), Some("beta"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn insert_row_with_values() {
    let dir = temp_dir();
    let conn = open(&dir.join("a.db")).await;
    conn.exec_sql("", "CREATE TABLE t3 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, qty INTEGER);")
        .await
        .unwrap();

    // 全默认值插入：name 是 NOT NULL 且无默认值，应当失败（界面里改成了填值弹窗）
    let default_sql = crate::db::build_insert("sqlite", "main", "t3", &[]);
    assert!(conn.exec_sql("main", &default_sql).await.is_err());

    // 带值插入
    let values = vec![
        PkPair { column: "name".into(), value: Some("苹果".into()) },
        PkPair { column: "qty".into(), value: Some("12".into()) },
    ];
    let sql = crate::db::build_insert("sqlite", "main", "t3", &values);
    assert!(sql.starts_with("INSERT INTO \"t3\""), "{sql}");
    conn.exec_sql("main", &sql).await.unwrap();

    // NULL 值 + 字符串转义
    let values = vec![
        PkPair { column: "name".into(), value: Some("O'Reilly".into()) },
        PkPair { column: "qty".into(), value: None },
    ];
    conn.exec_sql("main", &crate::db::build_insert("sqlite", "main", "t3", &values))
        .await
        .unwrap();

    let rows = conn
        .query("main", "SELECT name, qty FROM t3 ORDER BY id", 10)
        .await
        .unwrap();
    assert_eq!(rows[0].rows.len(), 2);
    assert_eq!(rows[0].rows[0][0].as_deref(), Some("苹果"));
    assert_eq!(rows[0].rows[0][1].as_deref(), Some("12"));
    assert_eq!(rows[0].rows[1][0].as_deref(), Some("O'Reilly"));
    assert_eq!(rows[0].rows[1][1], None);

    // MySQL 语法分支
    let mysql_default = crate::db::build_insert("mysql", "db1", "t3", &[]);
    assert_eq!(mysql_default, "INSERT INTO `db1`.`t3` () VALUES ()");
    let mysql_vals = crate::db::build_insert(
        "mysql",
        "db1",
        "t3",
        &[PkPair { column: "name".into(), value: Some("a".into()) }],
    );
    assert_eq!(mysql_vals, "INSERT INTO `db1`.`t3` (`name`) VALUES ('a')");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn split_statements_handles_quotes_and_comments() {
    let sql = "SELECT ';' AS a; -- 注释里的分号;\n/* 块注释 ; */ SELECT 2;";
    let parts = crate::db::split_statements(sql);
    assert_eq!(parts.len(), 2);
    assert!(parts[0].contains("';'"));
    assert!(parts[1].contains("SELECT 2"));
}
