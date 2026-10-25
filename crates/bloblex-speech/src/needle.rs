//! Cactus Whistle, run through Cactus's prebuilt `needle.exe` as a local subprocess (FIX43).
//!
//! Why a subprocess and not a linked library: the published Windows `libneedle.a` is one llvm-mingw object that
//! needs libc++ and the Itanium unwinder (`std::__1`, `__gxx_personality_seh0`, `_Unwind_Resume`, `__cxa_*`). The
//! MSVC toolchain ships none of those, so the library cannot be linked into this crate. The prebuilt
//! `windows-x86_64/needle.exe` from the same Hugging Face repository (pinned by revision and SHA-256 in the
//! catalog) is run instead. A crash in it ends one decode, never the app.
//!
//! Audio goes to the engine as a short-lived 16-bit WAV file in the model folder, deleted as soon as the run ends,
//! and never as command-line text. The command line holds two file paths and nothing else. Nothing the engine
//! prints is logged; only the transcript text is read from its output.
//!
//! The engine's `--audio` output is read leniently (one JSON object with a `text` field, as `needle_transcribe`
//! documents), because the runner's own output format is not part of the published C API.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::error::{SpeechError, SpeechResult};

/// A run that takes longer than this is abandoned (a 20 s utterance decodes in a fraction of a second).
const RUN_TIMEOUT: Duration = Duration::from_secs(25);

/// Sixteen-bit mono PCM WAV for 16 kHz float samples in [-1, 1].
pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// The transcript in the engine's output: the `text` of the last JSON object it printed (or `audio_text` when
/// the text and speech fields are merged). Anything else is not a transcript.
pub fn parse_transcript(stdout: &str) -> Option<String> {
    let candidates = std::iter::once(stdout.trim()).chain(stdout.lines().rev().map(str::trim).filter(|line| line.starts_with('{')));
    for candidate in candidates {
        let Ok(value) = serde_json::from_str::<Value>(candidate) else { continue };
        let text = value["text"].as_str().or_else(|| value["audio_text"].as_str());
        if let Some(text) = text {
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            return (!text.is_empty()).then_some(text);
        }
    }
    None
}

/// Deletes the audio file when the run is over, whatever happened.
struct TempAudio(PathBuf);

impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

type Launcher = Box<dyn Fn(&Path) -> SpeechResult<String> + Send>;

pub struct NeedleRunner {
    scratch: PathBuf,
    launcher: Launcher,
    counter: u64,
}

impl NeedleRunner {
    /// The real engine: `needle.exe --model <whistle.cact> --audio <clip.wav>`, run without a console window.
    pub fn subprocess(executable: PathBuf, model: PathBuf, scratch: PathBuf) -> Self {
        Self::with_launcher(scratch, Box::new(move |clip| run_subprocess(&executable, &model, clip)))
    }

    pub fn with_launcher(scratch: PathBuf, launcher: Launcher) -> Self {
        Self { scratch, launcher, counter: 0 }
    }

    /// Transcribe 16 kHz mono samples. `None` means nothing was heard.
    pub fn transcribe(&mut self, samples: &[f32], sample_rate: u32) -> SpeechResult<Option<String>> {
        std::fs::create_dir_all(&self.scratch)?;
        self.counter += 1;
        let clip = TempAudio(self.scratch.join(format!("clip-{}-{}.wav", std::process::id(), self.counter)));
        std::fs::write(&clip.0, wav_bytes(samples, sample_rate))?;
        let stdout = (self.launcher)(&clip.0)?;
        Ok(parse_transcript(&stdout))
    }

