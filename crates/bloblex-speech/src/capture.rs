//! Microphone capture via cpal.
//!
//! Runs the input stream on its own thread (cpal streams are not `Send` on all
//! backends) and delivers raw interleaved frames to a callback. Resampling to
//! 16 kHz mono happens later, before the sherpa-onnx boundary.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::error::{SpeechError, SpeechResult};

#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct CaptureSession {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureSession {
    /// Stop capture and wait for the audio thread to release the device.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Start capturing from the default input device. The callback runs on the audio
/// thread, so keep it cheap (send over a channel rather than decoding inline).
pub fn start_capture<F>(mut on_frame: F) -> SpeechResult<CaptureSession>
where
    F: FnMut(AudioFrame) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();

    let handle = thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("no default input device is available".into()));
            return;
        };
        let supported = match device.default_input_config() {
            Ok(config) => config,
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };
        if supported.sample_format() != cpal::SampleFormat::F32 {
            let _ = ready_tx.send(Err(format!(
                "unsupported sample format: {:?}",
                supported.sample_format()
            )));
            return;
        }
        let stream_config: cpal::StreamConfig = supported.into();
        let sample_rate = stream_config.sample_rate.0;
        let channels = stream_config.channels;

        let stream = match device.build_input_stream(
            &stream_config,
            move |data: &[f32], _info| {
                on_frame(AudioFrame {
                    samples: data.to_vec(),
                    sample_rate,
                    channels,
                });
            },
            |error| eprintln!("Bloblex audio capture: {error}"),
            None,
        ) {
            Ok(stream) => stream,
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };
        if let Err(error) = stream.play() {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
        let _ = ready_tx.send(Ok(()));

        while !stop_thread.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
    });

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(CaptureSession {
            stop,
            thread: Some(handle),
        }),
        Ok(Err(error)) => Err(SpeechError::Capture(error)),
        Err(_) => Err(SpeechError::Capture("capture thread exited early".into())),
    }
}
