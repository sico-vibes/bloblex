//! Microphone level metering for the dictation bubble.
//!
//! The bubble renders a wave that reacts to the live microphone. The worker
//! computes a root-mean-square level per audio block and the surface applies
//! its own perceptual curve, so the raw value here stays simple and testable.

/// Root-mean-square level of mono samples, clamped to `0.0..=1.0`.
pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum / samples.len() as f32).sqrt().clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::rms_level;

    #[test]
    fn empty_is_silent() {
        assert_eq!(rms_level(&[]), 0.0);
    }

    #[test]
    fn silence_is_zero() {
        assert_eq!(rms_level(&[0.0; 256]), 0.0);
    }

    #[test]
    fn full_scale_is_one() {
        assert!((rms_level(&[1.0; 64]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn magnitude_ignores_sign() {
        let samples = [0.5, -0.5, 0.5, -0.5];
        assert!((rms_level(&samples) - 0.5).abs() < 1e-6);
    }
}
