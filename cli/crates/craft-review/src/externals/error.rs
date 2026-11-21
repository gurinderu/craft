use craft_store::js::JsString;

/// An external proposal could not be read; record/file refusals retain UTF-16 in helper JSON.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A refused invocation, record, version pattern or file.
    #[error("{}", String::from_utf16_lossy(&.0.units().collect::<Vec<_>>()))]
    Refused(JsString),
    /// Failure of the embedded ECMAScript runtime, distinct from a refused pattern.
    #[error("ECMAScript regex engine: {0}")]
    Engine(#[from] rquickjs::Error),
    /// A filesystem or stream operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A file operation failed, retaining the path for per-record refusal messages.
    #[error("{operation} '{}': {source}", path.display())]
    File {
        /// The operation attempted on the resolved file.
        operation: &'static str,
        /// The resolved path passed to the filesystem.
        path: std::path::PathBuf,
        /// The operating system's reason for refusal.
        #[source]
        source: std::io::Error,
    },
    /// The engine returned an invalid transport value.
    #[error("invalid regex engine result: {0}")]
    Transport(#[from] craft_store::js::ParseError),
}

impl Error {
    pub(super) fn refused(message: impl Into<JsString>) -> Self {
        Self::Refused(message.into())
    }

    /// The error's original code units, suitable for the compatibility JSON envelope.
    #[must_use]
    pub fn message(&self) -> JsString {
        match self {
            Self::Refused(message) => message.clone(),
            Self::Engine(_) | Self::Io(_) | Self::File { .. } | Self::Transport(_) => {
                self.to_string().into()
            }
        }
    }
}
