use thiserror::Error;

/// Errors raised by `cowork-inference` validation, budgets, cost tracking, and parsing.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum InferenceError {
    #[error("{0}")]
    InvalidPolicy(String),
    #[error("{0}")]
    InvalidBudget(String),
    #[error("{0}")]
    InvalidToolArguments(String),
    #[error("{0}")]
    RegistryLoad(String),
    #[error("{0}")]
    RetryDelayExceeded(String),
}
