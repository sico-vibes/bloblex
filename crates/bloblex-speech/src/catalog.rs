//! Pinned model catalog. File names, sizes, and SHA-256 hashes are copied from
//! Orca's `model-download-catalog.ts` (MIT) so a Bitbots download is equivalent
//! to a pinned archive: immutable HuggingFace revision plus per-file hashes.

use std::sync::OnceLock;

use crate::manifest::{SpeechDownloadFile, SpeechModelManifest, SpeechModelType, SpeechProvider};

fn hugging_face_files(
    repository: &str,
    revision: &str,
    specs: &[(&str, u64, &str)],
) -> Vec<SpeechDownloadFile> {
    specs
        .iter()
        .map(|(name, size_bytes, sha256)| SpeechDownloadFile {
            name: (*name).to_string(),
            url: format!(
                "https://huggingface.co/{repository}/resolve/{revision}/{name}?download=true"
            ),
            size_bytes: *size_bytes,
            sha256: (*sha256).to_string(),
        })
        .collect()
}

// Flat constructor mirroring the pinned manifest fields; a builder would obscure the pinned values.
#[allow(clippy::too_many_arguments)]
fn manifest(
    id: &str,
    label: &str,
    description: &str,
    model_type: SpeechModelType,
    language: &str,
    sample_rate: u32,
    streaming: bool,
    modeling_unit: Option<&str>,
    recommended: bool,
    download_files: Vec<SpeechDownloadFile>,
) -> SpeechModelManifest {
    let size_bytes = download_files.iter().map(|file| file.size_bytes).sum();
    let files = download_files.iter().map(|file| file.name.clone()).collect();
    SpeechModelManifest {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        model_type,
        provider: SpeechProvider::Local,
        language: language.to_string(),
        files,
        download_files,
        size_bytes,
        sample_rate,
        streaming,
        modeling_unit: modeling_unit.map(str::to_string),
        recommended,
    }
}

fn parakeet_tdt_v3() -> SpeechModelManifest {
    manifest(
        "parakeet-tdt-0.6b-v3-int8",
        "Parakeet TDT v3",
        "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
        SpeechModelType::Transducer,
        "multilingual",
        16_000,
        false,
        Some("bpe"),
        true,
        hugging_face_files(
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
            "2bda32ec70b097a55adaa07d9a7173915b43cc78",
            &[
                (
                    "encoder.int8.onnx",
                    652_184_281,
                    "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
                ),
                (
                    "decoder.int8.onnx",
                    11_845_275,
                    "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
                ),
                (
                    "joiner.int8.onnx",
                    6_355_277,
                    "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
                ),
                (
                    "tokens.txt",
                    93_939,
                    "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
                ),
            ],
        ),
    )
}

fn parakeet_tdt_v2() -> SpeechModelManifest {
    manifest(
        "parakeet-tdt-0.6b-v2-int8",
        "Parakeet TDT v2",
        "English only. Faster than v3 with similar accuracy. Punctuation and capitalization.",
        SpeechModelType::Transducer,
        "en",
        16_000,
        false,
        Some("bpe"),
        false,
        hugging_face_files(
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
            "1ab9323565ddb038682214b292f588070a538ce2",
            &[
                (
                    "encoder.int8.onnx",
                    652_184_296,
                    "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
                ),
                (
                    "decoder.int8.onnx",
                    7_257_753,
                    "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
                ),
                (
                    "joiner.int8.onnx",
                    1_739_080,
                    "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
                ),
                (
                    "tokens.txt",
                    9_384,
                    "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
                ),
            ],
        ),
    )
}

fn zipformer_streaming_en() -> SpeechModelManifest {
    manifest(
        "zipformer-streaming-en-20m",
        "Zipformer Streaming EN",
        "English only. Lightweight 20M-param model with low-latency real-time partials.",
        SpeechModelType::Transducer,
        "en",
        16_000,
        true,
        Some("bpe"),
        false,
        hugging_face_files(
            "csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
            "d42f2d9f7ca24806fb667456a18a9f1b60f70d16",
            &[
                (
                    "encoder-epoch-99-avg-1.onnx",
                    88_804_590,
                    "f77a22f4ff94604e1afb2aeb13504d7699363528c047c97d3436087c95c9b659",
                ),
                (
                    "decoder-epoch-99-avg-1.onnx",
                    2_092_272,
                    "45a7f940ecfb53d89fa270ad11b88b961e53a317203eb24b1c8e95ed208b0f30",
                ),
                (
                    "joiner-epoch-99-avg-1.onnx",
                    1_026_462,
                    "343e17dffa4f386ca206e00d3c406908f68f473c3d35968d6c3cddd5b8559a94",
                ),
                (
                    "tokens.txt",
                    5_048,
                    "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb",
                ),
            ],
        ),
    )
}

/// Cactus Whistle: a 16.9 MB multilingual model that runs on the Needle engine. The two files come from two pinned
/// Hugging Face revisions: the model from `Cactus-Compute/whistle` and the engine, `windows-x86_64/needle.exe`, from
/// `Cactus-Compute/needle3` (Apache-2.0 both). The engine is a prebuilt executable that is run as a subprocess, so its
/// SHA-256 is checked after the download and again before every launch (`engine.rs`). Pinned 24 October 2026.
pub const WHISTLE_MODEL_ID: &str = "cactus-whistle-v1";
pub const WHISTLE_ENGINE_FILE: &str = "needle.exe";
pub const WHISTLE_MODEL_FILE: &str = "whistle.cact";

