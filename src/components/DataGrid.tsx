import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, KeyRound } from "lucide-react";
import type { Cell, ColumnMeta } from "../types";
import { Empty } from "./ui";

export interface GridProps {
  columns: ColumnMeta[];
  rows: Cell[][];
  primaryKey?: string[];
  editable?: boolean;
  dirty?: Set<string>;
  sortBy?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  onCommit?: (rowIndex: number, column: string, value: Cell) => void;
  onSelectRow?: (rowIndex: number) => void;
  selectedRow?: number | null;
  emptyText?: string;
}

export function DataGrid({
  columns,
  rows,
  primaryKey = [],
  editable = false,
  dirty,
  sortBy,
  onSort,
  onCommit,
  onSelectRow,
  selectedRow,
  emptyText,
}: GridProps) {
  const [edit, setEdit] = useState<{ r: number; c: number; value: string } | null>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (edit && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [edit]);

  if (!columns.length) {
    return <Empty title="没有结果" text={emptyText ?? "该表暂无列信息或查询未返回结果。"} />;
  }

  const commit = () => {
    if (!edit) return;
    const col = columns[edit.c]?.name;
    if (col && onCommit) {
      const original = rows[edit.r]?.[edit.c] ?? null;
      if ((original ?? "") !== edit.value) {
        onCommit(edit.r, col, edit.value === "" ? null : edit.value);
      }
    }
    setEdit(null);
  };

  const isPk = (name: string) => primaryKey.some((k) => k.toLowerCase() === name.toLowerCase());

  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="rowno" style={{ cursor: "default" }}>
              #
            </th>
            {columns.map((c, ci) => {
              const sorted = sortBy?.column === c.name;
              return (
                <th
                  key={`${c.name}-${ci}`}
                  onClick={() => onSort?.(c.name)}
                  className={sel?.c === ci ? "selected-cell" : ""}
                  title={`${c.name}${c.dataType ? ` · ${c.dataType}` : ""}`}
                >
                  <span className="th-name">
                    {isPk(c.name) && <KeyRound size={11} color="var(--warn)" />}
                    {c.name}
                    {sorted &&
                      (sortBy?.desc ? (
                        <ArrowDown size={11} className="sort" />
                      ) : (
                        <ArrowUp size={11} className="sort" />
                      ))}
                  </span>
                  {c.dataType && <span className="th-type">{c.dataType.toLowerCase()}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={selectedRow === ri ? "row-selected" : ""}>
              <td className="rowno">{ri + 1}</td>
              {columns.map((c, ci) => {
                const value = row[ci] ?? null;
                const isEditing = edit?.r === ri && edit?.c === ci;
                const key = `${ri}:${c.name}`;
                const isDirty = dirty?.has(key);
                return (
                  <td
                    key={`${c.name}-${ci}`}
                    className={[
                      sel?.r === ri && sel?.c === ci ? "selected-cell" : "",
                      isDirty ? "dirty" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      setSel({ r: ri, c: ci });
                      onSelectRow?.(ri);
                    }}
                    onDoubleClick={() => {
                      if (!editable) return;
                      setEdit({ r: ri, c: ci, value: value ?? "" });
                    }}
                    title={value ?? "NULL"}
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className="cell-edit"
                        value={edit!.value}
                        onChange={(e) => setEdit({ ...edit!, value: e.target.value })}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEdit(null);
                          }
                        }}
                      />
                    ) : value === null ? (
                      <span className="cell-null">NULL</span>
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="rowno">—</td>
              <td colSpan={columns.length} style={{ color: "var(--text-3)", padding: "0.8rem" }}>
                没有数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
