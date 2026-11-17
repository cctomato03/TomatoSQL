//! 依据列/索引元数据生成建表 DDL，支持 MySQL 与 SQLite 之间互转。

use crate::db::quote_ident;
use crate::model::{ColumnInfo, IndexInfo};

/// 把类型归一到"类型族"，方便跨引擎比较
pub fn type_family(data_type: &str) -> &'static str {
    let t = data_type.to_ascii_lowercase();
    let base = t.split('(').next().unwrap_or("").trim().to_string();
    match base.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "bit" | "bool"
        | "boolean" | "serial" | "int2" | "int4" | "int8" | "unsigned big int" => "int",
        "decimal" | "numeric" | "float" | "double" | "real" | "double precision" | "money" => "num",
        "char" | "varchar" | "character" | "character varying" | "text" | "tinytext"
        | "mediumtext" | "longtext" | "enum" | "set" | "json" | "jsonb" | "clob" | "uuid"
        | "nchar" | "nvarchar" => "text",
        "date" | "datetime" | "timestamp" | "time" | "year" | "datetime2" | "smalldatetime" => {
            "datetime"
        }
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" | "bytea" => "blob",
        _ => "other",
    }
}

pub fn map_type(target_engine: &str, source_engine: &str, col: &ColumnInfo) -> String {
    let original = col.data_type.trim().to_string();
    if source_engine == target_engine {
        return if original.is_empty() {
            "TEXT".into()
        } else {
            original
        };
    }
    let auto_inc = col.extra.to_ascii_lowercase().contains("auto_increment");
    if target_engine == "sqlite" {
        // MySQL -> SQLite
        match type_family(&original) {
            "int" => {
                if auto_inc && col.key.eq_ignore_ascii_case("PRI") {
                    "INTEGER".into()
                } else if original.to_ascii_lowercase().starts_with("bigint") {
                    "INTEGER".into()
                } else {
                    "INTEGER".into()
                }
            }
            "num" => "REAL".into(),
            "datetime" => "TEXT".into(),
            "blob" => "BLOB".into(),
            "text" => "TEXT".into(),
            _ => "TEXT".into(),
        }
    } else {
        // SQLite -> MySQL
        let lowered = original.to_ascii_lowercase();
        let is_pk = col.key.eq_ignore_ascii_case("PRI");
        match type_family(&original) {
            "int" => {
                if is_pk && lowered.contains("int") {
                    "BIGINT".into()
                } else {
                    "BIGINT".into()
                }
            }
            "num" => {
                if lowered.starts_with("decimal") || lowered.starts_with("numeric") {
                    "DECIMAL(20,6)".into()
                } else {
                    "DOUBLE".into()
                }
            }
            "datetime" => "DATETIME".into(),
            "blob" => "LONGBLOB".into(),
            "text" => {
                if let Some(len) = extract_len(&lowered) {
                    if len <= 255 {
                        return format!("VARCHAR({len})");
                    }
                }
                "LONGTEXT".into()
            }
            _ => "LONGTEXT".into(),
        }
    }
}

fn extract_len(t: &str) -> Option<i64> {
    let start = t.find('(')?;
    let end = t.find(')')?;
    t[start + 1..end].split(',').next()?.trim().parse().ok()
}

fn default_clause(target_engine: &str, source_engine: &str, col: &ColumnInfo) -> String {
    let Some(def) = col.default_value.as_ref().map(|d| d.trim().to_string()) else {
        return String::new();
    };
    if def.is_empty() {
        return String::new();
    }
    let upper = def.to_ascii_uppercase();
    if upper.contains("CURRENT_TIMESTAMP") || upper.contains("CURRENT_DATE") {
        return if target_engine == "sqlite" {
            "DEFAULT CURRENT_TIMESTAMP".into()
        } else {
            "DEFAULT CURRENT_TIMESTAMP".into()
        };
    }
    if source_engine != target_engine {
        let is_num = def.parse::<f64>().is_ok();
        if is_num {
            return format!("DEFAULT {def}");
        }
        return format!("DEFAULT '{}'", def.replace('\'', "''"));
    }
    format!("DEFAULT {def}")
}

