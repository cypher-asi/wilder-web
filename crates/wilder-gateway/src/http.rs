//! HTTP routes: register/login, dev login, character CRUD.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use wilder_persistence::CharacterStore;
use wilder_types::*;

use crate::SharedState;

#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct ApiError {
    pub error: String,
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

fn err<T>(status: StatusCode, message: impl Into<String>) -> ApiResult<T> {
    Err((status, Json(ApiError { error: message.into() })))
}

pub async fn register(
    State(state): State<SharedState>,
    Json(creds): Json<Credentials>,
) -> ApiResult<AuthResponse> {
    match state.auth.register(&creds.username, &creds.password) {
        Ok((account, token)) => Ok(Json(AuthResponse { token, username: account.username })),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

pub async fn login(
    State(state): State<SharedState>,
    Json(creds): Json<Credentials>,
) -> ApiResult<AuthResponse> {
    match state.auth.login(&creds.username, &creds.password) {
        Ok((account, token)) => Ok(Json(AuthResponse { token, username: account.username })),
        Err(e) => err(StatusCode::UNAUTHORIZED, e.to_string()),
    }
}

/// Dev-only single-click login (mounted only with WILDER_DEV=1).
pub async fn dev_login(State(state): State<SharedState>) -> ApiResult<AuthResponse> {
    let (account, token) = match state.auth.dev_login() {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    // Ensure the dev account has a character so login goes straight to play.
    let has_chars = state
        .store
        .characters_for_account(account.id)
        .map(|c| !c.is_empty())
        .unwrap_or(false);
    if !has_chars {
        let character = new_character(account.id, "Dev".into(), Appearance::default());
        let _ = state.store.create_character(&character);
        let _ = state.store.save_inventory(character.id, &starter_inventory());
    }
    Ok(Json(AuthResponse { token, username: account.username }))
}

fn bearer_account(state: &SharedState, headers: &HeaderMap) -> Option<AccountId> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    state.auth.resolve_token(token)
}

pub async fn list_characters(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> ApiResult<Vec<CharacterSummary>> {
    let Some(account) = bearer_account(&state, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "invalid session");
    };
    match state.store.characters_for_account(account) {
        Ok(characters) => Ok(Json(characters.iter().map(|c| c.summary()).collect())),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct CreateCharacter {
    pub name: String,
    #[serde(default)]
    pub appearance: Option<Appearance>,
}

pub async fn create_character(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CreateCharacter>,
) -> ApiResult<CharacterSummary> {
    let Some(account) = bearer_account(&state, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "invalid session");
    };
    let name = req.name.trim();
    let len = name.chars().count();
    if !(2..=20).contains(&len) || !name.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '_')
    {
        return err(StatusCode::BAD_REQUEST, "name must be 2-20 letters/numbers");
    }
    let existing = state
        .store
        .characters_for_account(account)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e.to_string() })))?;
    if existing.len() >= 5 {
        return err(StatusCode::BAD_REQUEST, "character limit reached");
    }
    let character = new_character(account, name.to_string(), req.appearance.unwrap_or_default());
    match state.store.create_character(&character) {
        Ok(()) => {
            let _ = state
                .store
                .save_inventory(character.id, &starter_inventory());
            Ok(Json(character.summary()))
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn starter_inventory() -> Inventory {
    let mut inv = Inventory::new();
    inv.slots[0] = Some(ItemStack { kind: ItemKind::Medkit, count: 2 });
    inv.slots[1] = Some(ItemStack { kind: ItemKind::Flashlight, count: 1 });
    inv.slots[2] = Some(ItemStack { kind: ItemKind::Ammo9mm, count: 150 });
    // Every runner starts armed: equipped weapons live outside the slot grid.
    inv.equipped_weapon = Some(ItemKind::Pistol);
    inv
}

fn new_character(account: AccountId, name: String, appearance: Appearance) -> Character {
    Character {
        id: uuid::Uuid::new_v4(),
        account_id: account,
        name,
        appearance,
        position: wilder_world::spawn_position(),
        yaw: 0.0,
        level: 1,
        xp: 0,
        health: 100.0,
        max_health: 100.0,
        shield: 0.0,
        max_shield: 0.0,
    }
}
