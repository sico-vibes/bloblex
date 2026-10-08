//! Pinned model catalog. File names, sizes, and SHA-256 hashes are copied from
//! Orca's `model-download-catalog.ts` (MIT) so a Bloblex download is equivalent
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

fn build_catalog() -> Vec<SpeechModelManifest> {
    vec![parakeet_tdt_v3(), parakeet_tdt_v2(), zipformer_streaming_en()]
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