/// 生成建表语句（不含索引），target_engine: mysql | sqlite
pub fn create_table(
    target_engine: &str,
    source_engine: &str,
    table: &str,
    columns: &[ColumnInfo],
    indexes: &[IndexInfo],
) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let pk_cols: Vec<&str> = columns
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.as_str())
        .collect();
    let auto_inc = columns
        .iter()
        .any(|c| c.extra.to_ascii_lowercase().contains("auto_increment"));

    for col in columns {
        let mut line = format!("  {}", quote_ident(target_engine, &col.name));
        let mut ty = map_type(target_engine, source_engine, col);
        if target_engine == "sqlite"
            && type_family(&col.data_type) == "int"
            && auto_inc
            && pk_cols.len() == 1
            && col.key.eq_ignore_ascii_case("PRI")
        {
            ty = "INTEGER".into();
            line.push(' ');
            line.push_str(&ty);
            line.push_str(" PRIMARY KEY AUTOINCREMENT");
            lines.push(line);
            continue;
        }
        if target_engine == "mysql" && auto_inc && col.key.eq_ignore_ascii_case("PRI") {
            ty.push_str(" AUTO_INCREMENT");
        }
        line.push(' ');
        line.push_str(&ty);
        if !col.nullable {
            line.push_str(" NOT NULL");
        }
        let def = default_clause(target_engine, source_engine, col);
        if !def.is_empty() {
            line.push(' ');
            line.push_str(&def);
        }
        if target_engine == "mysql" && col.comment.as_ref().is_some_and(|c| !c.is_empty()) {
            line.push_str(&format!(
                " COMMENT '{}'",
                col.comment.clone().unwrap_or_default().replace('\'', "''")
            ));
        }
        lines.push(line);
    }

    if !pk_cols.is_empty()
        && !(target_engine == "sqlite" && auto_inc && pk_cols.len() == 1)
    {
        let cols = pk_cols
            .iter()
            .map(|c| quote_ident(target_engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("  PRIMARY KEY ({cols})"));
    }

    let suffix = if target_engine == "mysql" {
        " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    } else {
        ""
    };
    let mut out = vec![format!(
        "CREATE TABLE IF NOT EXISTS {} (\n{}\n){};",
        quote_ident(target_engine, table),
        lines.join(",\n"),
        suffix
    )];

    for idx in indexes {
        if idx.primary || idx.columns.is_empty() {
            continue;
        }
        let cols = idx
            .columns
            .iter()
            .map(|c| quote_ident(target_engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!(
            "CREATE {}INDEX {} ON {} ({});",
            if idx.unique { "UNIQUE " } else { "" },
            quote_ident(target_engine, &idx.name),
            quote_ident(target_engine, table),
            cols
        ));
    }
    out
}

/// 生成"新增列"语句
pub fn add_column(
    target_engine: &str,
    source_engine: &str,
    table: &str,
    col: &ColumnInfo,
) -> String {
    let mut def = default_clause(target_engine, source_engine, col);
    let ty = map_type(target_engine, source_engine, col);
    let null = if col.nullable { "" } else { " NOT NULL" };
    if !def.is_empty() {
        def = format!(" {def}");
    }
    format!(
        "ALTER TABLE {} ADD COLUMN {} {}{}{};",
        quote_ident(target_engine, table),
        quote_ident(target_engine, &col.name),
        ty,
        null,
        def
    )
}

pub fn create_index(target_engine: &str, table: &str, idx: &IndexInfo) -> String {
    let cols = idx
        .columns
        .iter()
        .map(|c| quote_ident(target_engine, c))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CREATE {}INDEX {} ON {} ({});",
        if idx.unique { "UNIQUE " } else { "" },
        quote_ident(target_engine, &idx.name),
        quote_ident(target_engine, table),
        cols
    )
}
