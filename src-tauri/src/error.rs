use std::fmt;

/// One error type for the backend; commands turn it into a String.
#[derive(Debug)]
pub struct Error(pub String);
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}

macro_rules! from_err {
    ($($t:ty),*) => {$(impl From<$t> for Error { fn from(e: $t) -> Self { Error(e.to_string()) } })*};
}
from_err!(std::io::Error, rusqlite::Error, serde_json::Error, tauri::Error);

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}
impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error(s.to_string())
    }
}

pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error(msg.into()))
}
