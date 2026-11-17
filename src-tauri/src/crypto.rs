//! 本地敏感信息（数据库密码、云端 token）加密：AES-256-GCM + 设备本地密钥文件。
//! 说明：这是"静态加密"，密钥随应用数据目录保存，主要用于避免明文口令落盘。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

static KEY: OnceLock<[u8; 32]> = OnceLock::new();

const ENC_PREFIX: &str = "enc:v1:";

/// 读取（或首次生成）设备密钥，必须在读取工作区之前调用。
pub fn init(dir: &Path) {
    if KEY.get().is_some() {
        return;
    }
    let path = dir.join("secret.key");
    let key = fs::read(&path)
        .ok()
        .and_then(|b| {
            if b.len() >= 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&b[..32]);
                Some(k)
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            let mut k = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut k);
            let _ = fs::create_dir_all(dir);
            let _ = fs::write(&path, k);
            k
        });
    let _ = KEY.set(key);
}

fn cipher() -> Option<Aes256Gcm> {
    KEY.get().map(|k| Aes256Gcm::new(From::from(k)))
}

pub fn encrypt(plain: &str) -> String {
    let Some(c) = cipher() else {
        return plain.to_string();
    };
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    match c.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()) {
        Ok(mut ct) => {
            let mut out = Vec::with_capacity(12 + ct.len());
            out.extend_from_slice(&nonce);
            out.append(&mut ct);
            format!("{ENC_PREFIX}{}", B64.encode(out))
        }
        Err(_) => plain.to_string(),
    }
}

pub fn decrypt(stored: &str) -> String {
    if !stored.starts_with(ENC_PREFIX) {
        return stored.to_string();
    }
    let Some(c) = cipher() else {
        return String::new();
    };
    let Ok(raw) = B64.decode(&stored[ENC_PREFIX.len()..]) else {
        return String::new();
    };
    if raw.len() < 13 {
        return String::new();
    }
    let (nonce, body) = raw.split_at(12);
    c.decrypt(Nonce::from_slice(nonce), body)
        .map(|p| String::from_utf8_lossy(&p).to_string())
        .unwrap_or_default()
}
