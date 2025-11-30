use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Platform not supported: {0}")]
    PlatformNotSupported(String),

    #[error("Recording error: {0}")]
    RecordingError(String),

    #[error("Replay error: {0}")]
    ReplayError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Hotkey error: {0}")]
    HotkeyError(String),
}

impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.to_string()
    }
}



