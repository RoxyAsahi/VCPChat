//! Media attachment validation, normalization and durable asset storage.
//!
//! The validation and re-encoding primitives are controlled extracts from
//! Grok Build. This crate deliberately excludes Grok Agent, ACP, pager and
//! JSONL session code; callers own their Topic and UI state.

mod image_compress;
mod image_validate;
pub use image_validate::validate_image_bytes_unrestricted;

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use image_compress::{FilterType, ReEncodeParams, re_encode_under_limit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_SOURCE_BYTES: usize = 50_000_000;
pub const MAX_IMAGE_BYTES: usize = 1_500_000;
pub const MAX_AUDIO_BYTES: usize = 25_000_000;
pub const MAX_VIDEO_BYTES: usize = 50_000_000;
pub const MAX_ENCODE_PIXELS: u64 = 2_408_448;
pub const MAX_ENCODE_SIDE_PX: u32 = 2_000;
pub const MIN_VISION_SIDE_PX: u32 = 8;
pub const MIN_VISION_TOTAL_PX: u64 = 512;
const MAX_DECODE_PIXELS: u64 = 178_956_970;
const JPEG_QUALITY_STEPS: &[u8] = &[88, 80, 72, 64, 56, 48, 40, 32];
const NORMALIZE_PARAMS: ReEncodeParams = ReEncodeParams {
    max_bytes: MAX_IMAGE_BYTES,
    max_side_px: MAX_ENCODE_SIDE_PX,
    max_pixels: MAX_ENCODE_PIXELS,
    min_side_px: 512,
    quality_steps: JPEG_QUALITY_STEPS,
    filter: FilterType::CatmullRom,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Image,
    Audio,
    Video,
}

impl AttachmentKind {
    fn default_image() -> Self {
        Self::Image
    }

    fn accepts_mime(self, mime_type: &str) -> bool {
        match self {
            Self::Image => matches!(
                mime_type,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            ),
            Self::Audio => matches!(
                mime_type,
                "audio/wav"
                    | "audio/mpeg"
                    | "audio/mp3"
                    | "audio/aiff"
                    | "audio/aac"
                    | "audio/ogg"
                    | "audio/flac"
            ),
            Self::Video => matches!(
                mime_type,
                "video/mp4" | "video/webm" | "video/quicktime" | "video/x-msvideo"
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDescriptor {
    pub id: String,
    pub display_name: String,
    #[serde(default = "AttachmentKind::default_image")]
    pub kind: AttachmentKind,
    pub mime_type: String,
    pub byte_len: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub sha256: String,
    pub asset_file: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedAttachment {
    pub descriptor: AttachmentDescriptor,
    pub original_byte_len: usize,
    pub normalized: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("attachment path is not a file")]
    NotAFile,
    #[error("attachment exceeds the {MAX_SOURCE_BYTES} byte source limit")]
    SourceTooLarge,
    #[error("attachment is not a supported image: {0}")]
    InvalidImage(String),
    #[error("attachment is not a supported audio or video asset")]
    UnsupportedMedia,
    #[error("attachment media bytes are invalid or truncated")]
    InvalidMedia,
    #[error("attachment dimensions are below the model minimum: {0}x{1}")]
    TooSmall(u32, u32),
    #[error("attachment pixel count exceeds the decode safety limit")]
    TooManyPixels,
    #[error("attachment could not be normalized below the wire limit: {0}")]
    Normalize(String),
    #[error("attachment descriptor is invalid")]
    InvalidDescriptor,
    #[error("attachment asset hash does not match its descriptor")]
    HashMismatch,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct AttachmentStore {
    root: PathBuf,
}

impl AttachmentStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Imports only a supported image. Kept for the Host clipboard path,
    /// which always provides raster image data.
    pub fn import_image(&self, source: &Path) -> Result<ImportedAttachment, AttachmentError> {
        let metadata = fs::metadata(source)?;
        if !metadata.is_file() {
            return Err(AttachmentError::NotAFile);
        }
        if metadata.len() > MAX_SOURCE_BYTES as u64 {
            return Err(AttachmentError::SourceTooLarge);
        }
        let original = fs::read(source)?;
        let display_name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "image".to_string());
        self.import_image_bytes(original, display_name)
    }

    /// Imports a VCPToolBox-supported image, audio or video asset. Image
    /// decode/normalization stays in the controlled Grok leaf. Audio/video
    /// are intentionally not transcoded here: this layer only accepts a
    /// conservative magic/MIME allow-list, content-addresses the original
    /// bytes and lets the existing ToolBox media preprocessor own conversion.
    pub fn import_attachment(&self, source: &Path) -> Result<ImportedAttachment, AttachmentError> {
        let metadata = fs::metadata(source)?;
        if !metadata.is_file() {
            return Err(AttachmentError::NotAFile);
        }
        if metadata.len() > MAX_SOURCE_BYTES as u64 {
            return Err(AttachmentError::SourceTooLarge);
        }
        let bytes = fs::read(source)?;
        let display_name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "attachment".to_string());
        if validate_image_bytes_unrestricted(&bytes, true).is_ok() {
            return self.import_image_bytes(bytes, display_name);
        }
        self.import_media_bytes(bytes, display_name)
    }

    /// Import an in-memory encoded image such as a Host-owned clipboard
    /// capture. Raw bytes are normalized and released after the content
    /// addressed Topic asset has been durably written; descriptors never
    /// contain those bytes.
    pub fn import_image_bytes(
        &self,
        original: Vec<u8>,
        display_name: impl Into<String>,
    ) -> Result<ImportedAttachment, AttachmentError> {
        if original.len() > MAX_SOURCE_BYTES {
            return Err(AttachmentError::SourceTooLarge);
        }
        let original_byte_len = original.len();
        let (bytes, mime_type, width, height) = normalize_image(original)?;
        let sha256 = hex_sha256(&bytes);
        let extension = extension_for_mime(mime_type);
        let asset_file = format!("{sha256}.{extension}");
        fs::create_dir_all(&self.root)?;
        atomic_write(&self.root.join(&asset_file), &bytes)?;
        Ok(ImportedAttachment {
            descriptor: AttachmentDescriptor {
                id: format!("attachment_{sha256}"),
                display_name: display_name.into(),
                kind: AttachmentKind::Image,
                mime_type: mime_type.to_string(),
                byte_len: bytes.len(),
                width: Some(width),
                height: Some(height),
                sha256,
                asset_file,
            },
            original_byte_len,
            normalized: bytes.len() != original_byte_len,
        })
    }

    pub fn import_media_bytes(
        &self,
        bytes: Vec<u8>,
        display_name: impl Into<String>,
    ) -> Result<ImportedAttachment, AttachmentError> {
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(AttachmentError::SourceTooLarge);
        }
        let (kind, mime_type, extension, limit) =
            detect_media(&bytes).ok_or(AttachmentError::UnsupportedMedia)?;
        if bytes.len() > limit {
            return Err(AttachmentError::SourceTooLarge);
        }
        let sha256 = hex_sha256(&bytes);
        let asset_file = format!("{sha256}.{extension}");
        fs::create_dir_all(&self.root)?;
        atomic_write(&self.root.join(&asset_file), &bytes)?;
        Ok(ImportedAttachment {
            descriptor: AttachmentDescriptor {
                id: format!("attachment_{sha256}"),
                display_name: display_name.into(),
                kind,
                mime_type: mime_type.to_string(),
                byte_len: bytes.len(),
                width: None,
                height: None,
                sha256,
                asset_file,
            },
            original_byte_len: bytes.len(),
            normalized: false,
        })
    }

    pub fn validate(&self, descriptor: &AttachmentDescriptor) -> Result<PathBuf, AttachmentError> {
        if !valid_sha256(&descriptor.sha256)
            || descriptor.id != format!("attachment_{}", descriptor.sha256)
            || descriptor.asset_file.contains(['/', '\\'])
            || !descriptor.asset_file.starts_with(&descriptor.sha256)
        {
            return Err(AttachmentError::InvalidDescriptor);
        }
        let path = self.root.join(&descriptor.asset_file);
        let bytes = fs::read(&path)?;
        if bytes.len() != descriptor.byte_len || hex_sha256(&bytes) != descriptor.sha256 {
            return Err(AttachmentError::HashMismatch);
        }
        if !descriptor.kind.accepts_mime(&descriptor.mime_type) {
            return Err(AttachmentError::InvalidDescriptor);
        }
        match descriptor.kind {
            AttachmentKind::Image => {
                let (width, height, mime) = image_validate::validate_image_bytes(&bytes)
                    .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
                if descriptor.width != Some(width)
                    || descriptor.height != Some(height)
                    || mime != descriptor.mime_type
                {
                    return Err(AttachmentError::InvalidDescriptor);
                }
            }
            AttachmentKind::Audio | AttachmentKind::Video => {
                let Some((kind, mime, extension, limit)) = detect_media(&bytes) else {
                    return Err(AttachmentError::InvalidMedia);
                };
                if kind != descriptor.kind
                    || mime != descriptor.mime_type
                    || bytes.len() > limit
                    || descriptor.width.is_some()
                    || descriptor.height.is_some()
                    || descriptor.asset_file != format!("{}.{}", descriptor.sha256, extension)
                {
                    return Err(AttachmentError::InvalidDescriptor);
                }
            }
        }
        Ok(path)
    }

    pub fn data_url(&self, descriptor: &AttachmentDescriptor) -> Result<String, AttachmentError> {
        let path = self.validate(descriptor)?;
        let bytes = fs::read(path)?;
        Ok(format!(
            "data:{};base64,{}",
            descriptor.mime_type,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}

fn detect_media(bytes: &[u8]) -> Option<(AttachmentKind, &'static str, &'static str, usize)> {
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    let at = |offset: usize, value: &[u8]| bytes.get(offset..offset + value.len()) == Some(value);
    if starts(b"RIFF") && at(8, b"WAVE") {
        return Some((AttachmentKind::Audio, "audio/wav", "wav", MAX_AUDIO_BYTES));
    }
    if starts(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0) {
        return Some((AttachmentKind::Audio, "audio/mpeg", "mp3", MAX_AUDIO_BYTES));
    }
    if starts(b"FORM") && (at(8, b"AIFF") || at(8, b"AIFC")) {
        return Some((AttachmentKind::Audio, "audio/aiff", "aiff", MAX_AUDIO_BYTES));
    }
    if bytes.len() >= 2 && bytes[0] == 0xff && matches!(bytes[1], 0xf1 | 0xf9) {
        return Some((AttachmentKind::Audio, "audio/aac", "aac", MAX_AUDIO_BYTES));
    }
    if starts(b"OggS") {
        return Some((AttachmentKind::Audio, "audio/ogg", "ogg", MAX_AUDIO_BYTES));
    }
    if starts(b"fLaC") {
        return Some((AttachmentKind::Audio, "audio/flac", "flac", MAX_AUDIO_BYTES));
    }
    if at(4, b"ftyp") {
        if at(8, b"qt  ") {
            return Some((
                AttachmentKind::Video,
                "video/quicktime",
                "mov",
                MAX_VIDEO_BYTES,
            ));
        }
        return Some((AttachmentKind::Video, "video/mp4", "mp4", MAX_VIDEO_BYTES));
    }
    if starts(b"RIFF") && at(8, b"AVI ") {
        return Some((
            AttachmentKind::Video,
            "video/x-msvideo",
            "avi",
            MAX_VIDEO_BYTES,
        ));
    }
    if starts(&[0x1a, 0x45, 0xdf, 0xa3])
        && bytes
            .windows(4_096.min(bytes.len()))
            .any(|part| part == b"webm")
    {
        return Some((AttachmentKind::Video, "video/webm", "webm", MAX_VIDEO_BYTES));
    }
    None
}

fn normalize_image(
    mut bytes: Vec<u8>,
) -> Result<(Vec<u8>, &'static str, u32, u32), AttachmentError> {
    if !image_validate::image_structurally_complete(&bytes) {
        return Err(AttachmentError::InvalidImage(
            "image bytes are truncated".to_string(),
        ));
    }
    if image_validate::needs_endpoint_transcode(&bytes) {
        bytes = image_validate::transcode_to_endpoint_png(&bytes)
            .ok_or_else(|| AttachmentError::InvalidImage("unsupported image format".to_string()))?
            .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
    }
    let (width, height, mime) = image_validate::validate_image_bytes(&bytes)
        .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
    let pixels = u64::from(width) * u64::from(height);
    if width < MIN_VISION_SIDE_PX || height < MIN_VISION_SIDE_PX || pixels < MIN_VISION_TOTAL_PX {
        return Err(AttachmentError::TooSmall(width, height));
    }
    if pixels > MAX_DECODE_PIXELS {
        return Err(AttachmentError::TooManyPixels);
    }
    if bytes.len() <= MAX_IMAGE_BYTES && !NORMALIZE_PARAMS.exceeds_dimension_caps(width, height) {
        return Ok((bytes, mime, width, height));
    }
    let decoded = image::load_from_memory(&bytes)
        .map_err(|error| AttachmentError::InvalidImage(error.to_string()))?;
    let (normalized, width, height, mime) = re_encode_under_limit(&decoded, &NORMALIZE_PARAMS)
        .map_err(|error| AttachmentError::Normalize(error.to_string()))?;
    Ok((normalized, mime, width, height))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    if path.exists() {
        return Ok(());
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if path.exists() => {
                let _ = fs::remove_file(&temporary);
                Ok(())
            }
            Err(error) => Err(error),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, Rgb, Rgba};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = ImageBuffer::from_pixel(width, height, Rgba([20_u8, 40, 80, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode png");
        bytes
    }

    // Kept as a small VCP regression around the directly reused Grok
    // re-encoder: a size cap must never upscale a smaller source image.
    fn noisy_image(width: u32, height: u32) -> DynamicImage {
        let mut image = ImageBuffer::new(width, height);
        let mut state = 0x1234_5678_u32;
        for pixel in image.pixels_mut() {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *pixel = Rgb([(state >> 16) as u8, (state >> 8) as u8, state as u8]);
        }
        DynamicImage::ImageRgb8(image)
    }

    #[test]
    fn reused_grok_encoder_never_upscales_an_attachment() {
        let image = noisy_image(320, 240);
        let params = ReEncodeParams {
            max_bytes: 5_000_000,
            max_side_px: 1_568,
            max_pixels: u64::MAX,
            min_side_px: 64,
            quality_steps: &[88, 72, 56, 40],
            filter: FilterType::CatmullRom,
        };
        let (_bytes, width, height, _mime) =
            re_encode_under_limit(&image, &params).expect("re-encode should fit");
        assert!(
            width <= 320 && height <= 240,
            "encoder upscaled to {width}x{height}"
        );
    }

    #[test]
    fn imports_by_magic_and_never_serializes_base64() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source = directory.path().join("伪装.jpg");
        fs::write(&source, png(32, 32)).expect("write source");
        let store = AttachmentStore::new(directory.path().join("assets"));
        let imported = store.import_image(&source).expect("import image");
        assert_eq!(imported.descriptor.mime_type, "image/png");
        let json = serde_json::to_string(&imported.descriptor).expect("serialize descriptor");
        assert!(!json.contains("base64"));
        assert!(
            store
                .data_url(&imported.descriptor)
                .expect("data url")
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn rejects_truncated_and_too_small_images() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = AttachmentStore::new(directory.path().join("assets"));
        let truncated = directory.path().join("bad.png");
        let mut bytes = png(32, 32);
        bytes.truncate(bytes.len() / 2);
        fs::write(&truncated, bytes).expect("write truncated");
        assert!(matches!(
            store.import_image(&truncated),
            Err(AttachmentError::InvalidImage(_))
        ));
        let tiny = directory.path().join("tiny.png");
        fs::write(&tiny, png(8, 8)).expect("write tiny");
        assert!(matches!(
            store.import_image(&tiny),
            Err(AttachmentError::TooSmall(8, 8))
        ));
    }

    #[test]
    fn detects_asset_tampering() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source = directory.path().join("ok.png");
        fs::write(&source, png(32, 32)).expect("write source");
        let store = AttachmentStore::new(directory.path().join("assets"));
        let imported = store.import_image(&source).expect("import image");
        fs::write(store.root.join(&imported.descriptor.asset_file), b"changed").expect("tamper");
        assert!(matches!(
            store.validate(&imported.descriptor),
            Err(AttachmentError::HashMismatch)
        ));
    }

    #[test]
    fn imports_audio_by_magic_without_serializing_source_or_base64() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source = directory.path().join("录音.mp3");
        fs::write(&source, [b"ID3".as_slice(), &[4, 0, 0, 0, 0, 0]].concat()).expect("write audio");
        let store = AttachmentStore::new(directory.path().join("assets"));
        let imported = store.import_attachment(&source).expect("import audio");

        assert_eq!(imported.descriptor.kind, AttachmentKind::Audio);
        assert_eq!(imported.descriptor.mime_type, "audio/mpeg");
        assert_eq!(imported.descriptor.width, None);
        assert_eq!(imported.descriptor.height, None);
        let json = serde_json::to_string(&imported.descriptor).expect("serialize descriptor");
        assert!(!json.contains("base64"));
        assert!(!json.contains(source.to_string_lossy().as_ref()));
        assert!(
            store
                .data_url(&imported.descriptor)
                .expect("data url")
                .starts_with("data:audio/mpeg;base64,")
        );
    }

    #[test]
    fn imports_video_by_magic_and_rejects_descriptor_kind_mismatch() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source = directory.path().join("clip.mp4");
        fs::write(&source, b"\0\0\0\x18ftypisom\0\0\0\0isom").expect("write video");
        let store = AttachmentStore::new(directory.path().join("assets"));
        let imported = store.import_attachment(&source).expect("import video");
        assert_eq!(imported.descriptor.kind, AttachmentKind::Video);
        assert_eq!(imported.descriptor.mime_type, "video/mp4");

        let mut tampered = imported.descriptor.clone();
        tampered.kind = AttachmentKind::Audio;
        assert!(matches!(
            store.validate(&tampered),
            Err(AttachmentError::InvalidDescriptor)
        ));
    }

    #[test]
    fn rejects_extension_only_media_claims() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source = directory.path().join("not-a-video.mp4");
        fs::write(&source, b"not a media asset").expect("write invalid media");
        let store = AttachmentStore::new(directory.path().join("assets"));
        assert!(matches!(
            store.import_attachment(&source),
            Err(AttachmentError::UnsupportedMedia)
        ));
    }
}
