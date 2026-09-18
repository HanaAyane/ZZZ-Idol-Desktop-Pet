use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PET_IDS: [&str; 3] = ["airui", "nangong", "qianxia"];
pub const COORDINATION_STATE_EVENT: &str = "pet-coordination-state";
pub const COORDINATION_COMMAND_EVENT: &str = "pet-coordination-command";
pub const COORDINATION_CANCELLED_EVENT: &str = "pet-coordination-cancelled";
const SNAPSHOT_MAX_AGE: Duration = Duration::from_millis(1800);
const REACTION_COOLDOWN: Duration = Duration::from_secs(9);
const REACTION_TIMEOUT: Duration = Duration::from_secs(6);
const LAYOUT_TIMEOUT: Duration = Duration::from_secs(8);

pub fn pet_window_label(id: &str) -> String {
    format!("pet-{id}")
}

pub fn pet_id_from_window_label(label: &str) -> Option<&'static str> {
    PET_IDS.into_iter().find(|id| label == pet_window_label(id))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoordinationWorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Default for CoordinationWorkArea {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoordinationPosition {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub monitor_name: Option<String>,
    pub work_area: CoordinationWorkArea,
}

impl Default for CoordinationPosition {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 520,
            height: 600,
            scale_factor: 1.0,
            monitor_name: None,
            work_area: CoordinationWorkArea::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoordinationVisualAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

impl Default for CoordinationVisualAnchor {
    fn default() -> Self {
        Self {
            x: 260.0,
            y: 420.0,
            width: 210.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoordinationRuntimeState {
    pub sequence: u64,
    pub state: String,
    pub action: String,
    pub interaction_ready: bool,
    pub debug_open: bool,
    pub loaded: bool,
    pub visible: bool,
    pub position: Option<CoordinationPosition>,
    pub visual_anchor: Option<CoordinationVisualAnchor>,
    pub visual_width_css: f64,
    pub preferred_spacing_css: f64,
    pub scale: f64,
    pub last_user_interaction_at: u64,
    pub reported_at: u64,
}

impl Default for CoordinationRuntimeState {
    fn default() -> Self {
        Self {
            sequence: 0,
            state: "idle".into(),
            action: String::new(),
            interaction_ready: false,
            debug_open: false,
            loaded: false,
            visible: false,
            position: None,
            visual_anchor: None,
            visual_width_css: 210.0,
            preferred_spacing_css: 46.0,
            scale: 1.0,
            last_user_interaction_at: 0,
            reported_at: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationActiveScene {
    pub scene_id: u64,
    pub generation: u64,
    pub kind: String,
    pub actor_id: Option<String>,
    pub participant_ids: Vec<String>,
    pub pending_ids: Vec<String>,
    pub started_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationSnapshot {
    pub pets: HashMap<String, CoordinationRuntimeState>,
    pub active_scene: Option<CoordinationActiveScene>,
    pub generated_at: u64,
    pub event_count: u64,
    pub rejection_count: u64,
    pub timeout_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationLayoutInstruction {
    pub mode: String,
    pub anchor_x: Option<f64>,
    pub anchor_y: Option<f64>,
    pub work_area: CoordinationWorkArea,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationCommand {
    pub scene_id: u64,
    pub generation: u64,
    pub kind: String,
    pub actor_id: Option<String>,
    pub participant_ids: Vec<String>,
    pub expires_at: u64,
    pub trigger_kind: Option<String>,
    pub delay_ms: Option<u64>,
    pub layout: Option<CoordinationLayoutInstruction>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationCancelledEvent {
    pub scene_id: u64,
    pub generation: u64,
    pub reason: String,
}

#[derive(Clone, Debug)]
struct ActiveScene {
    scene_id: u64,
    generation: u64,
    kind: String,
    actor_id: Option<String>,
    participant_ids: Vec<String>,
    pending_ids: Vec<String>,
    started_at: u64,
    expires_at: u64,
    expires_at_instant: Instant,
}

impl ActiveScene {
    fn snapshot(&self) -> CoordinationActiveScene {
        CoordinationActiveScene {
            scene_id: self.scene_id,
            generation: self.generation,
            kind: self.kind.clone(),
            actor_id: self.actor_id.clone(),
            participant_ids: self.participant_ids.clone(),
            pending_ids: self.pending_ids.clone(),
            started_at: self.started_at,
            expires_at: self.expires_at,
        }
    }
}

struct CoordinationState {
    pets: HashMap<String, CoordinationRuntimeState>,
    active_scene: Option<ActiveScene>,
    cooldown_until: HashMap<String, Instant>,
    last_active_pet: Option<String>,
    next_scene_id: u64,
    event_count: u64,
    rejection_count: u64,
    timeout_count: u64,
}

impl Default for CoordinationState {
    fn default() -> Self {
        Self {
            pets: HashMap::new(),
            active_scene: None,
            cooldown_until: HashMap::new(),
            last_active_pet: None,
            next_scene_id: 1,
            event_count: 0,
            rejection_count: 0,
            timeout_count: 0,
        }
    }
}

pub struct CoordinationManager(Mutex<CoordinationState>);

pub struct CoordinationDispatch {
    pub commands: Vec<(String, CoordinationCommand)>,
    pub cancelled: Option<CoordinationCancelledEvent>,
    pub snapshot: CoordinationSnapshot,
}

impl Default for CoordinationManager {
    fn default() -> Self {
        Self(Mutex::new(CoordinationState::default()))
    }
}

impl CoordinationManager {
    pub fn report(&self, id: &str, mut snapshot: CoordinationRuntimeState) -> CoordinationDispatch {
        let mut state = self.0.lock().expect("coordination state lock");
        let now = Instant::now();
        let expired = expire_active(&mut state, now);
        if expired.is_some() {
            state.timeout_count += 1;
        }
        snapshot.reported_at = epoch_millis();
        let should_store = state
            .pets
            .get(id)
            .map(|previous| snapshot.sequence >= previous.sequence)
            .unwrap_or(true);
        if should_store {
            if snapshot.last_user_interaction_at
                > state
                    .pets
                    .get(id)
                    .map(|pet| pet.last_user_interaction_at)
                    .unwrap_or(0)
            {
                state.last_active_pet = Some(id.to_string());
            }
            state.pets.insert(id.to_string(), snapshot);
        }
        let cancelled = expired.map(|scene| cancelled_event(&scene, "timeout"));
        let active_invalid = state
            .active_scene
            .as_ref()
            .map(|scene| {
                (scene.actor_id.as_deref() == Some(id)
                    || scene
                        .participant_ids
                        .iter()
                        .any(|participant| participant == id))
                    && state
                        .pets
                        .get(id)
                        .map(unavailable_for_active_scene)
                        .unwrap_or(true)
            })
            .unwrap_or(false);
        let cancelled = if active_invalid {
            state
                .active_scene
                .take()
                .map(|scene| cancelled_event(&scene, "participant_unavailable"))
        } else {
            cancelled
        };
        state.event_count += 1;
        CoordinationDispatch {
            commands: Vec::new(),
            cancelled,
            snapshot: snapshot_locked(&state),
        }
    }

    pub fn snapshot(&self) -> CoordinationSnapshot {
        let mut state = self.0.lock().expect("coordination state lock");
        if expire_active(&mut state, Instant::now()).is_some() {
            state.timeout_count += 1;
        }
        snapshot_locked(&state)
    }

    pub fn request_reaction(&self, actor_id: &str, trigger_kind: &str) -> CoordinationDispatch {
        let mut state = self.0.lock().expect("coordination state lock");
        let now = Instant::now();
        let expired = expire_active(&mut state, now);
        if expired.is_some() {
            state.timeout_count += 1;
        }
        let actor = state.pets.get(actor_id).cloned();
        let mut candidates = PET_IDS
            .iter()
            .filter_map(|id| {
                if *id == actor_id {
                    return None;
                }
                let pet = state.pets.get(*id)?;
                let actor = actor.as_ref()?;
                if !eligible_snapshot(pet) || !same_work_area(actor, pet) {
                    return None;
                }
                Some((*id, distance_between(actor, pet)))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let maximum = match trigger_kind {
            "click" => 1,
            "doubleClick" => 2,
            _ => 0,
        };
        let cooldown_key = "reactionEcho";
        let rejected = actor.is_none()
            || maximum == 0
            || state.active_scene.is_some()
            || state
                .cooldown_until
                .get(cooldown_key)
                .map(|until| *until > now)
                .unwrap_or(false);
        if rejected {
            state.rejection_count += 1;
            state.event_count += 1;
            return CoordinationDispatch {
                commands: Vec::new(),
                cancelled: expired.map(|scene| cancelled_event(&scene, "timeout")),
                snapshot: snapshot_locked(&state),
            };
        }
        let participants = candidates
            .into_iter()
            .take(maximum)
            .map(|candidate| candidate.0.to_string())
            .collect::<Vec<_>>();
        if participants.is_empty() {
            state.rejection_count += 1;
            state.event_count += 1;
            return CoordinationDispatch {
                commands: Vec::new(),
                cancelled: expired.map(|scene| cancelled_event(&scene, "timeout")),
                snapshot: snapshot_locked(&state),
            };
        }
        let scene = create_scene(
            &mut state,
            "reactionEcho",
            Some(actor_id.to_string()),
            participants.clone(),
            REACTION_TIMEOUT,
        );
        state
            .cooldown_until
            .insert(cooldown_key.into(), now + REACTION_COOLDOWN);
        state.last_active_pet = Some(actor_id.to_string());
        let commands = participants
            .iter()
            .enumerate()
            .map(|(index, participant)| {
                (
                    participant.clone(),
                    CoordinationCommand {
                        scene_id: scene.scene_id,
                        generation: scene.generation,
                        kind: "reactionEcho".into(),
                        actor_id: Some(actor_id.into()),
                        participant_ids: participants.clone(),
                        expires_at: scene.expires_at,
                        trigger_kind: Some(trigger_kind.into()),
                        delay_ms: if trigger_kind == "doubleClick" && index > 0 {
                            Some(220)
                        } else {
                            Some(0)
                        },
                        layout: None,
                    },
                )
            })
            .collect();
        state.event_count += 1;
        CoordinationDispatch {
            commands,
            cancelled: expired.map(|scene| cancelled_event(&scene, "timeout")),
            snapshot: snapshot_locked(&state),
        }
    }

    pub fn request_layout(&self, mode: &str, anchor_id: Option<&str>) -> CoordinationDispatch {
        let mut state = self.0.lock().expect("coordination state lock");
        let now = Instant::now();
        let expired = expire_active(&mut state, now);
        if expired.is_some() {
            state.timeout_count += 1;
        }
        let replaced = state.active_scene.take();
        let anchor_id = anchor_id
            .filter(|id| PET_IDS.contains(id))
            .map(str::to_string)
            .or_else(|| state.last_active_pet.clone());
        let anchor = anchor_id
            .as_deref()
            .and_then(|id| state.pets.get(id))
            .cloned()
            .or_else(|| PET_IDS.iter().find_map(|id| state.pets.get(*id).cloned()));
        let Some(anchor) = anchor else {
            state.rejection_count += 1;
            state.event_count += 1;
            return CoordinationDispatch {
                commands: Vec::new(),
                cancelled: replaced.map(|scene| cancelled_event(&scene, "replaced")),
                snapshot: snapshot_locked(&state),
            };
        };
        let Some(anchor_position) = anchor.position.clone() else {
            state.rejection_count += 1;
            state.event_count += 1;
            return CoordinationDispatch {
                commands: Vec::new(),
                cancelled: replaced.map(|scene| cancelled_event(&scene, "anchor_unavailable")),
                snapshot: snapshot_locked(&state),
            };
        };
        let participants = PET_IDS
            .iter()
            .filter_map(|id| {
                let pet = state.pets.get(*id)?;
                if layout_eligible_snapshot(pet) && same_work_area(&anchor, pet) {
                    Some((*id).to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        log::info!(
            target: "desktop_pet::coordination",
            "layout requested: mode={mode} anchor={anchor_id:?} participants={participants:?} states={:?}",
            PET_IDS.iter().map(|id| (*id, state.pets.get(*id).map(|pet| (
                &pet.state, pet.interaction_ready, pet.debug_open,
                layout_eligible_snapshot(pet), same_work_area(&anchor, pet),
            )))).collect::<Vec<_>>()
        );
        if participants.is_empty() {
            state.rejection_count += 1;
            state.event_count += 1;
            return CoordinationDispatch {
                commands: Vec::new(),
                cancelled: replaced.map(|scene| cancelled_event(&scene, "no_visible_participant")),
                snapshot: snapshot_locked(&state),
            };
        }
        let uses_character_anchor = mode == "gather" && anchor_id.is_some();
        let anchor_x = if uses_character_anchor {
            let visual_x = anchor
                .visual_anchor
                .as_ref()
                .map(|visual| visual.x * anchor_position.scale_factor.max(1.0))
                .unwrap_or(anchor_position.width as f64 / 2.0);
            Some(anchor_position.x as f64 + visual_x)
        } else {
            Some(anchor_position.work_area.x as f64 + anchor_position.work_area.width as f64 / 2.0)
        };
        let anchor_y = if uses_character_anchor {
            let visual_y = anchor
                .visual_anchor
                .as_ref()
                .map(|visual| visual.y * anchor_position.scale_factor.max(1.0))
                .unwrap_or(anchor_position.height as f64);
            Some(anchor_position.y as f64 + visual_y)
        } else {
            Some(
                anchor_position.work_area.y as f64 + anchor_position.work_area.height as f64
                    - 18.0 * anchor_position.scale_factor.max(1.0),
            )
        };
        let scene = create_scene(
            &mut state,
            mode,
            anchor_id.clone(),
            participants.clone(),
            LAYOUT_TIMEOUT,
        );
        let layout = CoordinationLayoutInstruction {
            mode: mode.into(),
            anchor_x,
            anchor_y,
            work_area: anchor_position.work_area,
        };
        let commands = participants
            .iter()
            .map(|participant| {
                (
                    participant.clone(),
                    CoordinationCommand {
                        scene_id: scene.scene_id,
                        generation: scene.generation,
                        kind: mode.into(),
                        actor_id: anchor_id.clone(),
                        participant_ids: participants.clone(),
                        expires_at: scene.expires_at,
                        trigger_kind: None,
                        delay_ms: Some(0),
                        layout: Some(layout.clone()),
                    },
                )
            })
            .collect();
        state.event_count += 1;
        CoordinationDispatch {
            commands,
            cancelled: replaced
                .or(expired)
                .map(|scene| cancelled_event(&scene, "replaced")),
            snapshot: snapshot_locked(&state),
        }
    }

    pub fn complete(
        &self,
        caller_id: &str,
        scene_id: u64,
        generation: u64,
        outcome: &str,
    ) -> CoordinationDispatch {
        let mut state = self.0.lock().expect("coordination state lock");
        let expired = expire_active(&mut state, Instant::now());
        if expired.is_some() {
            state.timeout_count += 1;
        }
        let mut completed = false;
        if let Some(scene) = state.active_scene.as_mut() {
            if scene.scene_id == scene_id
                && scene.generation == generation
                && scene.pending_ids.iter().any(|id| id == caller_id)
            {
                log::info!(target: "desktop_pet::coordination", "scene {scene_id}: {caller_id} outcome={outcome}");
                scene.pending_ids.retain(|id| id != caller_id);
                completed = scene.pending_ids.is_empty();
            }
        }
        if completed {
            state.active_scene = None;
        }
        state.event_count += 1;
        CoordinationDispatch {
            commands: Vec::new(),
            cancelled: expired.map(|scene| cancelled_event(&scene, "timeout")),
            snapshot: snapshot_locked(&state),
        }
    }

    pub fn cancel(
        &self,
        caller_id: Option<&str>,
        scene_id: u64,
        generation: u64,
        reason: &str,
    ) -> CoordinationDispatch {
        let mut state = self.0.lock().expect("coordination state lock");
        let expired = expire_active(&mut state, Instant::now());
        if expired.is_some() {
            state.timeout_count += 1;
        }
        let cancelled = state.active_scene.as_ref().and_then(|scene| {
            if scene.scene_id != scene_id || scene.generation != generation {
                return None;
            }
            if caller_id.is_some()
                && !scene
                    .participant_ids
                    .iter()
                    .any(|id| Some(id.as_str()) == caller_id)
                && scene.actor_id.as_deref() != caller_id
            {
                return None;
            }
            Some(cancelled_event(scene, reason))
        });
        if cancelled.is_some() {
            state.active_scene = None;
        }
        state.event_count += 1;
        CoordinationDispatch {
            commands: Vec::new(),
            cancelled: cancelled.or(expired.map(|scene| cancelled_event(&scene, "timeout"))),
            snapshot: snapshot_locked(&state),
        }
    }

    pub fn cancel_all(&self, reason: &str) -> Option<CoordinationCancelledEvent> {
        let mut state = self.0.lock().expect("coordination state lock");
        let cancelled = state
            .active_scene
            .as_ref()
            .map(|scene| cancelled_event(scene, reason));
        if cancelled.is_some() {
            state.active_scene = None;
            state.event_count += 1;
        }
        cancelled
    }
}

pub fn emit_dispatch(app: &AppHandle, dispatch: CoordinationDispatch) {
    if let Some(cancelled) = dispatch.cancelled {
        emit_cancelled(app, &cancelled);
    }
    let _ = app.emit(COORDINATION_STATE_EVENT, dispatch.snapshot);
    for (target_id, command) in dispatch.commands {
        let _ = app.emit_to(
            pet_window_label(&target_id),
            COORDINATION_COMMAND_EVENT,
            command,
        );
    }
}

pub fn emit_cancelled(app: &AppHandle, event: &CoordinationCancelledEvent) {
    log::info!(target: "desktop_pet::coordination", "scene {} cancelled: {}", event.scene_id, event.reason);
    for id in PET_IDS {
        let _ = app.emit_to(pet_window_label(id), COORDINATION_CANCELLED_EVENT, event);
    }
}

pub fn emit_snapshot(app: &AppHandle, manager: &CoordinationManager) {
    let _ = app.emit(COORDINATION_STATE_EVENT, manager.snapshot());
}

fn create_scene(
    state: &mut CoordinationState,
    kind: &str,
    actor_id: Option<String>,
    participant_ids: Vec<String>,
    timeout: Duration,
) -> ActiveScene {
    let scene_id = state.next_scene_id;
    state.next_scene_id = state.next_scene_id.saturating_add(1);
    let started_at = epoch_millis();
    let expires_at_instant = Instant::now() + timeout;
    let scene = ActiveScene {
        scene_id,
        generation: scene_id,
        kind: kind.into(),
        actor_id,
        participant_ids: participant_ids.clone(),
        pending_ids: participant_ids,
        started_at,
        expires_at: started_at + timeout.as_millis() as u64,
        expires_at_instant,
    };
    state.active_scene = Some(scene.clone());
    scene
}

fn expire_active(state: &mut CoordinationState, now: Instant) -> Option<ActiveScene> {
    if state
        .active_scene
        .as_ref()
        .map(|scene| scene.expires_at_instant <= now)
        .unwrap_or(false)
    {
        return state.active_scene.take();
    }
    None
}

fn snapshot_locked(state: &CoordinationState) -> CoordinationSnapshot {
    CoordinationSnapshot {
        pets: state.pets.clone(),
        active_scene: state.active_scene.as_ref().map(ActiveScene::snapshot),
        generated_at: epoch_millis(),
        event_count: state.event_count,
        rejection_count: state.rejection_count,
        timeout_count: state.timeout_count,
    }
}

fn cancelled_event(scene: &ActiveScene, reason: &str) -> CoordinationCancelledEvent {
    CoordinationCancelledEvent {
        scene_id: scene.scene_id,
        generation: scene.generation,
        reason: reason.into(),
    }
}

fn eligible_snapshot(snapshot: &CoordinationRuntimeState) -> bool {
    snapshot.sequence > 0
        && snapshot.loaded
        && snapshot.visible
        && snapshot.interaction_ready
        && !snapshot.debug_open
        && matches!(snapshot.state.as_str(), "idle" | "hover")
        && snapshot.position.is_some()
        && snapshot.reported_at > 0
        && epoch_millis().saturating_sub(snapshot.reported_at)
            <= SNAPSHOT_MAX_AGE.as_millis() as u64
}

fn unavailable_for_active_scene(snapshot: &CoordinationRuntimeState) -> bool {
    !snapshot.loaded
        || !snapshot.visible
        || !snapshot.interaction_ready
        || snapshot.debug_open
        || matches!(
            snapshot.state.as_str(),
            "dragging"
                | "dropped"
                | "click_reaction"
                | "double_click_reaction"
                | "rapid_click_reaction"
        )
}

fn layout_eligible_snapshot(snapshot: &CoordinationRuntimeState) -> bool {
    // Explicit menu actions must survive delayed WebView heartbeats during a
    // native menu/drag loop. Each recipient validates its live state before moving.
    snapshot.sequence > 0
        && snapshot.loaded
        && snapshot.visible
        && snapshot.interaction_ready
        && !snapshot.debug_open
        && matches!(
            snapshot.state.as_str(),
            "idle" | "hover" | "walking" | "idle_random_action"
        )
        && snapshot.position.is_some()
        && snapshot.reported_at > 0
}

fn same_work_area(left: &CoordinationRuntimeState, right: &CoordinationRuntimeState) -> bool {
    let Some(a) = left.position.as_ref() else {
        return false;
    };
    let Some(b) = right.position.as_ref() else {
        return false;
    };
    a.monitor_name == b.monitor_name
        && a.work_area.x == b.work_area.x
        && a.work_area.y == b.work_area.y
        && a.work_area.width == b.work_area.width
        && a.work_area.height == b.work_area.height
}

fn distance_between(left: &CoordinationRuntimeState, right: &CoordinationRuntimeState) -> f64 {
    let center = |snapshot: &CoordinationRuntimeState| {
        let position = snapshot.position.as_ref()?;
        let scale = position.scale_factor.max(1.0);
        let anchor = snapshot.visual_anchor.as_ref();
        Some((
            position.x as f64
                + anchor
                    .map(|value| value.x * scale)
                    .unwrap_or(position.width as f64 / 2.0),
            position.y as f64
                + anchor
                    .map(|value| value.y * scale)
                    .unwrap_or(position.height as f64 / 2.0),
        ))
    };
    let Some((left_x, left_y)) = center(left) else {
        return f64::MAX;
    };
    let Some((right_x, right_y)) = center(right) else {
        return f64::MAX;
    };
    (left_x - right_x).hypot(left_y - right_y)
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_pet(state: &str) -> CoordinationRuntimeState {
        CoordinationRuntimeState {
            sequence: 1,
            state: state.into(),
            loaded: true,
            visible: true,
            interaction_ready: true,
            position: Some(CoordinationPosition::default()),
            reported_at: 1,
            ..Default::default()
        }
    }

    #[test]
    fn manual_gather_includes_idle_pets_after_native_menu_delays_heartbeats() {
        let manager = CoordinationManager::default();
        {
            let mut state = manager.0.lock().unwrap();
            for id in PET_IDS {
                state.pets.insert(id.into(), ready_pet("idle"));
            }
        }
        let dispatch = manager.request_layout("gather", Some("nangong"));
        assert_eq!(dispatch.commands.len(), 3);
        assert_eq!(
            dispatch.snapshot.active_scene.unwrap().participant_ids,
            PET_IDS
        );
    }

    #[test]
    fn manual_layout_can_interrupt_idle_random_actions_but_not_user_actions() {
        assert!(layout_eligible_snapshot(&ready_pet("idle_random_action")));
        for state in ["dragging", "dropped", "window_lifting", "click_reaction"] {
            assert!(!layout_eligible_snapshot(&ready_pet(state)), "{state}");
        }
        let mut hidden = ready_pet("idle");
        hidden.visible = false;
        assert!(!layout_eligible_snapshot(&hidden));
    }

    #[test]
    fn automatic_reaction_still_requires_a_fresh_snapshot() {
        assert!(!eligible_snapshot(&ready_pet("idle")));
    }
}
