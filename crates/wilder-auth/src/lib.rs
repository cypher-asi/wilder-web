//! Account registration, login, and session issuance.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use wilder_persistence::{Account, CharacterStore, SessionStore, StoreError};
use wilder_types::AccountId;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid username: 3-24 chars, alphanumeric/underscore")]
    InvalidUsername,
    #[error("password must be at least 8 characters")]
    WeakPassword,
    #[error("username already taken")]
    UsernameTaken,
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("internal error: {0}")]
    Internal(String),
}

pub struct AuthService<S: CharacterStore + SessionStore> {
    store: std::sync::Arc<S>,
}

impl<S: CharacterStore + SessionStore> AuthService<S> {
    pub fn new(store: std::sync::Arc<S>) -> Self {
        Self { store }
    }

    pub fn register(&self, username: &str, password: &str) -> Result<(Account, String), AuthError> {
        if !valid_username(username) {
            return Err(AuthError::InvalidUsername);
        }
        if password.len() < 8 {
            return Err(AuthError::WeakPassword);
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| AuthError::Internal(e.to_string()))?
            .to_string();
        let account = match self.store.create_account(username, &hash) {
            Ok(a) => a,
            Err(StoreError::Conflict(_)) => return Err(AuthError::UsernameTaken),
            Err(e) => return Err(AuthError::Internal(e.to_string())),
        };
        let token = self
            .store
            .create_session(account.id)
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        Ok((account, token))
    }

    pub fn login(&self, username: &str, password: &str) -> Result<(Account, String), AuthError> {
        let account = match self.store.account_by_username(username) {
            Ok(a) => a,
            Err(StoreError::NotFound) => return Err(AuthError::InvalidCredentials),
            Err(e) => return Err(AuthError::Internal(e.to_string())),
        };
        let parsed =
            PasswordHash::new(&account.password_hash).map_err(|e| AuthError::Internal(e.to_string()))?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .map_err(|_| AuthError::InvalidCredentials)?;
        let token = self
            .store
            .create_session(account.id)
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        Ok((account, token))
    }

    /// Dev-only: get-or-create the `dev` account and issue a session, skipping
    /// password entry entirely. Only reachable when the gateway mounts /dev routes.
    pub fn dev_login(&self) -> Result<(Account, String), AuthError> {
        let account = match self.store.account_by_username("dev") {
            Ok(a) => a,
            Err(StoreError::NotFound) => {
                let salt = SaltString::generate(&mut OsRng);
                let hash = Argon2::default()
                    .hash_password(b"dev-password-not-for-production", &salt)
                    .map_err(|e| AuthError::Internal(e.to_string()))?
                    .to_string();
                self.store
                    .create_account("dev", &hash)
                    .map_err(|e| AuthError::Internal(e.to_string()))?
            }
            Err(e) => return Err(AuthError::Internal(e.to_string())),
        };
        let token = self
            .store
            .create_session(account.id)
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        Ok((account, token))
    }

    pub fn resolve_token(&self, token: &str) -> Option<AccountId> {
        self.store.account_for_token(token).ok()
    }
}

fn valid_username(name: &str) -> bool {
    let len = name.chars().count();
    (3..=24).contains(&len)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}
