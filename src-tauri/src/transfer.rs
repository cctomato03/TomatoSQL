//! 数据导入 / 导出：CSV、JSON、SQL 三种格式。

use crate::db::{quote_ident, sql_literal, Conn};
use crate::model::*;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 单个文件内的写入状态
struct FileState {
    json_first: bool,
    csv_header_done: bool,
}

impl FileState {
    fn new() -> Self {
        Self {
            json_first: true,
            csv_header_done: false,
        }
    }
}

/// 多表导出时按表名生成文件名
fn per_table_path(base: &str, table: &str) -> String {
    let p = Path::new(base);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".into());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let safe_table: String = table
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let name = if ext.is_empty() {
        format!("{stem}_{safe_table}")
    } else {
        format!("{stem}_{safe_table}.{ext}")
    };
    dir.join(name).to_string_lossy().to_string()
}

fn csv_escape(field: &str, delim: &str) -> String {
    let needs = field.contains(delim)
        || field.contains('"')
        || field.contains('\n')
        || field.contains('\r')
        || field.starts_with(' ')
        || field.ends_with(' ');
    if needs {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

fn json_value(cell: &Cell) -> String {
    match cell {
        None => "null".into(),
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_section(
    w: &mut BufWriter<File>,
    state: &mut FileState,
    format: &str,
    engine: &str,
    table: &str,
    columns: &[String],
    rows: &[Row],
    req: &ExportRequest,
) -> Result<i64, String> {
    let delim = if req.delimiter.is_empty() { "," } else { &req.delimiter };
    match format {
        "csv" => {
            if req.include_header && !state.csv_header_done {
                let header = columns
                    .iter()
                    .map(|c| csv_escape(c, delim))
                    .collect::<Vec<_>>()
                    .join(delim);
                writeln!(w, "{header}").map_err(err)?;
                state.csv_header_done = true;
            }
            for row in rows {
                let line = row
                    .iter()
                    .map(|c| match c {
                        Some(v) => csv_escape(v, delim),
                        None => req.null_as.clone().unwrap_or_default(),
                    })
                    .collect::<Vec<_>>()
                    .join(delim);
                writeln!(w, "{line}").map_err(err)?;
            }
        }
        "json" => {
            for row in rows {
                let obj = columns
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let v = row.get(i).cloned().flatten();
                        format!("\"{}\":{}", c.replace('"', "\\\""), json_value(&v))
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                if state.json_first {
                    state.json_first = false;
                } else {
                    w.write_all(b",\n").map_err(err)?;
                }
                write!(w, "  {{{obj}}}").map_err(err)?;
            }
        }
        _ => {
            // sql
            let col_list = columns
                .iter()
                .map(|c| quote_ident(engine, c))
                .collect::<Vec<_>>()
                .join(", ");
            let table_sql = quote_ident(engine, table);
            for row in rows {
                let values = row
                    .iter()
                    .map(|c| sql_literal(engine, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(w, "INSERT INTO {table_sql} ({col_list}) VALUES ({values});").map_err(err)?;
            }
        }
    }
    Ok(rows.len() as i64)
}

pub async fn export(conn: &Conn, req: &ExportRequest) -> Result<ExportResult, String> {
    let started = Instant::now();
    let engine = conn.engine();
    let mut total_rows = 0i64;
    let mut table_count = 0i64;
    let mut written_path = req.file_path.clone();

    // 1) 直接导出查询结果
    if let Some(sql) = req.sql.as_ref().filter(|s| !s.trim().is_empty()) {
        let results = conn.query(&req.database, sql, 0).await?;
        let mut w = BufWriter::new(
            File::create(&req.file_path).map_err(|e| format!("无法创建文件：{e}"))?,
        );
        let mut state = FileState::new();
        let multi = results.len() > 1;
        if req.format == "json" {
            writeln!(w, "[").map_err(err)?;
        }
        for (idx, r) in results.iter().enumerate() {
            let cols = r.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
            if req.format == "sql" && multi {
                writeln!(w, "-- 结果集 {}", idx + 1).map_err(err)?;
            }
            total_rows += write_section(
                &mut w,
                &mut state,
                &req.format,
                engine,
                "query_result",
                &cols,
                &r.rows,
                req,
            )?;
            table_count += 1;
        }
        if req.format == "json" {
            writeln!(w, "\n]").map_err(err)?;
        }
        w.flush().map_err(err)?;
        let bytes = std::fs::metadata(&req.file_path).map(|m| m.len() as i64).unwrap_or(0);
        return Ok(ExportResult {
            rows: total_rows,
            tables: table_count,
            bytes,
            file_path: req.file_path.clone(),
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }

    if req.tables.is_empty() {
        return Err("没有选择要导出的表".into());
    }
    // 多表默认拆成多个文件；single_file 时（例如整库备份）强制写进一个文件
    // JSON 的多表结构是「表名 → 数组」，不支持合并到单文件，因此对 json 保持原行为
    let multi = req.tables.len() > 1 && !(req.single_file && req.format != "json");

    // 2) JSON 多表：输出为 { "表名": [ {...} ] }
    if req.format == "json" && multi {
        let mut w = BufWriter::new(
            File::create(&req.file_path).map_err(|e| format!("无法创建文件：{e}"))?,
        );
        writeln!(w, "{{").map_err(err)?;
        for (idx, table) in req.tables.iter().enumerate() {
            let cols = conn.columns(&req.database, table).await?;
            let colnames: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
            writeln!(w, "  \"{}\": [", table.replace('"', "\\\"")).map_err(err)?;
            let mut state = FileState::new();
            let mut offset = 0i64;
            let batch = req.batch_size.clamp(100, 20000);
            let mut wrote_any = false;
            loop {
                let rows = conn
                    .select_columns(&req.database, table, &[], batch, offset)
                    .await?;
                if rows.is_empty() {
                    break;
                }
                wrote_any = true;
                total_rows += write_section(
                    &mut w,
                    &mut state,
                    "json",
                    engine,
                    table,
                    &colnames,
                    &rows,
                    req,
                )?;
                offset += rows.len() as i64;
            }
            let _ = wrote_any;
            writeln!(w, "\n  ]{}", if idx + 1 < req.tables.len() { "," } else { "" }).map_err(err)?;
            table_count += 1;
        }
        writeln!(w, "}}").map_err(err)?;
        w.flush().map_err(err)?;
        let bytes = std::fs::metadata(&req.file_path).map(|m| m.len() as i64).unwrap_or(0);
        return Ok(ExportResult {
            rows: total_rows,
            tables: table_count,
            bytes,
            file_path: req.file_path.clone(),
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }

    // 3) 逐表导出（CSV / SQL / 单表 JSON）
    //    多表默认每个表一个文件；single_file 时（例如整库备份）所有表写进同一个文件，
    //    所以这里只创建一次写入器，避免后一个表把前一个表的内容截断。
    let mut shared: Option<BufWriter<File>> = None;
    if !multi {
        shared = Some(BufWriter::new(
            File::create(&req.file_path)
                .map_err(|e| format!("无法创建文件（{}）：{e}", req.file_path))?,
        ));
    }
    for table in &req.tables {
        let path = if multi {
            per_table_path(&req.file_path, table)
        } else {
            req.file_path.clone()
        };
        let mut local: Option<BufWriter<File>> = None;
        let mut w: &mut BufWriter<File> = if multi {
            local.insert(BufWriter::new(
                File::create(&path).map_err(|e| format!("无法创建文件（{path}）：{e}"))?,
            ))
        } else {
            shared.as_mut().unwrap()
        };
        let cols = conn.columns(&req.database, table).await?;
        let colnames: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
        let mut state = FileState::new();

        if req.format == "sql" {
            if req.include_structure {
                let ddl_text = conn.ddl(&req.database, table).await.unwrap_or_default();
                if !ddl_text.trim().is_empty() {
                    writeln!(w, "-- 表结构：{table}").map_err(err)?;
                    writeln!(w, "DROP TABLE IF EXISTS {};", quote_ident(engine, table)).map_err(err)?;
                    let trimmed = ddl_text.trim().trim_end_matches(';');
                    writeln!(w, "{trimmed};").map_err(err)?;
                    writeln!(w).map_err(err)?;
                }
            }
            writeln!(w, "-- 表数据：{table}").map_err(err)?;
        } else if req.format == "json" {
            writeln!(w, "[").map_err(err)?;
        }

        let mut offset = 0i64;
        let batch = req.batch_size.clamp(100, 20000);
        while req.include_data {
            let rows = conn
                .select_columns(&req.database, table, &[], batch, offset)
                .await?;
            if rows.is_empty() {
                break;
            }
            total_rows += write_section(
                &mut w,
                &mut state,
                &req.format,
                engine,
                table,
                &colnames,
                &rows,
                req,
            )?;
            offset += rows.len() as i64;
        }
        if req.format == "json" {
            writeln!(w, "\n]").map_err(err)?;
        }
        w.flush().map_err(err)?;
        table_count += 1;
        if !multi {
            written_path = path;
        }
    }
    let bytes = std::fs::metadata(&written_path).map(|m| m.len() as i64).unwrap_or(0);
    Ok(ExportResult {
        rows: total_rows,
        tables: table_count,
        bytes,
        file_path: written_path,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------- 导入 ----------------

fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cur_row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            c if c == delim => {
                cur_row.push(std::mem::take(&mut field));
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                cur_row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut cur_row));
            }
            '\n' => {
                cur_row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut cur_row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !cur_row.is_empty() {
        cur_row.push(field);
        rows.push(cur_row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].trim().is_empty()));
    rows
}

fn infer_type(values: &[&String], engine: &str) -> String {
    let mut all_int = true;
    let mut all_num = true;
    for v in values.iter().take(300) {
        if v.trim().is_empty() {
            continue;
        }
        if v.trim().parse::<i64>().is_err() {
            all_int = false;
        }
        if v.trim().parse::<f64>().is_err() {
            all_num = false;
        }
    }
    if engine == "mysql" {
        if all_int {
            "BIGINT".into()
        } else if all_num {
            "DOUBLE".into()
        } else {
            "LONGTEXT".into()
        }
    } else if all_int {
        "INTEGER".into()
    } else if all_num {
        "REAL".into()
    } else {
        "TEXT".into()
    }
}

pub async fn import(conn: &Conn, req: &ImportRequest) -> Result<ImportResult, String> {
    let started = Instant::now();
    let engine = conn.engine();
    let text = std::fs::read_to_string(&req.file_path)
        .map_err(|e| format!("无法读取文件（{}）：{e}", req.file_path))?;

    // SQL 脚本导入
    if req.format == "sql" {
        let statements = crate::db::split_statements(&text);
        let mut result = ImportResult {
            table: req.table.clone(),
            ..Default::default()
        };
        for stmt in statements {
            match conn.exec_sql(&req.database, &stmt).await {
                Ok(n) => result.inserted += n,
                Err(e) => {
                    result.failed += 1;
                    if result.errors.len() < 20 {
                        result.errors.push(format!(
                            "{} → {e}",
                            stmt.chars().take(120).collect::<String>()
                        ));
                    }
                }
            }
        }
        result.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(result);
    }

    // CSV / JSON
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();

    if req.format == "json" {
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败：{e}"))?;
        let arr = match parsed {
            serde_json::Value::Array(a) => a,
            serde_json::Value::Object(o) => o
                .values()
                .find_map(|v| v.as_array().cloned())
                .unwrap_or_default(),
            _ => return Err("JSON 内容需要是对象数组".into()),
        };
        for item in &arr {
            if let serde_json::Value::Object(map) = item {
                for (k, _) in map.iter() {
                    if !columns.contains(k) {
                        columns.push(k.clone());
                    }
                }
            }
        }
        for item in arr {
            if let serde_json::Value::Object(map) = item {
                let row = columns
                    .iter()
                    .map(|c| match map.get(c) {
                        None | Some(serde_json::Value::Null) => None,
                        Some(serde_json::Value::String(s)) => Some(s.clone()),
                        Some(v) => Some(v.to_string()),
                    })
                    .collect::<Vec<_>>();
                rows.push(row);
            }
        }
    } else {
        let bytes = std::fs::read(&req.file_path).map_err(|e| e.to_string())?;
        let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            String::from_utf8_lossy(&bytes[3..]).to_string()
        } else {
            String::from_utf8(bytes.clone()).unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string())
        };
        let delim = req.delimiter.chars().next().unwrap_or(',');
        let mut parsed = parse_csv(&text, delim);
        if req.has_header && !parsed.is_empty() {
            columns = parsed.remove(0).into_iter().map(|h| h.trim().to_string()).collect();
        }
        if columns.is_empty() {
            // 无表头：按目标表已有的列顺序映射
            let existing_cols = conn.columns(&req.database, &req.table).await.unwrap_or_default();
            if existing_cols.is_empty() {
                return Err(
                    "该文件没有表头，且目标表不存在或没有列信息。请勾选“首行是列名”，或先创建目标表。"
                        .into(),
                );
            }
            columns = existing_cols.into_iter().map(|c| c.name).collect();
        }
        for mut row in parsed {
            row.resize(columns.len().max(row.len()), String::new());
            let mapped = row
                .into_iter()
                .take(columns.len())
                .map(|v| {
                    if req.empty_as_null && v.is_empty() {
                        None
                    } else {
                        Some(v)
                    }
                })
                .collect::<Vec<_>>();
            rows.push(mapped);
        }
    }

    if columns.is_empty() {
        return Err("无法确定目标列，请检查文件表头或使用 JSON 对象格式".into());
    }

    // 目标表不存在：按需建表
    let existing = conn.tables(&req.database).await?;
    let target_exists = existing.iter().any(|t| t.name == req.table);
    if !target_exists {
        if !req.create_table {
            return Err(format!("目标表 {} 不存在（可勾选“自动建表”）", req.table));
        }
        let mut defs: Vec<String> = Vec::new();
        for (i, c) in columns.iter().enumerate() {
            let sample: Vec<&String> = rows.iter().filter_map(|r| r.get(i)).flatten().collect();
            defs.push(format!(
                "{} {}",
                quote_ident(engine, c),
                infer_type(&sample, engine)
            ));
        }
        let suffix = if engine == "mysql" {
            " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        } else {
            ""
        };
        let create_sql = format!(
            "CREATE TABLE {} (\n  {}\n){};",
            quote_ident(engine, &req.table),
            defs.join(",\n  "),
            suffix
        );
        conn.exec_sql(&req.database, &create_sql).await?;
    }

    if req.truncate_first {
        let sql = if engine == "mysql" {
            format!("TRUNCATE TABLE {}", quote_ident(engine, &req.table))
        } else {
            format!("DELETE FROM {}", quote_ident(engine, &req.table))
        };
        conn.exec_sql(&req.database, &sql).await?;
    }

    let mut result = ImportResult {
        table: req.table.clone(),
        ..Default::default()
    };
    let batch = req.batch_size.clamp(50, 5000) as usize;
    for chunk in rows.chunks(batch) {
        match conn
            .insert_rows(
                &req.database,
                &req.table,
                &columns,
                chunk,
                req.on_conflict == "ignore",
            )
            .await
        {
            Ok(n) => result.inserted += n,
            Err(e) => {
                result.failed += chunk.len() as i64;
                if result.errors.len() < 20 {
                    result.errors.push(e);
                }
            }
        }
    }
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}
