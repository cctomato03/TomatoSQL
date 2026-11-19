/** 与 Rust 端 serde(camelCase) 对应的类型定义 */

export type DbKind = "mysql" | "sqlite";

export interface Connection {
  id: string;
  name: string;
  kind: DbKind;
  groupId?: string | null;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  charset?: string | null;
  sslMode?: string | null;
  file?: string | null;
  database?: string | null;
  readOnly?: boolean;
  color?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Group {
  id: string;
  name: string;
  parentId?: string | null;
  color?: string | null;
  order: number;
  expanded: boolean;
}

export interface CloudSettings {
  serverUrl: string;
  username: string;
  token?: string | null;
  lastSyncAt?: number | null;
  autoPush: boolean;
}

export interface Settings {
  themeId: string;
  fontSize: number;
  editorFontSize: number;
  rowHeight: number;
  pageSize: number;
  confirmDestructive: boolean;
  showLineNumbers: boolean;
  language: string;
  cloud: CloudSettings;
}

export interface Workspace {
  version: number;
  groups: Group[];
  connections: Connection[];
  savedQueries: SavedQuery[];
  settings: Settings;
  updatedAt: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
  arch: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  version?: string | null;
  latencyMs: number;
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
  rows?: number | null;
  comment?: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  key: string;
  defaultValue?: string | null;
  extra: string;
  comment?: string | null;
  position: number;
  length?: number | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface RoutineInfo {
  name: string;
  /** FUNCTION | PROCEDURE */
  kind: string;
  returns?: string | null;
}

export interface BackupFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  connId: string;
  database: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

export interface ColumnMeta {
  name: string;
  dataType?: string;
}

export type Cell = string | null;

export interface QueryResult {
  statement: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  rowsAffected: number;
  lastInsertId?: number | null;
  durationMs: number;
  message: string;
  truncated: boolean;
}

export interface RowsPage {
  columns: ColumnMeta[];
  primaryKey: string[];
  rows: Cell[][];
  total: number;
  limit: number;
  offset: number;
  durationMs: number;
}

export interface PkPair {
  column: string;
  value: Cell;
}

export interface RowChange {
  action: "update" | "insert" | "delete";
  pk: PkPair[];
  values: PkPair[];
}

export interface ApplyResult {
  applied: number;
  errors: string[];
}

export interface ExportRequest {
  connId: string;
  database: string;
  tables: string[];
  sql?: string | null;
  format: "csv" | "json" | "sql";
  filePath: string;
  includeHeader: boolean;
  delimiter: string;
  includeStructure: boolean;
  includeData: boolean;
  nullAs?: string | null;
  batchSize: number;
}

export interface ExportResult {
  rows: number;
  tables: number;
  bytes: number;
  filePath: string;
  durationMs: number;
}

export interface ImportRequest {
  connId: string;
  database: string;
  table: string;
  format: "csv" | "json" | "sql";
  filePath: string;
  hasHeader: boolean;
  delimiter: string;
  truncateFirst: boolean;
  createTable: boolean;
  onConflict: "error" | "ignore";
  batchSize: number;
  emptyAsNull: boolean;
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  failed: number;
  errors: string[];
  durationMs: number;
  table: string;
}

export interface ColumnDiff {
  name: string;
  status: "missingInTarget" | "missingInSource" | "typeMismatch" | "ok";
  sourceType: string;
  targetType: string;
}

export interface IndexDiff {
  name: string;
  status: string;
  detail: string;
}

export interface TableDiff {
  name: string;
  status: "onlySource" | "onlyTarget" | "both" | "same";
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  sourceRows: number;
  targetRows: number;
  hasStructureChange: boolean;
}

export interface CompareReport {
  tables: TableDiff[];
  sourceConn: string;
  targetConn: string;
  durationMs: number;
}

export interface SyncRequest {
  sourceConn: string;
  sourceDb: string;
  targetConn: string;
  targetDb: string;
  tables: string[];
  createTables: boolean;
  addColumns: boolean;
  createIndexes: boolean;
  copyData: boolean;
  truncateTarget: boolean;
  dropTargetTables: boolean;
}

export interface SyncStep {
  table: string;
  sql: string;
  ok: boolean;
  message: string;
  rows: number;
}

export interface SyncResult {
  steps: SyncStep[];
  succeeded: number;
  failed: number;
  durationMs: number;
}
