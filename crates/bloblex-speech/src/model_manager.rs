//! Model cache and download manager.
//!
//! Downloads pinned HuggingFace files with per-file SHA-256 verification and
//! resume support. Mirrors Orca's model-manager behavior (immutable revisions,
//! per-file hashes, resumable transport) without the Node runtime.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{SpeechError, SpeechResult};
use crate::manifest::{SpeechDownloadFile, SpeechModelManifest};

/// Reduce a model id to a filesystem-safe folder name.
pub fn sanitize_model_id(model_id: &str) -> String {
    model_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' || character == '.' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub fn model_directory(cache_root: &Path, model_id: &str) -> PathBuf {
    cache_root.join(sanitize_model_id(model_id))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

pub fn sha256_file_blocking(path: &Path) -> SpeechResult<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

/// Fast presence check used on startup: size match only. Full hashing of a
/// multi-hundred-megabyte encoder on every launch is not worth it; the hash is
/// verified once, immediately after a download completes.
pub fn has_expected_size(path: &Path, file: &SpeechDownloadFile) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() == file.size_bytes)
        .unwrap_or(false)
}

/// True when every pinned file is present at its expected size.
pub fn model_is_ready(directory: &Path, manifest: &SpeechModelManifest) -> bool {
    manifest
        .download_files
        .iter()
        .all(|file| has_expected_size(&directory.join(&file.name), file))
}

/// Ensure the model is fully cached, downloading and verifying anything missing.
pub async fn ensure_model<F>(
    client: &reqwest::Client,
    cache_root: &Path,
    manifest: &SpeechModelManifest,
    mut progress: F,
) -> SpeechResult<PathBuf>
where
    F: FnMut(u64, u64) + Send,
{
    let directory = model_directory(cache_root, &manifest.id);
    tokio::fs::create_dir_all(&directory).await?;
    let total = manifest.size_bytes;
    let mut completed: u64 = 0;
    for file in &manifest.download_files {
        let destination = directory.join(&file.name);
        if has_expected_size(&destination, file) {
            completed += file.size_bytes;
            progress(completed, total);
            continue;
        }
        download_one(client, file, &destination).await?;
        completed += file.size_bytes;
        progress(completed, total);
    }
    Ok(directory)
}

async fn download_one(
    client: &reqwest::Client,
    file: &SpeechDownloadFile,
    destination: &Path,
) -> SpeechResult<()> {
    let partial = destination.with_file_name(format!("{}.partial", file.name));
    let existing = tokio::fs::metadata(&partial)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let mut request = client.get(&file.url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| SpeechError::Download(error.to_string()))?;

    let resume = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut handle = if resume {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .await?
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&partial)
            .await?
    };

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| SpeechError::Download(error.to_string()))?
    {
        handle.write_all(&chunk).await?;
    }
    handle.flush().await?;
    drop(handle);

    let metadata = tokio::fs::metadata(&partial).await?;
    if metadata.len() != file.size_bytes {
        return Err(SpeechError::Integrity(format!(
            "{}: expected {} bytes, found {}",
            file.name,
            file.size_bytes,
            metadata.len()
        )));
    }
    let actual = sha256_file_blocking(&partial)?;
    if !actual.eq_ignore_ascii_case(&file.sha256) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(SpeechError::Integrity(file.name.clone()));
    }
    tokio::fs::rename(&partial, destination).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{has_expected_size, model_directory, sanitize_model_id, sha256_bytes, sha256_file_blocking};
    use crate::manifest::SpeechDownloadFile;
    use std::path::Path;

    #[test]
    fn model_ids_are_filesystem_safe() {
        assert_eq!(sanitize_model_id("parakeet-tdt-0.6b-v3-int8"), "parakeet-tdt-0.6b-v3-int8");
        assert_eq!(sanitize_model_id("a/b c"), "a_b_c");
    }

    #[test]
    fn model_directory_joins_sanitized_id() {
        let directory = model_directory(Path::new("C:/cache"), "a/b");
        assert!(directory.ends_with("a_b"));
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn file_hash_matches_byte_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tokens.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_file_blocking(&path).unwrap(), sha256_bytes(b"abc"));
    }

    #[test]
    fn size_check_rejects_mismatch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("decoder.onnx");
        std::fs::write(&path, b"1234").unwrap();
        let file = SpeechDownloadFile {
            name: "decoder.onnx".into(),
            url: "https://example.invalid".into(),
            size_bytes: 4,
            sha256: sha256_bytes(b"1234"),
        };
        assert!(has_expected_size(&path, &file));
        let wrong = SpeechDownloadFile {
            size_bytes: 5,
            ..file
        };
        assert!(!has_expected_size(&path, &wrong));
    }
}
