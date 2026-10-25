//! Live words for an offline model.
//!
//! An offline recognizer (Parakeet, and any model that decodes a finished clip) returns text only when it is
//! handed audio, so a chunker that waited for a long clip meant the dictation island showed a timer and a
//! waveform but no words until the person stopped (FIX43). This tracker cuts the audio into utterances at
//! pauses and decides, from the audio alone, when the engine should decode:
//!
//! * a *partial* every second or so while someone is speaking: the whole utterance so far, which replaces the
//!   previous partial in the island;
//! * a *final* at a pause (or at the length bound), after which the next words start a new utterance.
//!
//! The utterance length is bounded (`MAX_UTTERANCE_SECS`), which is what the old chunker guaranteed: tensor
//! sizes never grow with the length of the dictation. The tracker holds no model and no text, so it is plain
//! code with plain tests. Audio never leaves it except as the samples the caller decodes.

/// Below this root-mean-square level a frame counts as silence.
const SILENCE_RMS: f32 = 0.012;
/// A pause this long ends the utterance.
const END_SILENCE_SECS: f32 = 0.9;
/// Less speech than this is a click or a breath, not worth decoding.
const MIN_SPEECH_SECS: f32 = 0.25;
/// Silence kept in front of the speech, so the first sound is not clipped.
const LEAD_IN_SECS: f32 = 0.3;
/// The longest utterance decoded in one go; a longer one is cut here.
pub const MAX_UTTERANCE_SECS: u32 = 20;
/// How often a partial is decoded while someone speaks.
const PARTIAL_EVERY_SECS: f32 = 1.2;

/// What the caller should decode next.
#[derive(Debug, Clone, PartialEq)]
pub enum UtteranceStep {
    /// The utterance so far; the caller keeps its own copy and the tracker keeps listening.
    Partial(Vec<f32>),
    /// The finished utterance; the tracker has started a new one.
    Final(Vec<f32>),
}

pub struct UtteranceTracker {
    sample_rate: u32,
    buffer: Vec<f32>,
    speech_samples: usize,
    silence_run: usize,
    since_partial: usize,
    partial_every: usize,
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

impl UtteranceTracker {
    pub fn new(sample_rate: u32) -> Self {
        let partial_every = (sample_rate as f32 * PARTIAL_EVERY_SECS) as usize;
        Self { sample_rate, buffer: Vec::new(), speech_samples: 0, silence_run: 0, since_partial: 0, partial_every }
    }

    fn seconds(&self, value: f32) -> usize {
        (self.sample_rate as f32 * value) as usize
    }

    /// The decode took `seconds`: wait at least three times as long before the next partial, so a slow machine
    /// falls behind by a word or two instead of by minutes.
    pub fn note_decode_cost(&mut self, seconds: f32) {
        let base = self.seconds(PARTIAL_EVERY_SECS);
        self.partial_every = base.max(self.seconds(seconds * 3.0));
    }

    fn start_over(&mut self) {
        self.buffer.clear();
        self.speech_samples = 0;
        self.silence_run = 0;
        self.since_partial = 0;
    }

    /// Hand over the finished utterance without the long silence that ended it.
    fn take_final(&mut self) -> Vec<f32> {
        let keep_silence = self.seconds(LEAD_IN_SECS).min(self.silence_run);
        let end = self.buffer.len() - (self.silence_run - keep_silence);
        let mut utterance = std::mem::take(&mut self.buffer);
        utterance.truncate(end);
        self.start_over();
        utterance
    }

    /// Feed 16 kHz mono samples (any length).
    pub fn push(&mut self, samples: &[f32]) -> Option<UtteranceStep> {
        if samples.is_empty() {
            return None;
        }
        let loud = rms(samples) >= SILENCE_RMS;
        self.buffer.extend_from_slice(samples);
        if loud {
            self.silence_run = 0;
            self.speech_samples += samples.len();
        } else {
            self.silence_run += samples.len();
        }
        if self.speech_samples < self.seconds(MIN_SPEECH_SECS) {
            // Nothing worth decoding yet: keep only the lead-in so a long quiet spell costs no memory.
            let lead_in = self.seconds(LEAD_IN_SECS);
            if !loud && self.speech_samples == 0 && self.buffer.len() > lead_in {
                let drop = self.buffer.len() - lead_in;
                self.buffer.drain(..drop);
                self.silence_run = self.buffer.len();
            }
            return None;
        }
        if self.silence_run >= self.seconds(END_SILENCE_SECS) || self.buffer.len() >= self.seconds(MAX_UTTERANCE_SECS as f32) {
            return Some(UtteranceStep::Final(self.take_final()));
        }
        self.since_partial += samples.len();
        if loud && self.since_partial >= self.partial_every {
            self.since_partial = 0;
            return Some(UtteranceStep::Partial(self.buffer.clone()));
        }
        None
    }

