mod backup;
mod commands;
mod crypto;
mod db;
mod model;
mod store;
mod sync;
mod transfer;

#[cfg(test)]
mod tests;

use db::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 初始化数据目录与本地加密密钥
            if let Ok(dir) = store::data_dir(app.handle()) {
                crypto::init(&dir);
            }
            app.manage(AppState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ws_load,
            commands::ws_save,
            commands::app_info,
            commands::conn_test,
            commands::db_connect,
            commands::db_disconnect,
            commands::db_is_open,
            commands::db_databases,
            commands::db_tables,
            commands::db_columns,
            commands::db_indexes,
            commands::db_routines,
            commands::backup_list,
            commands::backup_create,
            commands::backup_restore,
            commands::backup_delete,
            commands::backup_dir,
            commands::db_ddl,
            commands::db_query,
            commands::db_fetch_rows,
            commands::db_row_count,
            commands::db_insert_row,
            commands::db_apply_changes,
            commands::export_data,
            commands::import_data,
            commands::db_compare,
            commands::db_apply_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
