//! A one-shot live check of the ChatGPT dictation path through the real
//! network stack: 1.2 s of silence is sent once and only the outcome class is
//! printed (never a token, header or body). Run it by hand:
//! `cargo run -p bloblex-speech --example cloud_probe`
use bloblex_speech::cloud::{stored_cloudflare_cookie_names, CloudTranscriber};

#[tokio::main]
async fn main() {
    let samples = vec![0.0f32; 19_200];
    match CloudTranscriber::new().transcribe_samples(&samples, None).await {
        Ok(text) => println!("outcome=ok text_len={}", text.len()),
        Err(error) => println!("outcome=error code={} display={}", error.code(), error),
    }
    println!("cloudflare_cookie_names={:?}", stored_cloudflare_cookie_names());
}
