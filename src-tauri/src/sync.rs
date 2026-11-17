//! 结构比较与同步（迁移）引擎。

use crate::db::{ddl, Conn};
use crate::model::*;
use std::time::Instant;

pub async fn compare(
    src: &Conn,
    src_db: &str,
    dst: &Conn,
    dst_db: &str,
    filter: &[String],
    compare_data: bool,
) -> Result<CompareReport, String> {
    let started = Instant::now();
    let src_tables = src.tables(src_db).await?;
    let dst_tables = dst.tables(dst_db).await?;
    let same_engine = src.engine() == dst.engine();

    let mut names: Vec<String> = Vec::new();
    for t in &src_tables {
        if t.kind == "table" && (filter.is_empty() || filter.contains(&t.name)) {
            names.push(t.name.clone());
        }
    }
    for t in &dst_tables {
        if t.kind == "table" && (filter.is_empty() || filter.contains(&t.name)) && !names.contains(&t.name)
        {
            names.push(t.name.clone());
        }
    }
    names.sort();

    let mut out: Vec<TableDiff> = Vec::new();
    for name in names {
        let in_src = src_tables.iter().any(|t| t.name == name);
        let in_dst = dst_tables.iter().any(|t| t.name == name);
        let status = match (in_src, in_dst) {
            (true, true) => "both",
            (true, false) => "onlySource",
            _ => "onlyTarget",
        };
        let mut diff = TableDiff {
            name: name.clone(),
            status: status.into(),
            has_structure_change: status != "both",
            ..Default::default()
        };
        if status == "both" {
            let sc = src.columns(src_db, &name).await.unwrap_or_default();
            let dc = dst.columns(dst_db, &name).await.unwrap_or_default();
            for c in &sc {
                match dc.iter().find(|d| d.name.eq_ignore_ascii_case(&c.name)) {
                    None => {
                        diff.columns.push(ColumnDiff {
                            name: c.name.clone(),
                            status: "missingInTarget".into(),
                            source_type: c.data_type.clone(),
                            target_type: String::new(),
                        });
                        diff.has_structure_change = true;
                    }
                    Some(d) => {
                        let equal = if same_engine {
                            normalize_type(&d.data_type) == normalize_type(&c.data_type)
                        } else {
                            ddl::type_family(&d.data_type) == ddl::type_family(&c.data_type)
                        };
                        if !equal {
                            diff.columns.push(ColumnDiff {
                                name: c.name.clone(),
                                status: "typeMismatch".into(),
                                source_type: c.data_type.clone(),
                                target_type: d.data_type.clone(),
                            });
                            diff.has_structure_change = true;
                        }
                    }
                }
            }
            for d in &dc {
                if !sc.iter().any(|c| c.name.eq_ignore_ascii_case(&d.name)) {
                    diff.columns.push(ColumnDiff {
                        name: d.name.clone(),
                        status: "missingInSource".into(),
                        source_type: String::new(),
                        target_type: d.data_type.clone(),
                    });
                }
            }
            let si = src.indexes(src_db, &name).await.unwrap_or_default();
            let di = dst.indexes(dst_db, &name).await.unwrap_or_default();
            for idx in &si {
                if idx.primary {
                    continue;
                }
                match di.iter().find(|d| d.name == idx.name) {
                    None => {
                        diff.indexes.push(IndexDiff {
                            name: idx.name.clone(),
                            status: "missingInTarget".into(),
                            detail: idx.columns.join(", "),
                        });
                        diff.has_structure_change = true;
                    }
                    Some(d) => {
                        if d.columns.join(",") != idx.columns.join(",") || d.unique != idx.unique {
                            diff.indexes.push(IndexDiff {
                                name: idx.name.clone(),
                                status: "mismatch".into(),
                                detail: format!(
                                    "源({}) 目标({})",
                                    idx.columns.join(", "),
                                    d.columns.join(", ")
                                ),
                            });
                            diff.has_structure_change = true;
                        }
                    }
                }
            }
            if compare_data {
                diff.source_rows = src.row_count(src_db, &name).await.unwrap_or(0);
                diff.target_rows = dst.row_count(dst_db, &name).await.unwrap_or(0);
            }
        }
        if !diff.has_structure_change && diff.columns.is_empty() && diff.indexes.is_empty() {
            diff.status = "same".into();
        }
        out.push(diff);
    }

    Ok(CompareReport {
        tables: out,
        source_conn: src.engine().to_string(),
        target_conn: dst.engine().to_string(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn normalize_type(t: &str) -> String {
    t.trim()
        .to_ascii_lowercase()
        .replace("int(11)", "int")
        .replace("bigint(20)", "bigint")
        .replace(|c: char| c == '`', "")
}

pub async fn apply(
    src: &Conn,
    src_db: &str,
    dst: &Conn,
    dst_db: &str,
    req: &SyncRequest,
) -> Result<SyncResult, String> {
    let started = Instant::now();
    let src_engine = src.engine();
    let dst_engine = dst.engine();
    let src_tables = src.tables(src_db).await?;
    let dst_tables = dst.tables(dst_db).await?;

    let targets: Vec<String> = if req.tables.is_empty() {
        src_tables
            .iter()
            .filter(|t| t.kind == "table")
            .map(|t| t.name.clone())
            .collect()
    } else {
        req.tables.clone()
    };

    let mut steps: Vec<SyncStep> = Vec::new();
    for table in targets {
        let exists = dst_tables.iter().any(|t| t.name == table);
        let cols = match src.columns(src_db, &table).await {
            Ok(c) => c,
            Err(e) => {
                steps.push(SyncStep {
                    table: table.clone(),
                    sql: String::new(),
                    ok: false,
                    message: format!("读取源表结构失败：{e}"),
                    rows: 0,
                });
                continue;
            }
        };
        let indexes = src.indexes(src_db, &table).await.unwrap_or_default();

        let mut recreate = !exists;
        if exists && req.drop_target_tables {
            let sql = format!(
                "DROP TABLE IF EXISTS {}",
                crate::db::quote_ident(dst_engine, &table)
            );
            match dst.exec_sql(dst_db, &sql).await {
                Ok(_) => steps.push(SyncStep {
                    table: table.clone(),
                    sql,
                    ok: true,
                    message: "已删除目标表".into(),
                    rows: 0,
                }),
                Err(e) => {
                    steps.push(SyncStep {
                        table: table.clone(),
                        sql,
                        ok: false,
                        message: e,
                        rows: 0,
                    });
                    continue;
                }
            }
            recreate = true;
        }

        if recreate {
            if !req.create_tables {
                steps.push(SyncStep {
                    table: table.clone(),
                    sql: String::new(),
                    ok: false,
                    message: "目标表不存在且未勾选创建表".into(),
                    rows: 0,
                });
                continue;
            }
            let stmts = ddl::create_table(dst_engine, src_engine, &table, &cols, &indexes);
            for sql in stmts {
                match dst.exec_sql(dst_db, &sql).await {
                    Ok(_) => steps.push(SyncStep {
                        table: table.clone(),
                        sql: sql.clone(),
                        ok: true,
                        message: "已创建".into(),
                        rows: 0,
                    }),
                    Err(e) => steps.push(SyncStep {
                        table: table.clone(),
                        sql: sql.clone(),
                        ok: false,
                        message: e,
                        rows: 0,
                    }),
                }
            }
        } else {
            // 增量：新增缺失列 / 索引
            let dst_cols = dst.columns(dst_db, &table).await.unwrap_or_default();
            if req.add_columns {
                for c in &cols {
                    if !dst_cols.iter().any(|d| d.name.eq_ignore_ascii_case(&c.name)) {
                        let sql = ddl::add_column(dst_engine, src_engine, &table, c);
                        match dst.exec_sql(dst_db, &sql).await {
                            Ok(_) => steps.push(SyncStep {
                                table: table.clone(),
                                sql: sql.clone(),
                                ok: true,
                                message: format!("已新增列 {}", c.name),
                                rows: 0,
                            }),
                            Err(e) => steps.push(SyncStep {
                                table: table.clone(),
                                sql: sql.clone(),
                                ok: false,
                                message: e,
                                rows: 0,
                            }),
                        }
                    }
                }
            }
            if req.create_indexes {
                let dst_idx = dst.indexes(dst_db, &table).await.unwrap_or_default();
                for idx in &indexes {
                    if idx.primary || dst_idx.iter().any(|d| d.name == idx.name) {
                        continue;
                    }
                    let sql = ddl::create_index(dst_engine, &table, idx);
                    match dst.exec_sql(dst_db, &sql).await {
                        Ok(_) => steps.push(SyncStep {
                            table: table.clone(),
                            sql: sql.clone(),
                            ok: true,
                            message: format!("已创建索引 {}", idx.name),
                            rows: 0,
                        }),
                        Err(e) => steps.push(SyncStep {
                            table: table.clone(),
                            sql: sql.clone(),
                            ok: false,
                            message: e,
                            rows: 0,
                        }),
                    }
                }
            }
        }

        // 数据复制
        if req.copy_data {
            let dst_cols = dst.columns(dst_db, &table).await.unwrap_or_default();
            let shared: Vec<String> = cols
                .iter()
                .filter(|c| dst_cols.iter().any(|d| d.name.eq_ignore_ascii_case(&c.name)))
                .map(|c| {
                    dst_cols
                        .iter()
                        .find(|d| d.name.eq_ignore_ascii_case(&c.name))
                        .map(|d| d.name.clone())
                        .unwrap_or_else(|| c.name.clone())
                })
                .collect();
            if shared.is_empty() {
                steps.push(SyncStep {
                    table: table.clone(),
                    sql: String::new(),
                    ok: false,
                    message: "源表与目标表没有同名可写入的列".into(),
                    rows: 0,
                });
                continue;
            }
            if req.truncate_target && exists && !recreate {
                let sql = if dst_engine == "mysql" {
                    format!("TRUNCATE TABLE {}", crate::db::quote_ident(dst_engine, &table))
                } else {
                    format!("DELETE FROM {}", crate::db::quote_ident(dst_engine, &table))
                };
                if let Err(e) = dst.exec_sql(dst_db, &sql).await {
                    steps.push(SyncStep {
                        table: table.clone(),
                        sql,
                        ok: false,
                        message: e,
                        rows: 0,
                    });
                    continue;
                }
            }
            let mut offset = 0i64;
            let mut copied = 0i64;
            loop {
                let rows = match src
                    .select_columns(src_db, &table, &shared, 500, offset)
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        steps.push(SyncStep {
                            table: table.clone(),
                            sql: String::new(),
                            ok: false,
                            message: format!("读取源数据失败：{e}"),
                            rows: copied,
                        });
                        break;
                    }
                };
                if rows.is_empty() {
                    break;
                }
                match dst
                    .insert_rows(dst_db, &table, &shared, &rows, false)
                    .await
                {
                    Ok(n) => copied += n,
                    Err(e) => {
                        steps.push(SyncStep {
                            table: table.clone(),
                            sql: String::new(),
                            ok: false,
                            message: format!("写入目标表失败：{e}"),
                            rows: copied,
                        });
                        break;
                    }
                }
                offset += rows.len() as i64;
            }
            steps.push(SyncStep {
                table: table.clone(),
                sql: format!("-- 复制数据：{} 行", copied),
                ok: true,
                message: format!("已复制 {copied} 行"),
                rows: copied,
            });
        }
    }

    let succeeded = steps.iter().filter(|s| s.ok).count() as i64;
    let failed = steps.iter().filter(|s| !s.ok).count() as i64;
    Ok(SyncResult {
        steps,
        succeeded,
        failed,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
