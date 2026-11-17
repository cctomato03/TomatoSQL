import { Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { ColumnInfo } from "../types";

export interface FilterRow {
  id: string;
  column: string;
  op: string;
  value: string;
  joiner: "AND" | "OR";
}

export interface SortKey {
  id: string;
  column: string;
  desc: boolean;
}

export const FILTER_OPS: { v: string; label: string; needsValue: boolean }[] = [
  { v: "=", label: "= 等于", needsValue: true },
  { v: "<>", label: "≠ 不等于", needsValue: true },
  { v: ">", label: "> 大于", needsValue: true },
  { v: ">=", label: "≥ 大于等于", needsValue: true },
  { v: "<", label: "< 小于", needsValue: true },
  { v: "<=", label: "≤ 小于等于", needsValue: true },
  { v: "LIKE", label: "包含", needsValue: true },
  { v: "NOT LIKE", label: "不包含", needsValue: true },
  { v: "STARTS", label: "开头是", needsValue: true },
  { v: "ENDS", label: "结尾是", needsValue: true },
  { v: "IN", label: "在列表中（逗号分隔）", needsValue: true },
  { v: "IS NULL", label: "为 NULL", needsValue: false },
  { v: "IS NOT NULL", label: "不为 NULL", needsValue: false },
];

function opInfo(op: string) {
  return FILTER_OPS.find((o) => o.v === op) ?? FILTER_OPS[0];
}

export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function quoteValue(raw: string): string {
  const v = raw.trim();
  if (v === "") return "''";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** 生成 WHERE 子句（不含 WHERE 关键字） */
export function buildWhere(rows: FilterRow[]): string {
  const parts: string[] = [];
  rows.forEach((row, i) => {
    if (!row.column) return;
    const op = opInfo(row.op);
    const col = quoteIdent(row.column);
    let expr: string;
    if (row.op === "IS NULL" || row.op === "IS NOT NULL") {
      expr = `${col} ${row.op}`;
    } else if (row.op === "LIKE" || row.op === "NOT LIKE") {
      expr = `${col} ${row.op} '%${row.value.replace(/'/g, "''")}%'`;
    } else if (row.op === "STARTS") {
      expr = `${col} LIKE '${row.value.replace(/'/g, "''")}%'`;
    } else if (row.op === "ENDS") {
      expr = `${col} LIKE '%${row.value.replace(/'/g, "''")}'`;
    } else if (row.op === "IN") {
      const items = row.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(quoteValue);
      if (!items.length) return;
      expr = `${col} IN (${items.join(", ")})`;
    } else {
      expr = `${col} ${row.op} ${quoteValue(row.value)}`;
    }
    if (i > 0 && parts.length > 0) parts.push(row.joiner);
    parts.push(expr);
  });
  return parts.join(" ");
}

/** 生成 ORDER BY 子句（不含 ORDER BY 关键字） */
export function buildOrderBy(keys: SortKey[]): string {
  return keys
    .filter((k) => k.column)
    .map((k) => `${quoteIdent(k.column)} ${k.desc ? "DESC" : "ASC"}`)
    .join(", ");
}

export function FilterBar({
  columns,
  filters,
  sorts,
  onFiltersChange,
  onSortsChange,
  onApply,
  onClear,
  appliedHint,
}: {
  columns: ColumnInfo[];
  filters: FilterRow[];
  sorts: SortKey[];
  onFiltersChange: (rows: FilterRow[]) => void;
  onSortsChange: (keys: SortKey[]) => void;
  onApply: () => void;
  onClear: () => void;
  appliedHint?: string;
}) {
  const colOptions = columns.map((c) => (
    <option key={c.name} value={c.name}>
      {c.name}
      {c.dataType ? ` (${c.dataType})` : ""}
    </option>
  ));

  const firstCol = columns[0]?.name ?? "";
  const uid = () => `f-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;

  return (
    <div className="filter-panel">
      <div className="filter-section">
        <div className="filter-section-head">
          <SlidersHorizontal size={13} /> 排序
          <span className="toolbar-hint">可添加多个字段，按顺序生效</span>
        </div>
        {sorts.map((s, i) => (
          <div className="filter-row" key={s.id}>
            <span className="filter-order">{i + 1}</span>
            <select
              className="select filter-col"
              value={s.column}
              onChange={(e) =>
                onSortsChange(sorts.map((x) => (x.id === s.id ? { ...x, column: e.target.value } : x)))
              }
            >
              {colOptions}
            </select>
            <select
              className="select filter-op"
              value={s.desc ? "desc" : "asc"}
              onChange={(e) =>
                onSortsChange(
                  sorts.map((x) => (x.id === s.id ? { ...x, desc: e.target.value === "desc" } : x)),
                )
              }
            >
              <option value="asc">升序 A→Z / 小→大</option>
              <option value="desc">降序 Z→A / 大→小</option>
            </select>
            <button
              className="icon-btn"
              title="移除该排序字段"
              onClick={() => onSortsChange(sorts.filter((x) => x.id !== s.id))}
              style={{ width: "1.6rem", height: "1.6rem" }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <div className="row">
          <button
            className="btn sm ghost"
            disabled={!columns.length}
            onClick={() => onSortsChange([...sorts, { id: uid(), column: firstCol, desc: false }])}
          >
            <Plus size={13} /> 添加排序字段
          </button>
        </div>
      </div>

      <div className="filter-section">
        <div className="filter-section-head">
          <SlidersHorizontal size={13} /> 筛选
          <span className="toolbar-hint">选择字段 + 条件，无需手写 SQL</span>
        </div>
        {filters.map((f, i) => {
          const needsValue = opInfo(f.op).needsValue;
          return (
            <div className="filter-row" key={f.id}>
              {i === 0 ? (
                <span className="filter-order">WHERE</span>
              ) : (
                <select
                  className="select filter-joiner"
                  value={f.joiner}
                  onChange={(e) =>
                    onFiltersChange(
                      filters.map((x) =>
                        x.id === f.id ? { ...x, joiner: e.target.value as "AND" | "OR" } : x,
                      ),
                    )
                  }
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
              )}
              <select
                className="select filter-col"
                value={f.column}
                onChange={(e) =>
                  onFiltersChange(
                    filters.map((x) => (x.id === f.id ? { ...x, column: e.target.value } : x)),
                  )
                }
              >
                {colOptions}
              </select>
              <select
                className="select filter-op"
                value={f.op}
                onChange={(e) =>
                  onFiltersChange(filters.map((x) => (x.id === f.id ? { ...x, op: e.target.value } : x)))
                }
              >
                {FILTER_OPS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
              {needsValue && (
                <input
                  className="input filter-value"
                  value={f.value}
                  placeholder={f.op === "IN" ? "a,b,c" : "值"}
                  onChange={(e) =>
                    onFiltersChange(
                      filters.map((x) => (x.id === f.id ? { ...x, value: e.target.value } : x)),
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onApply();
                  }}
                />
              )}
              <button
                className="icon-btn"
                title="移除该条件"
                onClick={() => onFiltersChange(filters.filter((x) => x.id !== f.id))}
                style={{ width: "1.6rem", height: "1.6rem" }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            className="btn sm ghost"
            disabled={!columns.length}
            onClick={() =>
              onFiltersChange([
                ...filters,
                { id: uid(), column: firstCol, op: "=", value: "", joiner: "AND" },
              ])
            }
          >
            <Plus size={13} /> 添加条件
          </button>
          <button className="btn sm primary" onClick={onApply} disabled={!columns.length}>
            应用
          </button>
          <button className="btn sm ghost" onClick={onClear}>
            清除
          </button>
          {appliedHint && <span className="toolbar-hint">{appliedHint}</span>}
        </div>
      </div>
    </div>
  );
}
