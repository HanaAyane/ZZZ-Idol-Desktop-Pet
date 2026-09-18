//! Shared physical-window bounds for dragging and free roaming.
use tauri::PhysicalPosition;

pub fn pet_center_is_visible(
    position: PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    area: &tauri::PhysicalRect<i32, u32>,
) -> bool {
    // Main rigs are centered in their transparent frame. Preserve placements
    // with a reachable character even when that frame extends past a monitor.
    let x = position.x as i64 + size.width as i64 / 2;
    let y = position.y as i64 + size.height as i64 / 2;
    x >= area.position.x as i64
        && x < area.position.x as i64 + area.size.width as i64
        && y >= area.position.y as i64
        && y < area.position.y as i64 + area.size.height as i64
}

pub fn preserve_roaming_height(
    current: PhysicalPosition<i32>,
    requested: PhysicalPosition<i32>,
    clamped: PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    area: &tauri::PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    // Free roaming can move gradually down from a reachable top-edge drag.
    // Never extend the overflow upward or relax coordinated movement bounds.
    let target = PhysicalPosition::new(clamped.x, requested.y);
    if current.y < area.position.y
        && requested.y >= current.y
        && requested.y < area.position.y
        && pet_center_is_visible(target, size, area)
    {
        target
    } else {
        clamped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_roaming_returns_from_top_edge_gradually_without_expanding_overflow() {
        let area = tauri::PhysicalRect {
            position: PhysicalPosition::new(0, 68),
            size: tauri::PhysicalSize::new(3396, 2020),
        };
        let size = tauri::PhysicalSize::new(1040, 1200);
        let current = PhysicalPosition::new(1000, -320);
        let clamped = PhysicalPosition::new(1008, 68);
        assert_eq!(
            preserve_roaming_height(
                current,
                PhysicalPosition::new(1008, -318),
                clamped,
                size,
                &area
            ),
            PhysicalPosition::new(1008, -318)
        );
        assert_eq!(
            preserve_roaming_height(
                current,
                PhysicalPosition::new(1008, -320),
                clamped,
                size,
                &area
            ),
            PhysicalPosition::new(1008, -320)
        );
        assert_eq!(
            preserve_roaming_height(
                current,
                PhysicalPosition::new(1008, -322),
                clamped,
                size,
                &area
            ),
            clamped
        );
        assert_eq!(
            preserve_roaming_height(
                PhysicalPosition::new(1000, -1400),
                PhysicalPosition::new(1008, -1398),
                clamped,
                size,
                &area
            ),
            clamped
        );
        assert_eq!(
            preserve_roaming_height(
                PhysicalPosition::new(1000, 70),
                PhysicalPosition::new(1008, 67),
                clamped,
                size,
                &area
            ),
            clamped
        );
    }
}