    /// The utterance still open when dictation stops, if it holds any speech.
    pub fn finish(&mut self) -> Option<Vec<f32>> {
        let has_speech = self.speech_samples >= self.seconds(MIN_SPEECH_SECS);
        let utterance = has_speech.then(|| std::mem::take(&mut self.buffer));
        self.start_over();
        utterance
    }
}

#[cfg(test)]
mod tests {
    use super::{UtteranceStep, UtteranceTracker, MAX_UTTERANCE_SECS};

    const RATE: u32 = 1_000;

    fn speech(seconds: f32) -> Vec<f32> {
        vec![0.2; (RATE as f32 * seconds) as usize]
    }

    fn quiet(seconds: f32) -> Vec<f32> {
        vec![0.0; (RATE as f32 * seconds) as usize]
    }

    /// Feed 100 ms frames, collecting every step.
    fn run(tracker: &mut UtteranceTracker, audio: &[f32]) -> Vec<UtteranceStep> {
        audio.chunks(100).filter_map(|frame| tracker.push(frame)).collect()
    }

    #[test]
    fn partials_arrive_while_someone_is_speaking_and_a_pause_ends_the_utterance() {
        let mut tracker = UtteranceTracker::new(RATE);
        let steps = run(&mut tracker, &speech(3.0));
        let partials: Vec<_> = steps.iter().filter_map(|step| if let UtteranceStep::Partial(audio) = step { Some(audio.len()) } else { None }).collect();
        assert_eq!(partials, vec![1_400, 2_600], "a partial about every 1.2 s once the first quarter second of speech is in, each holding the whole utterance so far");
        let steps = run(&mut tracker, &quiet(1.0));
        assert_eq!(steps.len(), 1);
        match &steps[0] {
            UtteranceStep::Final(audio) => assert!(audio.len() >= 3_000 && audio.len() <= 3_400, "the long silence is trimmed: {}", audio.len()),
            other => panic!("expected a final, got {other:?}"),
        }
        assert!(tracker.finish().is_none(), "the next utterance starts empty");
    }

    #[test]
    fn silence_and_a_click_never_reach_the_decoder() {
        let mut tracker = UtteranceTracker::new(RATE);
        assert!(run(&mut tracker, &quiet(30.0)).is_empty());
        assert!(run(&mut tracker, &speech(0.1)).is_empty());
        assert!(run(&mut tracker, &quiet(2.0)).is_empty());
        assert!(tracker.finish().is_none());
    }

    #[test]
    fn a_long_quiet_spell_does_not_grow_the_buffer() {
        let mut tracker = UtteranceTracker::new(RATE);
        run(&mut tracker, &quiet(600.0));
        assert!(tracker.buffer.len() <= 400, "only the lead-in is kept: {}", tracker.buffer.len());
        let steps = run(&mut tracker, &speech(1.5));
        assert!(steps.iter().any(|step| matches!(step, UtteranceStep::Partial(audio) if audio.len() <= 2_000)), "the lead-in is kept in front of the speech");
    }

    #[test]
    fn an_utterance_is_cut_at_the_length_bound_and_the_next_words_start_a_new_one() {
        let mut tracker = UtteranceTracker::new(RATE);
        let steps = run(&mut tracker, &speech(MAX_UTTERANCE_SECS as f32 + 5.0));
        let finals: Vec<_> = steps.iter().filter_map(|step| if let UtteranceStep::Final(audio) = step { Some(audio.len()) } else { None }).collect();
        assert_eq!(finals, vec![MAX_UTTERANCE_SECS as usize * 1_000]);
        let rest = tracker.finish().expect("the five seconds after the cut are still open");
        assert_eq!(rest.len(), 5_000);
    }

    #[test]
    fn stopping_hands_over_the_open_utterance_once() {
        let mut tracker = UtteranceTracker::new(RATE);
        run(&mut tracker, &speech(2.0));
        assert_eq!(tracker.finish().map(|audio| audio.len()), Some(2_000));
        assert!(tracker.finish().is_none());
    }

    #[test]
    fn a_slow_decode_spaces_the_partials_out() {
        let mut tracker = UtteranceTracker::new(RATE);
        tracker.note_decode_cost(2.0);
        let steps = run(&mut tracker, &speech(7.0));
        let partials = steps.iter().filter(|step| matches!(step, UtteranceStep::Partial(_))).count();
        assert_eq!(partials, 1, "a 2 s decode waits 6 s before the next partial");
        tracker.note_decode_cost(0.1);
        assert_eq!(tracker.partial_every, 1_200, "a fast decode returns to the normal pace");
    }
}