fn cactus_whistle() -> SpeechModelManifest {
    let download_files = vec![
        SpeechDownloadFile {
            name: WHISTLE_MODEL_FILE.to_string(),
            url: "https://huggingface.co/Cactus-Compute/whistle/resolve/741118687e1f008f06d1351a402a731274789790/whistle.cact?download=true".to_string(),
            size_bytes: 16_919_407,
            sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb".to_string(),
        },
        SpeechDownloadFile {
            name: WHISTLE_ENGINE_FILE.to_string(),
            url: "https://huggingface.co/Cactus-Compute/needle3/resolve/d6c7d6a2e9655505e0f8e23339356dd1705900eb/windows-x86_64/needle.exe?download=true".to_string(),
            size_bytes: 1_570_816,
            sha256: "0d4bc1da8c51f5600f5c4f4bb4a92e0abe142fae7b69e695ccab93e6745c883d".to_string(),
        },
    ];
    let size_bytes = download_files.iter().map(|file| file.size_bytes).sum();
    let files = download_files.iter().map(|file| file.name.clone()).collect();
    SpeechModelManifest {
        id: WHISTLE_MODEL_ID.to_string(),
        label: "Whistle".to_string(),
        description: "A very small model for English, German, French, Spanish, Italian, Dutch and Polish: 17 MB plus a 1.5 MB engine. Quick to download and light on memory; it is less accurate than Parakeet and may leave out punctuation.".to_string(),
        model_type: SpeechModelType::Needle,
        provider: SpeechProvider::Local,
        language: "multilingual".to_string(),
        files,
        download_files,
        size_bytes,
        sample_rate: 16_000,
        streaming: false,
        modeling_unit: None,
        recommended: false,
    }
}

fn build_catalog() -> Vec<SpeechModelManifest> {
    vec![parakeet_tdt_v3(), parakeet_tdt_v2(), zipformer_streaming_en(), cactus_whistle()]
}

static CATALOG: OnceLock<Vec<SpeechModelManifest>> = OnceLock::new();

/// The full catalog. Built once and shared for the process lifetime.
pub fn catalog() -> &'static [SpeechModelManifest] {
    CATALOG.get_or_init(build_catalog)
}

pub fn get_catalog_model(id: &str) -> Option<&'static SpeechModelManifest> {
    catalog().iter().find(|model| model.id == id)
}

/// The default model when the user has not chosen one.
pub fn default_model() -> &'static SpeechModelManifest {
    catalog()
        .iter()
        .find(|model| model.recommended)
        .unwrap_or_else(|| &catalog()[0])
}

#[cfg(test)]
mod tests {
    use super::{catalog, default_model, get_catalog_model, WHISTLE_ENGINE_FILE, WHISTLE_MODEL_FILE, WHISTLE_MODEL_ID};
    use crate::manifest::SpeechModelType;

    #[test]
    fn every_download_is_pinned_to_a_revision_and_a_sha256() {
        for model in catalog() {
            for file in &model.download_files {
                assert_eq!(file.sha256.len(), 64, "{} {}", model.id, file.name);
                assert!(file.sha256.chars().all(|character| character.is_ascii_hexdigit()), "{} {}", model.id, file.name);
                let revision = file.url.split("/resolve/").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or("");
                assert_eq!(revision.len(), 40, "{} {} must name a commit, not a branch: {}", model.id, file.name, file.url);
                assert!(file.url.starts_with("https://huggingface.co/"), "{}", file.url);
            }
            assert_eq!(model.size_bytes, model.download_files.iter().map(|file| file.size_bytes).sum::<u64>());
        }
        let ids: std::collections::HashSet<_> = catalog().iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids.len(), catalog().len(), "model ids are unique");
    }

    #[test]
    fn whistle_is_the_small_download_and_the_default_stays_parakeet() {
        let whistle = get_catalog_model(WHISTLE_MODEL_ID).expect("Whistle is in the catalogue");
        assert_eq!(whistle.model_type, SpeechModelType::Needle);
        assert!(!whistle.streaming && !whistle.recommended);
        assert_eq!(whistle.files, vec![WHISTLE_MODEL_FILE.to_string(), WHISTLE_ENGINE_FILE.to_string()]);
        let model = whistle.download_files.iter().find(|file| file.name == WHISTLE_MODEL_FILE).unwrap();
        assert!(model.url.contains("Cactus-Compute/whistle/resolve/741118687e1f008f06d1351a402a731274789790/"));
        assert_eq!((model.size_bytes, model.sha256.as_str()), (16_919_407, "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb"));
        let engine = whistle.download_files.iter().find(|file| file.name == WHISTLE_ENGINE_FILE).unwrap();
        assert!(engine.url.contains("Cactus-Compute/needle3/resolve/d6c7d6a2e9655505e0f8e23339356dd1705900eb/windows-x86_64/needle.exe"));
        assert_eq!((engine.size_bytes, engine.sha256.as_str()), (1_570_816, "0d4bc1da8c51f5600f5c4f4bb4a92e0abe142fae7b69e695ccab93e6745c883d"));
        assert!(whistle.size_bytes < 20_000_000, "about 17 MB of model plus the 1.5 MB engine");
        assert_eq!(default_model().id, "parakeet-tdt-0.6b-v3-int8", "the on-device default does not change");
    }
}
