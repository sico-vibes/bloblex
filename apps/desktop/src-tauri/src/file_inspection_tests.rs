use super::inspect_local_file;
use std::{
    fs,
    path::{Path, PathBuf},
};

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("bloblex-file-inspection-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create isolated file inspection test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn returns_canonical_path_name_and_byte_count_without_changing_contents() {
    let tree = TempTree::new();
    let file = tree.path().join("sample file.txt");
    let contents = "Bloblex local reference — contents stay untouched\n".as_bytes();
    fs::write(&file, contents).expect("write fixture");

    let inspection = inspect_local_file(file.to_string_lossy().into_owned())
        .expect("regular readable file should be inspectable");

    assert_eq!(
        PathBuf::from(&inspection.path),
        fs::canonicalize(&file).unwrap()
    );
    assert_eq!(inspection.file_name, "sample file.txt");
    assert_eq!(inspection.size_bytes, contents.len() as u64);
    assert_eq!(
        fs::read(&file).unwrap(),
        contents,
        "inspection must not alter file contents"
    );
}

#[test]
fn supports_paths_with_spaces_and_non_ascii_names() {
    let tree = TempTree::new();
    let file = tree.path().join("café 数据 file.txt");
    fs::write(&file, b"metadata only").expect("write unicode path fixture");

    let inspection = inspect_local_file(file.to_string_lossy().into_owned())
        .expect("Unicode file path should be inspectable");

    assert_eq!(inspection.file_name, "café 数据 file.txt");
    assert_eq!(inspection.size_bytes, 13);
    assert_eq!(
        PathBuf::from(inspection.path),
        fs::canonicalize(file).unwrap()
    );
}

#[test]
fn rejects_missing_paths_and_directories() {
    let tree = TempTree::new();
    let missing = tree.path().join("missing file.txt");
    let missing_error = inspect_local_file(missing.to_string_lossy().into_owned())
        .err()
        .expect("missing path must fail");
    assert_eq!(missing_error, "The selected file could not be found.");

    let directory_error = inspect_local_file(tree.path().to_string_lossy().into_owned())
        .err()
        .expect("directory must not be accepted as a file");
    assert_eq!(directory_error, "The selected path is not a file.");
}

#[cfg(windows)]
#[test]
fn reports_a_file_that_windows_denies_opening_for_shared_read() {
    use std::os::windows::fs::OpenOptionsExt;

    let tree = TempTree::new();
    let file = tree.path().join("locked.txt");
    fs::write(&file, b"locked fixture").expect("write lock fixture");
    let _exclusive = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&file)
        .expect("hold exclusive Windows handle");

    let error = inspect_local_file(file.to_string_lossy().into_owned())
        .err()
        .expect("inspection must report an exclusive-sharing conflict");
    assert_eq!(
        error,
        "Bloblex cannot read this file path with the current Windows account."
    );
}
