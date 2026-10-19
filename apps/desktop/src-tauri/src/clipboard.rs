use std::io::Cursor;

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
use tauri::command;

const MAX_CLIPBOARD_PIXELS: usize = 16_777_216;
const MAX_CLIPBOARD_PNG_BYTES: usize = 64 * 1024 * 1024;

/// Read clipboard pixels only after an explicit paste gesture in the composer.
#[command]
pub async fn clipboard_image() -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(read_clipboard_png)
        .await
        .map_err(|_| "The clipboard image could not be read.".to_owned())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_clipboard_png() -> Result<Vec<u8>, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|_| "The system clipboard could not be read.".to_owned())?;
    let image = clipboard
        .get_image()
        .map_err(|_| "The clipboard does not contain a readable image.".to_owned())?;
    let pixels = image
        .width
        .checked_mul(image.height)
        .filter(|count| *count > 0 && *count <= MAX_CLIPBOARD_PIXELS)
        .ok_or_else(|| "The clipboard image is too large to attach.".to_owned())?;
    if image.bytes.len() != pixels.saturating_mul(4) {
        return Err("The clipboard image could not be decoded.".into());
    }
    let width = u32::try_from(image.width)
        .map_err(|_| "The clipboard image is too large to attach.".to_owned())?;
    let height = u32::try_from(image.height)
        .map_err(|_| "The clipboard image is too large to attach.".to_owned())?;
    let rgba = ImageBuffer::<Rgba<u8>, _>::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "The clipboard image could not be decoded.".to_owned())?;
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(rgba)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| "The clipboard image could not be encoded.".to_owned())?;
    let bytes = png.into_inner();
    if bytes.len() > MAX_CLIPBOARD_PNG_BYTES {
        return Err("The clipboard image is too large to attach.".into());
    }
    Ok(bytes)
}
