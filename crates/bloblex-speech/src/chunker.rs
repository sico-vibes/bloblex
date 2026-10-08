//! Bounded offline audio chunker.
//!
//! Orca decodes one unbounded capture per offline model in a single call, which
//! makes ONNX tensor sizes scale with dictation length until a large allocation
//! crashes the process. This chunker feeds bounded windows instead and flushes a
//! final (by construction small) remainder on stop.

pub const DEFAULT_CHUNK_SECONDS: u32 = 30;

pub struct OfflineAudioChunker {
    sample_rate: u32,
    chunk_samples: usize,
    buffer: Vec<f32>,
}

impl OfflineAudioChunker {
    pub fn new(sample_rate: u32) -> Self {
        Self::with_chunk_seconds(sample_rate, DEFAULT_CHUNK_SECONDS)
    }

    pub fn with_chunk_seconds(sample_rate: u32, seconds: u32) -> Self {
        let chunk_samples = (sample_rate as usize).saturating_mul(seconds.max(1) as usize);
        Self {
            sample_rate,
            chunk_samples,
            buffer: Vec::new(),
        }
    }

    /// Append samples and return every full chunk that became ready.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buffer.extend_from_slice(samples);
        let mut ready = Vec::new();
        while self.buffer.len() >= self.chunk_samples {
            ready.push(self.buffer.drain(..self.chunk_samples).collect());
        }
        ready
    }

    /// Drain the remainder that never reached a full chunk.
    pub fn flush(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.buffer)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn pending_len(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::OfflineAudioChunker;

    #[test]
    fn emits_only_full_chunks() {
        let mut chunker = OfflineAudioChunker::with_chunk_seconds(1_000, 1);
        assert!(chunker.push(&[0.0; 400]).is_empty());
        assert_eq!(chunker.pending_len(), 400);
        let ready = chunker.push(&[0.0; 700]);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].len(), 1_000);
        assert_eq!(chunker.pending_len(), 100);
    }

    #[test]
    fn flush_returns_the_remainder() {
        let mut chunker = OfflineAudioChunker::with_chunk_seconds(1_000, 1);
        chunker.push(&[0.0; 1_500]);
        assert_eq!(chunker.flush().len(), 500);
        assert_eq!(chunker.pending_len(), 0);
    }

    #[test]
    fn large_pushes_emit_multiple_chunks() {
        let mut chunker = OfflineAudioChunker::with_chunk_seconds(1_000, 1);
        let ready = chunker.push(&[0.0; 2_500]);
        assert_eq!(ready.len(), 2);
        assert_eq!(chunker.flush().len(), 500);
    }
}
