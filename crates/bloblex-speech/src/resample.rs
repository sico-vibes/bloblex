//! Audio helpers that run before the native sherpa-onnx boundary.
//!
//! Mirrors Orca's `stt-audio-resample.ts`: normalize everything to mono 16 kHz
//! Float32 *before* inference, because the native stream aborts the process if a
//! recognizer sees a different input rate mid-session.

/// Average interleaved multi-channel frames down to mono.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut sum = 0.0f32;
        for channel in 0..channels {
            sum += interleaved[frame * channels + channel];
        }
        mono.push(sum / channels as f32);
    }
    mono
}

/// Linear-interpolation resampler. Good enough for speech, dependency-free, and
/// deterministic for tests.
pub fn resample_to_rate(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == 0 || to_rate == 0 || from_rate == to_rate {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut output = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let source = index as f64 / ratio;
        let base = source.floor() as usize;
        let fraction = (source - base as f64) as f32;
        let first = input.get(base).copied().unwrap_or(0.0);
        let second = input.get(base + 1).copied().unwrap_or(first);
        output.push(first + (second - first) * fraction);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{downmix_to_mono, resample_to_rate};

    #[test]
    fn stereo_frames_average_to_mono() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(downmix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn mono_passes_through_unchanged() {
        let mono = [0.1, 0.2, 0.3];
        assert_eq!(downmix_to_mono(&mono, 1), mono.to_vec());
    }

    #[test]
    fn same_rate_is_identity() {
        let input = [0.1, 0.2, 0.3, 0.4];
        assert_eq!(resample_to_rate(&input, 16_000, 16_000), input.to_vec());
    }

    #[test]
    fn downsampling_produces_proportional_length() {
        let input = vec![0.0f32; 48_000];
        let output = resample_to_rate(&input, 48_000, 16_000);
        assert_eq!(output.len(), 16_000);
    }

    #[test]
    fn upsampling_preserves_endpoints_of_a_ramp() {
        let input = [0.0, 1.0];
        let output = resample_to_rate(&input, 8_000, 16_000);
        assert_eq!(output.len(), 4);
        assert_eq!(output[0], 0.0);
        assert!((output[3] - 1.0).abs() < 1e-6);
    }
}
