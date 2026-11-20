import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  ApplyResult,
  BackupFile,
  ColumnInfo,
  CompareReport,
  Connection,
  ExportRequest,
  ExportResult,
  Group,
  ImportRequest,
  ImportResult,
  IndexInfo,
  PkPair,
  QueryResult,
  RoutineInfo,
  RowChange,
  RowsPage,
  SyncRequest,
  SyncResult,
  TableInfo,
  TestResult,
  Workspace,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    return Promise.reject(
      new Error("当前不在 Tauri 运行环境。请使用 `npm run dev:app` 或打包后的应用启动。"),
    );
  }
  return invoke<T>(cmd, args);
}

export const api = {
  // 工作区
  loadWorkspace: () => call<Workspace>("ws_load"),
  saveWorkspace: (ws: Workspace) => call<void>("ws_save", { ws }),
  appInfo: () => call<AppInfo>("app_info"),

  // 连接
  testConnection: (cfg: Connection) => call<TestResult>("conn_test", { cfg }),
  connect: (connId: string, cfg: Connection) => call<string>("db_connect", { connId, cfg }),
  disconnect: (connId: string) => call<void>("db_disconnect", { connId }),
  isOpen: (connId: string) => call<boolean>("db_is_open", { connId }),

  // 元数据
  databases: (connId: string) => call<string[]>("db_databases", { connId }),
  tables: (connId: string, database: string) =>
    call<TableInfo[]>("db_tables", { connId, database }),
  columns: (connId: string, database: string, table: string) =>
    call<ColumnInfo[]>("db_columns", { connId, database, table }),
  indexes: (connId: string, database: string, table: string) =>
    call<IndexInfo[]>("db_indexes", { connId, database, table }),
  routines: (connId: string, database: string) =>
    call<RoutineInfo[]>("db_routines", { connId, database }),
  createDatabase: (connId: string, name: string, charset?: string) =>
    call<void>("db_create_database", { connId, name, charset: charset ?? null }),
  dropDatabase: (connId: string, name: string) =>
    call<void>("db_drop_database", { connId, name }),
  touchSqliteDb: (path: string) => call<void>("db_touch_sqlite_file", { path }),

  // 表级操作
  dropTable: (connId: string, database: string, table: string) =>
    call<void>("db_drop_table", { connId, database, table }),
  clearTable: (connId: string, database: string, table: string) =>
    call<number>("db_clear_table", { connId, database, table }),
  truncateTable: (connId: string, database: string, table: string) =>
    call<void>("db_truncate_table", { connId, database, table }),
  copyTable: (
    connId: string,
    database: string,
    table: string,
    newName: string,
    withData: boolean,
  ) => call<void>("db_copy_table", { connId, database, table, newName, withData }),
  applyTableDesign: (
    connId: string,
    database: string,
    table: string,
    change: { added: ColumnInfo[]; dropped: string[]; modified: ColumnInfo[] },
  ) => call<string[]>("db_apply_table_design", { connId, database, table, change }),
  ddl: (connId: string, database: string, table: string) =>
    call<string>("db_ddl", { connId, database, table }),
  rowCount: (connId: string, database: string, table: string) =>
    call<number>("db_row_count", { connId, database, table }),
  insertRow: (connId: string, database: string, table: string, values: PkPair[]) =>
    call<number>("db_insert_row", { connId, database, table, values }),

  // 查询与数据
  query: (connId: string, database: string, sql: string, maxRows = 5000) =>
    call<QueryResult[]>("db_query", { connId, database, sql, maxRows }),
  fetchRows: (
    connId: string,
    database: string,
    table: string,
    limit: number,
    offset: number,
    whereClause?: string | null,
    orderBy?: string | null,
  ) =>
    call<RowsPage>("db_fetch_rows", {
      connId,
      database,
      table,
      limit,
      offset,
      whereClause: whereClause ?? null,
      orderBy: orderBy ?? null,
    }),
  applyChanges: (
    connId: string,
    database: string,
    table: string,
    changes: RowChange[],
  ) => call<ApplyResult>("db_apply_changes", { connId, database, table, changes }),

  // 导入导出
  exportData: (req: ExportRequest) => call<ExportResult>("export_data", { req }),
  importData: (req: ImportRequest) => call<ImportResult>("import_data", { req }),

  // 比较与同步
  compare: (req: {
    sourceConn: string;
    sourceDb: string;
    targetConn: string;
    targetDb: string;
    tables: string[];
    compareData: boolean;
  }) => call<CompareReport>("db_compare", { req }),
  applySync: (req: SyncRequest) => call<SyncResult>("db_apply_sync", { req }),

  // 备份
  backupList: (connId: string, database: string) =>
    call<BackupFile[]>("backup_list", { connId, database }),
  backupCreate: (connId: string, database: string) =>
    call<BackupFile>("backup_create", { connId, database }),
  backupRestore: (connId: string, database: string, path: string) =>
    call<ImportResult>("backup_restore", { connId, database, path }),
  backupDelete: (path: string) => call<void>("backup_delete", { path }),
  backupDir: (connId: string) => call<string>("backup_dir", { connId }),
};

export type { Group };
