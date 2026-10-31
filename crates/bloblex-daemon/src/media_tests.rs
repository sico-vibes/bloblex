//! Phase 2: generated images end to end in the daemon — the record, the sweep
//! and the transcript notice.
//!
//! Every test drives the real entry points (`media::requested`, `media::sweep_once`)
//! and reads the real store, so the row, the message and the events are the ones
//! the app sees.

use super::*;
use crate::phase2a_tests::{state, state_with};

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    bytes.extend_from_slice(&[0u8; 24]);
    bytes
}

/// A state with one idle conversation and a data folder of its own.
fn image_state() -> (AppState, broadcast::Receiver<EventEnvelope>, PathBuf) {
    let (st, rx) = state();
    let dir = std::env::temp_dir().join(format!("bloblex-media-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    st.db.create_session("image-session", "rt-test", "codex", ".", "Chat").unwrap();
    st.db.update_session_state("image-session", "completed").unwrap();
    (st, rx, dir)
}

fn stamp(offset_secs: i64) -> String {
    (Utc::now() + chrono::Duration::seconds(offset_secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

async fn request_stem(st: &AppState, call: &str, stem: &str) {
    media::requested(st, "image-session", None, "opencode", call, Some(stem.to_owned()), None, None, None).await;
}

async fn drain(rx: &mut broadcast::Receiver<EventEnvelope>) -> Vec<(String, Value)> {
    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        seen.push((event.event_type.clone(), event.payload.clone()));
    }
    seen
}

fn notice_texts(st: &AppState) -> Vec<String> {
    st.db.session_detail("image-session").unwrap()["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|message| message["meta"]["kind"] == "generated_image")
        .map(|message| message["content"].as_str().unwrap_or("").to_owned())
        .collect()
}

/// The tool's own structured output (`rawOutput.metadata.path`, a stem) becomes
/// a pending row and one transcript notice, and the events carry no path.
#[tokio::test]
async fn opencode_image_tool_records_a_pending_image_from_its_output() {
    let (st, mut rx, dir) = image_state();
    let stem = dir.join("out").to_string_lossy().into_owned();
    request_stem(&st, "tool_img_1", &stem).await;
    let rows = st.db.media_pending().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "pending");
    assert_eq!(rows[0]["stem"], json!(stem));
    assert_eq!(rows[0]["toolCallId"], "tool_img_1");
    assert_eq!(rows[0]["provider"], "opencode");
    assert_eq!(notice_texts(&st), vec!["Generating an image…".to_owned()]);
    let seen = drain(&mut rx).await;
    assert!(seen.iter().any(|(kind, payload)| kind == "session.changed" && payload["id"] == "image-session"));
    let generated = seen.iter().find(|(kind, _)| kind == "media.generated").expect("media.generated");
    assert_eq!(generated.1, json!({"sessionId":"image-session","mediaId":rows[0]["id"],"status":"pending"}));
    assert!(!serde_json::to_string(&seen).unwrap().contains(&stem), "no event carries a path");
    let _ = std::fs::remove_dir_all(dir);
}

/// Two images in one turn are two messages, each updated in place, and the event
/// that moves a card off "Generating…" carries the stored status and no path.
#[tokio::test]
async fn a_second_image_in_one_turn_gets_its_own_message() {
    let (st, mut rx, dir) = image_state();
    st.db.create_turn("turn-9", "image-session").unwrap();
    let first = dir.join("first").to_string_lossy().into_owned();
    let second = dir.join("second").to_string_lossy().into_owned();
    media::requested(&st, "image-session", Some("turn-9"), "opencode", "call_a", Some(first.clone()), None, None, None).await;
    media::requested(&st, "image-session", Some("turn-9"), "opencode", "call_b", Some(second.clone()), None, None, None).await;
    let pending: Vec<Value> = st.db.session_detail("image-session").unwrap()["messages"].as_array().cloned().unwrap_or_default()
        .into_iter().filter(|message| message["meta"]["kind"] == "generated_image").collect();
    assert_eq!(pending.len(), 2, "one message per image");
    assert_ne!(pending[0]["id"], pending[1]["id"]);
    assert!(pending.iter().all(|message| message["turnId"].is_null()), "a notice is stored with no turn");
    let ids: Vec<String> = pending.iter().map(|message| message["id"].as_str().unwrap().to_owned()).collect();
    // Both files arrive; each message is rewritten in place, not duplicated.
    std::fs::write(format!("{first}.png"), png_bytes()).unwrap();
    std::fs::write(format!("{second}.png"), png_bytes()).unwrap();
    for _ in 0..3 { media::sweep_once(&st).await; }
    let ready: Vec<Value> = st.db.session_detail("image-session").unwrap()["messages"].as_array().cloned().unwrap_or_default()
        .into_iter().filter(|message| message["meta"]["kind"] == "generated_image").collect();
    assert_eq!(ready.len(), 2);
    let mut ready_ids: Vec<String> = ready.iter().map(|message| message["id"].as_str().unwrap().to_owned()).collect();
    ready_ids.sort();
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(ready_ids, expected, "the same two rows, updated");
    assert!(ready.iter().all(|message| message["meta"]["status"] == "ready"));
    assert!(ready.iter().any(|message| message["content"] == "Generated an image: first.png"));
    assert!(ready.iter().any(|message| message["content"] == "Generated an image: second.png"));
    let seen = drain(&mut rx).await;
    let completed: Vec<&(String, Value)> = seen.iter().filter(|(kind, payload)| kind == "message.completed" && payload["role"] == "notice").collect();
    let ready_event = completed.iter().rev().find(|(_, payload)| payload["message"]["meta"]["status"] == "ready").expect("a ready notice was emitted");
    assert!(ready_event.1.get("turnId").is_none(), "the payload carries no turn");
    assert_eq!(ready_event.1["messageId"], ready_event.1["message"]["id"]);
    assert!(!serde_json::to_string(&seen).unwrap().contains(&dir.to_string_lossy().into_owned()), "no event carries a path");
    let _ = std::fs::remove_dir_all(dir);
}

/// A stem that is not absolute records nothing at all.
#[tokio::test]
async fn a_relative_stem_records_nothing() {
    let (st, _rx, dir) = image_state();
    request_stem(&st, "tool_img_rel", "images/out").await;
    assert!(st.db.media_pending().unwrap().is_empty());
    assert_eq!(st.db.media_count("image-session").unwrap(), 0);
    assert!(notice_texts(&st).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

/// The file appears after the sweep has already looked once.
#[tokio::test]
async fn the_sweep_finds_the_file_when_it_appears() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("cat").to_string_lossy().into_owned();
    request_stem(&st, "tool_img_2", &stem).await;
    media::sweep_once(&st).await;
    assert!(st.db.media_pending().unwrap().len() == 1, "nothing to find yet");
    std::fs::write(format!("{stem}.png"), png_bytes()).unwrap();
    // The first pass that sees the file records its size, the next one finds the
    // same size and calls it complete.
    media::sweep_once(&st).await;
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_2").unwrap().unwrap();
    assert_eq!(row["status"], "ready");
    assert_eq!(row["name"], "cat.png");
    assert_eq!(row["mediaType"], "image/png");
    assert_eq!(row["bytes"], json!(png_bytes().len() as i64));
    assert_eq!(notice_texts(&st), vec!["Generated an image: cat.png".to_owned()]);
    let _ = std::fs::remove_dir_all(dir);
}

/// A file that is still growing is not taken on the first pass.
#[tokio::test]
async fn the_sweep_waits_for_a_stable_size() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("slow").to_string_lossy().into_owned();
    request_stem(&st, "tool_img_3", &stem).await;
    std::fs::write(format!("{stem}.png"), png_bytes()).unwrap();
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_3").unwrap().unwrap();
    assert_eq!(row["status"], "pending", "one pass only remembers the size");
    assert_eq!(row["bytes"], json!(png_bytes().len() as i64));
    // Still growing: the next pass sees a different size and starts over.
    let mut bigger = png_bytes();
    bigger.extend_from_slice(&[0u8; 8]);
    std::fs::write(format!("{stem}.png"), &bigger).unwrap();
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_3").unwrap().unwrap();
    assert_eq!(row["status"], "pending");
    assert_eq!(row["bytes"], json!(bigger.len() as i64));
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_3").unwrap().unwrap();
    assert_eq!(row["status"], "ready");
    let _ = std::fs::remove_dir_all(dir);
}

/// A file that was already at that path before the request is not its result.
#[tokio::test]
async fn the_sweep_ignores_an_old_file_at_that_path() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("reused").to_string_lossy().into_owned();
    std::fs::write(format!("{stem}.png"), png_bytes()).unwrap();
    request_stem(&st, "tool_img_4", &stem).await;
    let id = st.db.media_by_call("image-session", "tool_img_4").unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    // The request is ten minutes after the file was written, so the file is old.
    st.db.media_set_requested_at_for_test(&id, &stamp(600)).unwrap();
    media::sweep_once(&st).await;
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_4").unwrap().unwrap();
    assert_eq!(row["status"], "pending");
    let _ = std::fs::remove_dir_all(dir);
}

/// After 35 minutes a request that never produced a file fails, once, with the
/// reason the transcript shows.
#[tokio::test]
async fn the_sweep_fails_a_request_after_35_minutes() {
    let (st, mut rx, dir) = image_state();
    let stem = dir.join("never").to_string_lossy().into_owned();
    request_stem(&st, "tool_img_5", &stem).await;
    let _ = drain(&mut rx).await;
    let id = st.db.media_by_call("image-session", "tool_img_5").unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    st.db.media_set_requested_at_for_test(&id, &stamp(-36 * 60)).unwrap();
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_5").unwrap().unwrap();
    assert_eq!(row["status"], "failed");
    assert_eq!(row["detail"], "The image didn't arrive.");
    assert_eq!(notice_texts(&st), vec!["The image couldn't be generated: The image didn't arrive.".to_owned()]);
    let seen = drain(&mut rx).await;
    assert!(seen.iter().any(|(kind, payload)| kind == "media.generated" && payload["status"] == "failed"));
    // A second pass leaves the finished row alone.
    media::sweep_once(&st).await;
    assert_eq!(st.db.media_by_call("image-session", "tool_img_5").unwrap().unwrap()["status"], "failed");
    let _ = std::fs::remove_dir_all(dir);
}

/// The rows are stored, so a request made by the previous process is still
/// waiting for its file after a restart.
#[tokio::test]
async fn pending_images_survive_a_restart() {
    let dir = std::env::temp_dir().join(format!("bloblex-media-restart-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bitbots.db");
    let stem = dir.join("later").to_string_lossy().into_owned();
    {
        let (st, _rx) = state_with(Storage::open(&path).unwrap());
        *st.team.data_dir.lock().unwrap() = Some(dir.clone());
        st.db.create_session("image-session", "rt-test", "codex", ".", "Chat").unwrap();
        request_stem(&st, "tool_img_6", &stem).await;
    }
    let (st, _rx) = state_with(Storage::open(&path).unwrap());
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    assert_eq!(st.db.media_pending().unwrap().len(), 1, "the row survived");
    std::fs::write(format!("{stem}.png"), png_bytes()).unwrap();
    media::sweep_once(&st).await;
    media::sweep_once(&st).await;
    assert_eq!(st.db.media_by_call("image-session", "tool_img_6").unwrap().unwrap()["status"], "ready");
    let _ = std::fs::remove_dir_all(dir);
}

/// An image that arrives after its turn ended changes no session state and wakes
/// nothing.
#[tokio::test]
async fn an_image_arriving_after_the_turn_changes_no_session_state() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("after").to_string_lossy().into_owned();
    st.db.create_turn("done-turn", "image-session").unwrap();
    st.db.update_turn_state("done-turn", "completed").unwrap();
    request_stem(&st, "tool_img_7", &stem).await;
    std::fs::write(format!("{stem}.webp"), {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(b"WEBPVP8 ");
        bytes.extend_from_slice(&[0u8; 16]);
        bytes
    }).unwrap();
    media::sweep_once(&st).await;
    media::sweep_once(&st).await;
    assert_eq!(st.db.session_state("image-session").unwrap().as_deref(), Some("completed"));
    assert!(st.active_turns.lock().await.is_empty());
    assert_eq!(st.db.media_by_call("image-session", "tool_img_7").unwrap().unwrap()["status"], "ready");
    let _ = std::fs::remove_dir_all(dir);
}

/// Codex's `savedPath` is adopted as it is.
#[tokio::test]
async fn codex_image_item_with_saved_path_is_ready() {
    let (st, _rx, dir) = image_state();
    let file = dir.join("codex-cat.png");
    std::fs::write(&file, png_bytes()).unwrap();
    media::requested(&st, "image-session", Some("turn-1"), "codex", "img-1", None, Some(file.to_string_lossy().into_owned()), None, None).await;
    let row = st.db.media_get("image-session", st.db.media_by_call("image-session", "img-1").unwrap().unwrap()["id"].as_str().unwrap()).unwrap().unwrap();
    assert_eq!(row["status"], "ready");
    assert_eq!(row["name"], "codex-cat.png");
    assert_eq!(row["mediaType"], "image/png");
    assert_eq!(row["turnId"], "turn-1");
    assert_eq!(notice_texts(&st), vec!["Generated an image: codex-cat.png".to_owned()]);
    let _ = std::fs::remove_dir_all(dir);
}

/// Codex's base64 image is written under the data folder and named after the
/// media id.
#[tokio::test]
async fn codex_inline_image_is_written_to_the_data_folder() {
    let (st, _rx, dir) = image_state();
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes());
    media::requested(&st, "image-session", None, "codex", "img-2", None, None, Some(encoded.clone()), None).await;
    let row = st.db.media_by_call("image-session", "img-2").unwrap().unwrap();
    assert_eq!(row["status"], "ready");
    let stored = PathBuf::from(row["path"].as_str().unwrap());
    assert!(stored.starts_with(dir.join("generated").join("image-session")), "written under the data folder");
    assert_eq!(stored.file_name().unwrap().to_string_lossy(), format!("{}.png", row["id"].as_str().unwrap()));
    assert_eq!(std::fs::read(&stored).unwrap(), png_bytes(), "the bytes are the image");
    assert_eq!(row["name"], json!(stored.file_name().unwrap().to_string_lossy().into_owned()));
    let _ = std::fs::remove_dir_all(dir);
}

/// The base64 never reaches a message, a tool row or an event.
#[tokio::test]
async fn codex_inline_base64_is_stored_nowhere() {
    let (st, mut rx, dir) = image_state();
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes());
    media::requested(&st, "image-session", None, "codex", "img-3", None, None, Some(encoded.clone()), None).await;
    let conversation = serde_json::to_string(&st.db.session_detail("image-session").unwrap()).unwrap();
    assert!(!conversation.contains(&encoded), "no message holds the image bytes");
    assert!(!conversation.contains("iVBORw0KGgo"), "no message holds any part of them");
    let seen = drain(&mut rx).await;
    assert!(!serde_json::to_string(&seen).unwrap().contains(&encoded));
    assert!(!st.db.media_pending().unwrap().iter().any(|row| serde_json::to_string(row).unwrap().contains(&encoded)));
    let _ = std::fs::remove_dir_all(dir);
}

/// A failed image carries a one-line reason, and nothing that looks like a path.
#[tokio::test]
async fn codex_failed_image_reports_the_reason() {
    let (st, _rx, dir) = image_state();
    media::requested(&st, "image-session", None, "codex", "img-4", None, None, None, Some("quota exhausted\nretry later".into())).await;
    let row = st.db.media_by_call("image-session", "img-4").unwrap().unwrap();
    assert_eq!(row["status"], "failed");
    assert_eq!(row["detail"], "quota exhausted");
    assert_eq!(notice_texts(&st), vec!["The image couldn't be generated: quota exhausted".to_owned()]);
    let _ = std::fs::remove_dir_all(dir);
}

/// A ready record pointing at an arbitrary path, so the preview checks can be
/// driven without the request path that would refuse the same file.
fn ready_row(st: &AppState, sid: &str, call: &str, path: &Path) -> String {
    let id = bloblex_storage::Storage::new_media_id();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    st.db.media_insert(&id, sid, None, "codex", call, None, Some(&path.to_string_lossy()), "ready", Some(&name), Some(1), Some("image/png"), None).unwrap().unwrap()["id"].as_str().unwrap().to_owned()
}

/// `media.preview {mediaId}` reads the exact file its record stores, and nothing
/// the caller names.
#[tokio::test]
async fn preview_by_media_id_reads_only_that_rows_exact_file() {
    let (st, _rx, dir) = image_state();
    let image = dir.join("cat.png");
    std::fs::write(&image, png_bytes()).unwrap();
    let other = dir.join("other.png");
    std::fs::write(&other, png_bytes()).unwrap();
    let id = ready_row(&st, "image-session", "call-preview", &image);
    let reply = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":id})).await.unwrap();
    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["kind"], "image");
    assert_eq!(reply["name"], "cat.png");
    assert_eq!(reply["relativePath"], Value::Null);
    assert_eq!(reply["size"], json!(png_bytes().len() as i64));
    assert!(reply["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
    // Naming another path in the same request is refused outright.
    let both = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":id,"path":"other.png"})).await;
    assert_eq!(both.unwrap_err().1.code, "invalid_argument");
    // The record's own path is the only one read: replace the file and see it.
    std::fs::write(&image, {
        let mut bigger = png_bytes();
        bigger.extend_from_slice(&[0u8; 4]);
        bigger
    }).unwrap();
    let again = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":id})).await.unwrap();
    assert_eq!(again["size"], json!((png_bytes().len() + 4) as i64));
    let _ = std::fs::remove_dir_all(dir);
}

/// The project-folder rule is unchanged: a generated file's path is still
/// refused when it is outside the conversation's folder.
#[tokio::test]
async fn preview_by_path_still_refuses_a_generated_file_outside_the_project() {
    let (st, _rx, dir) = image_state();
    let project = dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    st.db.create_session("other-session", "rt-test", "codex", &project.to_string_lossy(), "Other").unwrap();
    let image = dir.join("generated.png");
    std::fs::write(&image, png_bytes()).unwrap();
    let reply = dispatch(&st, "media.preview", json!({"sessionId":"other-session","path":image.to_string_lossy()})).await.unwrap();
    assert_eq!(reply["status"], "blocked");
    assert_eq!(reply["reason"], "That file is outside this project.");
    // And the record-based read is what makes it reachable, with no path in the reply.
    let id = ready_row(&st, "other-session", "call-outside", &image);
    let by_record = dispatch(&st, "media.preview", json!({"sessionId":"other-session","mediaId":id})).await.unwrap();
    assert_eq!(by_record["status"], "ok");
    let _ = std::fs::remove_dir_all(dir);
}

/// A record belongs to its own conversation.
#[tokio::test]
async fn preview_refuses_another_conversations_media() {
    let (st, _rx, dir) = image_state();
    st.db.create_session("second-session", "rt-test", "codex", ".", "Second").unwrap();
    let image = dir.join("mine.png");
    std::fs::write(&image, png_bytes()).unwrap();
    let id = ready_row(&st, "image-session", "call-mine", &image);
    let reply = dispatch(&st, "media.preview", json!({"sessionId":"second-session","mediaId":id})).await.unwrap();
    assert_eq!(reply["status"], "unavailable");
    assert_eq!(reply["reason"], "That image is not part of this conversation.");
    assert!(reply["dataUrl"].is_null());
    let _ = std::fs::remove_dir_all(dir);
}

/// Only the four generated formats, by extension and by bytes: an SVG, a link
/// and a file that is not what it claims are all refused.
#[tokio::test]
async fn preview_refuses_svg_a_symlink_and_a_mislabelled_file() {
    let (st, _rx, dir) = image_state();
    let svg = dir.join("drawing.svg");
    std::fs::write(&svg, b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>").unwrap();
    let svg_id = ready_row(&st, "image-session", "call-svg", &svg);
    let svg_reply = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":svg_id})).await.unwrap();
    assert_eq!(svg_reply["status"], "unsupported");
    assert!(svg_reply["dataUrl"].is_null());
    let mislabelled = dir.join("pretend.png");
    std::fs::write(&mislabelled, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]).unwrap();
    let mislabelled_id = ready_row(&st, "image-session", "call-bad", &mislabelled);
    let mislabelled_reply = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":mislabelled_id})).await.unwrap();
    assert_eq!(mislabelled_reply["status"], "unsupported");
    assert_eq!(mislabelled_reply["reason"], "The file doesn't match its type.");
    // A link is refused where it would be followed. Creating one needs a
    // privilege Windows may not grant a test process, so this part only runs
    // where it can.
    let target = dir.join("real.png");
    std::fs::write(&target, png_bytes()).unwrap();
    let link = dir.join("link.png");
    let linked = std::os::windows::fs::symlink_file(&target, &link).is_ok();
    if linked {
        let link_id = ready_row(&st, "image-session", "call-link", &link);
        let link_reply = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":link_id})).await.unwrap();
        assert_eq!(link_reply["status"], "blocked");
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// A generated image's reply names the file and never the folder it lives in.
#[tokio::test]
async fn preview_never_returns_the_folder() {
    let (st, _rx, dir) = image_state();
    let image = dir.join("generated").join("secret-folder").join("shown.png");
    std::fs::create_dir_all(image.parent().unwrap()).unwrap();
    std::fs::write(&image, png_bytes()).unwrap();
    let id = ready_row(&st, "image-session", "call-folder", &image);
    let reply = dispatch(&st, "media.preview", json!({"sessionId":"image-session","mediaId":id})).await.unwrap();
    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["name"], "shown.png");
    assert!(reply["relativePath"].is_null());
    let text = serde_json::to_string(&reply).unwrap();
    assert!(!text.contains("secret-folder"), "the reply carries no folder");
    assert!(!text.contains(&dir.to_string_lossy().into_owned()), "the reply carries no path");
    let _ = std::fs::remove_dir_all(dir);
}

/// A generated-image notice crossing to a phone still has no path in it.
#[tokio::test]
async fn generated_image_message_carries_no_path() {
    let (st, mut rx, dir) = image_state();
    let image = dir.join("hidden-folder").join("ready.png");
    std::fs::create_dir_all(image.parent().unwrap()).unwrap();
    std::fs::write(&image, png_bytes()).unwrap();
    media::requested(&st, "image-session", None, "codex", "call-redact", None, Some(image.to_string_lossy().into_owned()), None, None).await;
    let seen = drain(&mut rx).await;
    let (_, payload) = seen.iter().find(|(kind, _)| kind == "message.completed").expect("the notice was emitted");
    let envelope = json!({"type":"message.completed","payload":payload});
    let redacted = crate::remote::policy::redact_event(&envelope).expect("a notice crosses to a device");
    let text = serde_json::to_string(&redacted).unwrap();
    assert!(!text.contains("hidden-folder"), "no folder crosses");
    assert!(!text.contains(&dir.to_string_lossy().into_owned()), "no path crosses");
    assert_eq!(redacted["payload"]["message"]["meta"]["status"], "ready");
    assert_eq!(redacted["payload"]["message"]["meta"]["mediaId"], payload["messageId"]);
    let _ = std::fs::remove_dir_all(dir);
}

/// Revealing needs a complete record; a pending one only says so.
#[tokio::test]
async fn media_reveal_needs_a_ready_row() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("later").to_string_lossy().into_owned();
    request_stem(&st, "call-reveal-pending", &stem).await;
    let pending = st.db.media_by_call("image-session", "call-reveal-pending").unwrap().unwrap();
    let pending_reply = dispatch(&st, "media.reveal", json!({"sessionId":"image-session","mediaId":pending["id"]})).await.unwrap();
    assert_eq!(pending_reply["revealed"], false);
    assert_eq!(pending_reply["reason"], "That image is not ready yet.");
    let image = dir.join("shown.png");
    std::fs::write(&image, png_bytes()).unwrap();
    let id = ready_row(&st, "image-session", "call-reveal-ready", &image);
    let ready_reply = dispatch(&st, "media.reveal", json!({"sessionId":"image-session","mediaId":id})).await.unwrap();
    assert_eq!(ready_reply, json!({"status":"ok","revealed":true}));
    let missing = dispatch(&st, "media.reveal", json!({"sessionId":"image-session","mediaId":"nope"})).await.unwrap();
    assert_eq!(missing["revealed"], false);
    let _ = std::fs::remove_dir_all(dir);
}

/// The capability stands beside `settings`: only a runtime that can make an
/// image for the owner says so.
#[tokio::test]
async fn capabilities_say_whether_images_can_be_asked_for() {
    let (st, _rx, dir) = image_state();
    let codex = dispatch(&st, "runtime.capabilities", json!({"runtimeId":"rt-test"})).await.unwrap();
    assert_eq!(codex["generatesImages"], true, "the Codex runtime returns the image itself");
    assert!(codex["settings"].is_object(), "it sits beside settings");
    *st.runtimes.write().await = vec![
        json!({"id":"rt-claude","provider":"claude"}),
        json!({"id":"rt-open","provider":"opencode"}),
    ];
    for id in ["rt-claude", "rt-open"] {
        let caps = dispatch(&st, "runtime.capabilities", json!({"runtimeId":id})).await.unwrap();
        assert_eq!(caps["generatesImages"], false, "{id}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// Codex sends the saved file and its bytes together: the file wins, and the
/// bytes are only used when that file cannot be read.
#[tokio::test]
async fn a_saved_path_wins_and_inline_bytes_are_the_fallback() {
    let (st, _rx, dir) = image_state();
    let file = dir.join("codex-saved.png");
    std::fs::write(&file, png_bytes()).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes());
    media::requested(&st, "image-session", None, "codex", "img-both", None, Some(file.to_string_lossy().into_owned()), Some(encoded.clone()), None).await;
    let row = st.db.media_by_call("image-session", "img-both").unwrap().unwrap();
    assert_eq!(row["status"], "ready");
    assert_eq!(row["path"], json!(file.to_string_lossy().into_owned()), "the saved file is used as it is");
    assert!(!dir.join("generated").exists(), "nothing is copied into the data folder");
    // A saved path that cannot be used falls back to the bytes.
    let missing = dir.join("gone.png");
    media::requested(&st, "image-session", None, "codex", "img-fallback", None, Some(missing.to_string_lossy().into_owned()), Some(encoded), None).await;
    let fallback = st.db.media_by_call("image-session", "img-fallback").unwrap().unwrap();
    assert_eq!(fallback["status"], "ready");
    assert!(fallback["path"].as_str().unwrap().starts_with(&dir.join("generated").to_string_lossy().into_owned()));
    // A failure still wins over both.
    media::requested(&st, "image-session", None, "codex", "img-failed", None, Some(file.to_string_lossy().into_owned()), Some(base64::engine::general_purpose::STANDARD.encode(png_bytes())), Some("quota exhausted".into())).await;
    assert_eq!(st.db.media_by_call("image-session", "img-failed").unwrap().unwrap()["status"], "failed");
    let _ = std::fs::remove_dir_all(dir);
}

/// A provider's reason reaches the transcript and a phone with no path and no
/// secret in it, even when the provider names the stem it could not write.
#[tokio::test]
async fn a_failure_reason_carries_no_path_or_secret() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("secret-zone").join("target").to_string_lossy().into_owned();
    let reason = format!("could not write {stem}.png: API key sk-live-abcdef1234567890 was rejected at C:/Users/owner/app");
    media::requested(&st, "image-session", None, "opencode", "img-reason", Some(stem.clone()), None, None, Some(reason)).await;
    let row = st.db.media_by_call("image-session", "img-reason").unwrap().unwrap();
    assert_eq!(row["status"], "failed");
    let detail = row["detail"].as_str().unwrap();
    assert!(!detail.contains("secret-zone"), "no folder in the detail: {detail}");
    assert!(!detail.contains("Users"), "no path in the detail: {detail}");
    assert!(!detail.contains("sk-live"), "no secret in the detail: {detail}");
    assert!(detail.contains("the file"), "the path is named as a file: {detail}");
    let text = notice_texts(&st).join("\n");
    assert!(!text.contains("secret-zone") && !text.contains("sk-live"), "nothing in the notice either: {text}");
    let _ = std::fs::remove_dir_all(dir);
}

/// A file whose size never settles still fails at the deadline.
#[tokio::test]
async fn a_size_that_never_settles_still_fails_after_35_minutes() {
    let (st, _rx, dir) = image_state();
    let stem = dir.join("changing").to_string_lossy().into_owned();
    request_stem(&st, "tool_img_changing", &stem).await;
    std::fs::write(format!("{stem}.png"), png_bytes()).unwrap();
    let id = st.db.media_by_call("image-session", "tool_img_changing").unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    media::sweep_once(&st).await;
    st.db.media_set_requested_at_for_test(&id, &stamp(-36 * 60)).unwrap();
    let mut changed = png_bytes();
    changed.push(0);
    std::fs::write(format!("{stem}.png"), changed).unwrap();
    media::sweep_once(&st).await;
    let row = st.db.media_by_call("image-session", "tool_img_changing").unwrap().unwrap();
    assert_eq!(row["status"], "failed", "the deadline applies to a file that never settles");
    assert_eq!(row["detail"], "The image didn't arrive.");
    let _ = std::fs::remove_dir_all(dir);
}

/// Deleting a conversation drops its rows and leaves the file on disk.
#[tokio::test]
async fn deleting_a_conversation_drops_its_media_rows_and_keeps_the_file() {
    let (st, _rx, dir) = image_state();
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes());
    media::requested(&st, "image-session", None, "codex", "img-5", None, None, Some(encoded), None).await;
    let row = st.db.media_by_call("image-session", "img-5").unwrap().unwrap();
    let stored = PathBuf::from(row["path"].as_str().unwrap());
    assert!(stored.exists());
    dispatch(&st, "session.delete", json!({"sessionId":"image-session"})).await.unwrap();
    assert_eq!(st.db.media_count("image-session").unwrap(), 0);
    assert!(stored.exists(), "the file on disk is left alone");
    let _ = std::fs::remove_dir_all(dir);
}
