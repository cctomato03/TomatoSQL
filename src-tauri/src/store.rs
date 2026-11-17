//! 本地工作区持久化：连接、分组、设置保存在应用数据目录的 workspace.json。
//!
//! 敏感字段（连接密码、云同步 token）在这里做 AES-256-GCM 加密后再落盘，
//! 内存与 IPC 中使用的是明文，便于界面编辑与连接使用。

use crate::crypto;
use crate::model::{now_ms, Workspace};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const WORKSPACE_FILE: &str = "workspace.json";

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir)
}

fn workspace_path(dir: &Path) -> PathBuf {
    dir.join(WORKSPACE_FILE)
}

/// 把敏感字段替换为密文（返回可落盘的 JSON 值）
fn encrypt_secrets(mut value: Value) -> Value {
    if let Some(conns) = value.get_mut("connections").and_then(|c| c.as_array_mut()) {
        for conn in conns.iter_mut() {
            if let Some(pwd) = conn.get("password").and_then(|p| p.as_str()) {
                if !pwd.is_empty() && !pwd.starts_with("enc:v1:") {
                    let enc = crypto::encrypt(pwd);
                    conn["password"] = json!(enc);
                }
            }
        }
    }
    if let Some(token) = value.pointer("/settings/cloud/token") {
        if let Some(t) = token.as_str() {
            if !t.is_empty() && !t.starts_with("enc:v1:") {
                let enc = crypto::encrypt(t);
                if let Some(slot) = value.pointer_mut("/settings/cloud/token") {
                    *slot = json!(enc);
                }
            }
        }
    }
    value
}

/// 还原密文字段（读取后供内存使用）
fn decrypt_secrets(mut value: Value) -> Value {
    if let Some(conns) = value.get_mut("connections").and_then(|c| c.as_array_mut()) {
        for conn in conns.iter_mut() {
            if let Some(pwd) = conn.get("password").and_then(|p| p.as_str()) {
                if pwd.starts_with("enc:v1:") {
                    let plain = crypto::decrypt(pwd);
                    conn["password"] = json!(plain);
                }
            }
        }
    }
    if let Some(token) = value
        .pointer("/settings/cloud/token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
    {
        if token.starts_with("enc:v1:") {
            let plain = crypto::decrypt(&token);
            if let Some(slot) = value.pointer_mut("/settings/cloud/token") {
                *slot = json!(plain);
            }
        }
    }
    value
}

/// 序列化为可落盘文本（密码为密文）
pub fn encode(ws: &Workspace) -> Result<String, String> {
    let value = serde_json::to_value(ws).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&encrypt_secrets(value)).map_err(|e| e.to_string())
}

/// 从落盘文本还原（密码为明文）
pub fn decode(text: &str) -> Result<Workspace, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    serde_json::from_value(decrypt_secrets(value)).map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Workspace {
    let Ok(dir) = data_dir(app) else {
        return Workspace::default();
    };
    let path = workspace_path(&dir);
    let Ok(text) = fs::read_to_string(&path) else {
        return Workspace::default();
    };
    match decode(&text) {
        Ok(mut ws) => {
            if ws.updated_at == 0 {
                ws.updated_at = now_ms();
            }
            ws
        }
        Err(err) => {
            eprintln!("workspace.json 解析失败，已忽略: {err}");
            let _ = fs::copy(&path, dir.join(format!("workspace.corrupt.{}.json", now_ms())));
            Workspace::default()
        }
    }
}

pub fn save(app: &AppHandle, ws: &Workspace) -> Result<(), String> {
    let dir = data_dir(app)?;
    let path = workspace_path(&dir);
    let text = encode(ws)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存失败: {e}"))?;
    Ok(())
}