    /// Remove clips an earlier crash left behind.
    pub fn sweep_scratch(scratch: &Path) {
        let Ok(entries) = std::fs::read_dir(scratch) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) == Some("wav") {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn run_subprocess(executable: &Path, model: &Path, clip: &Path) -> SpeechResult<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut command = Command::new(executable);
    command.arg("--model").arg(model).arg("--audio").arg(clip).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| SpeechError::Engine(format!("could not start the Whistle engine: {error}")))?;
    let mut stdout = child.stdout.take().ok_or_else(|| SpeechError::Engine("the Whistle engine gave no output".into()))?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                return if status.success() { Ok(text) } else { Err(SpeechError::Engine("the Whistle engine stopped with an error".into())) };
            }
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SpeechError::Engine("the Whistle engine took too long".into()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(error) => return Err(SpeechError::Engine(format!("the Whistle engine could not be watched: {error}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_transcript, wav_bytes, NeedleRunner};
    use std::sync::{Arc, Mutex};

    #[test]
    fn the_wav_header_describes_16_bit_mono_audio_at_the_given_rate() {
        let wav = wav_bytes(&[0.0, 0.5, -0.5, 1.5], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "bits");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8, "four samples, two bytes each");
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -16384, "-0.5");
        assert_eq!(i16::from_le_bytes([wav[50], wav[51]]), 32767, "a sample above 1.0 is clamped");
    }

    #[test]
    fn the_transcript_is_the_text_of_the_json_the_engine_prints() {
        assert_eq!(parse_transcript(r#"{"text":"turn off the kitchen lights","language":"en","ttft_ms":12.5,"decode_tps":300.1}"#).as_deref(), Some("turn off the kitchen lights"));
        assert_eq!(parse_transcript("loading model\n{\"text\":\"  hello   there \",\"language\":\"en\"}\n").as_deref(), Some("hello there"));
        assert_eq!(parse_transcript(r#"{"type":"respond","audio_text":"merged fields"}"#).as_deref(), Some("merged fields"));
        assert_eq!(parse_transcript(r#"{"text":"","language":""}"#), None, "silence is an empty transcript");
        for noise in ["", "no json here", "{broken", "[1,2]", r#"{"words":[]}"#] {
            assert_eq!(parse_transcript(noise), None, "{noise:?}");
        }
    }

    #[test]
    fn the_clip_exists_while_the_engine_runs_and_is_gone_afterwards() {
        let scratch = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::<(bool, usize)>::new()));
        let log = Arc::clone(&seen);
        let mut runner = NeedleRunner::with_launcher(scratch.path().join("tmp"), Box::new(move |clip| {
            let bytes = std::fs::read(clip).unwrap();
            log.lock().unwrap().push((clip.extension().is_some_and(|extension| extension == "wav"), bytes.len()));
            Ok(r#"{"text":"words"}"#.to_string())
        }));
        assert_eq!(runner.transcribe(&[0.1; 160], 16_000).unwrap().as_deref(), Some("words"));
        assert_eq!(*seen.lock().unwrap(), vec![(true, 44 + 320)]);
        assert_eq!(std::fs::read_dir(scratch.path().join("tmp")).unwrap().count(), 0, "the audio is deleted at once");
    }

    #[test]
    fn a_failed_run_still_deletes_the_clip_and_reports_the_failure() {
        let scratch = tempfile::tempdir().unwrap();
        let mut runner = NeedleRunner::with_launcher(scratch.path().to_path_buf(), Box::new(|_| Err(crate::error::SpeechError::Engine("boom".into()))));
        assert!(runner.transcribe(&[0.1; 16], 16_000).is_err());
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }

    #[test]
    fn leftover_clips_from_a_crash_are_swept() {
        let scratch = tempfile::tempdir().unwrap();
        std::fs::write(scratch.path().join("clip-1-1.wav"), b"x").unwrap();
        std::fs::write(scratch.path().join("keep.txt"), b"x").unwrap();
        NeedleRunner::sweep_scratch(scratch.path());
        assert!(!scratch.path().join("clip-1-1.wav").exists());
        assert!(scratch.path().join("keep.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_executable_is_an_engine_error_not_a_panic() {
        let scratch = tempfile::tempdir().unwrap();
        let mut runner = NeedleRunner::subprocess(scratch.path().join("no-such-needle.exe"), scratch.path().join("whistle.cact"), scratch.path().join("tmp"));
        let error = runner.transcribe(&[0.1; 16], 16_000).unwrap_err();
        assert!(error.to_string().contains("could not start the Whistle engine"), "{error}");
    }
}
