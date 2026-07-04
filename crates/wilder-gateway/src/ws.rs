//! WebSocket bridge: authenticates the connection, then pumps messages
//! between the socket and the world sim.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use wilder_protocol::{decode, encode, encode_binary, C2S, S2C};
use wilder_types::EntityId;
use wilder_world::WorldCmd;

use crate::SharedState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();

    // Outbound: world -> socket.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<S2C>();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            // Hot messages (Snapshot, MapIntel, MapCensus) go as compact
            // binary frames; everything else stays JSON text.
            let frame = match encode_binary(&msg) {
                Some(bytes) => Message::Binary(bytes.into()),
                None => Message::Text(encode(&msg).into()),
            };
            if sink.send(frame).await.is_err() {
                break;
            }
        }
    });

    let mut account = None;
    let mut entity: Option<EntityId> = None;

    // Inbound: socket -> world.
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(msg) = decode::<C2S>(&text) else {
            let _ = out_tx.send(S2C::Error { message: "bad message".into() });
            continue;
        };

        match msg {
            C2S::Authenticate { token } => {
                account = state.auth.resolve_token(&token);
                let ok = account.is_some();
                let _ = out_tx.send(S2C::AuthResult {
                    ok,
                    error: (!ok).then(|| "invalid session".to_string()),
                });
            }
            C2S::JoinWorld { character_id, spectate } => {
                let Some(account_id) = account else {
                    let _ = out_tx.send(S2C::Error { message: "authenticate first".into() });
                    continue;
                };
                if entity.is_some() {
                    let _ = out_tx.send(S2C::Error { message: "already joined".into() });
                    continue;
                }
                let (reply_tx, reply_rx) = oneshot::channel();
                let _ = state.world.tx.send(WorldCmd::Join {
                    account: account_id,
                    character_id,
                    spectate,
                    tx: out_tx.clone(),
                    reply: reply_tx,
                });
                match reply_rx.await {
                    Ok(Ok(id)) => entity = Some(id),
                    Ok(Err(e)) => {
                        let _ = out_tx.send(S2C::Error { message: e });
                    }
                    Err(_) => break,
                }
            }
            other => {
                if let Some(id) = entity {
                    let _ = state.world.tx.send(WorldCmd::Msg { entity: id, msg: other });
                }
            }
        }
    }

    // Socket closed: remove from world (persists the character).
    if let Some(id) = entity {
        let _ = state.world.tx.send(WorldCmd::Leave { entity: id });
    }
    send_task.abort();
}
