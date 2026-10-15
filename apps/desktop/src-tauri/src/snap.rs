//! Edge snapping for the floating companion window.
//!
//! Pure geometry in physical pixels, mirroring `apps/desktop/src/blob/companionSnap.ts`
//! (edge 16 px, corner 40 px, margin 8 px, all in logical pixels and scaled by the
//! monitor's scale factor). The window code calls it once a drag has been quiet.

pub const EDGE_LOGICAL: f64 = 16.0;
pub const CORNER_LOGICAL: f64 = 40.0;
pub const MARGIN_LOGICAL: f64 = 8.0;

/// A work area as (x, y, width, height) in physical pixels.
pub type Area = (i32, i32, i32, i32);

/// Returns the position a window of `width` x `height` at (`x`, `y`) should take.
/// An axis that is not near an edge keeps its position; a window near a corner on
/// both axes snaps flush to that corner.
pub fn snap_position(x: i32, y: i32, width: i32, height: i32, area: Area, scale: f64) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let edge = (EDGE_LOGICAL * scale).round() as i32;
    let corner = (CORNER_LOGICAL * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    let (ax, ay, aw, ah) = area;
    let left = ax + margin;
    let right = ax + aw - width - margin;
    let top = ay + margin;
    let bottom = ay + ah - height - margin;
    let dx_left = (x - left).abs();
    let dx_right = (x - right).abs();
    let dy_top = (y - top).abs();
    let dy_bottom = (y - bottom).abs();
    let x_dist = dx_left.min(dx_right);
    let y_dist = dy_top.min(dy_bottom);
    let x_edge = if dx_left <= dx_right { left } else { right };
    let y_edge = if dy_top <= dy_bottom { top } else { bottom };
    if x_dist <= corner && y_dist <= corner {
        return (x_edge, y_edge);
    }
    let nx = if x_dist <= edge { x_edge } else { x };
    let ny = if y_dist <= edge { y_edge } else { y };
    (nx, ny)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Area = (0, 0, 1920, 1040);

    #[test]
    fn open_space_is_left_alone() {
        assert_eq!(snap_position(600, 400, 344, 62, AREA, 1.0), (600, 400));
    }

    #[test]
    fn snaps_to_the_left_edge_within_the_threshold_and_keeps_y() {
        assert_eq!(snap_position(20, 400, 344, 62, AREA, 1.0), (8, 400));
    }

    #[test]
    fn snaps_to_the_bottom_edge() {
        // bottom edge = 1040 - 62 - 8 = 970
        assert_eq!(snap_position(600, 960, 344, 62, AREA, 1.0), (600, 970));
    }

    #[test]
    fn near_a_corner_on_both_axes_goes_flush_to_it() {
        // right edge = 1920 - 344 - 8 = 1568, bottom = 970
        assert_eq!(snap_position(1540, 940, 344, 62, AREA, 1.0), (1568, 970));
        assert_eq!(snap_position(30, 30, 344, 62, AREA, 1.0), (8, 8));
    }

    #[test]
    fn far_from_an_edge_on_one_axis_but_near_on_the_other_snaps_only_that_axis() {
        assert_eq!(snap_position(5, 400, 344, 62, AREA, 1.0), (8, 400));
    }

    #[test]
    fn thresholds_scale_with_the_monitor() {
        // At 2x the edge threshold is 32 px, margin 16 px.
        assert_eq!(snap_position(40, 700, 688, 124, (0, 0, 3840, 2080), 2.0), (16, 700));
        assert_eq!(snap_position(40, 700, 688, 124, (0, 0, 3840, 2080), 1.0), (40, 700));
    }

    #[test]
    fn work_areas_that_do_not_start_at_the_origin_work() {
        assert_eq!(snap_position(-1900, 30, 344, 62, (-1920, 0, 1920, 1040), 1.0), (-1912, 8));
    }

    #[test]
    fn a_bad_scale_falls_back_to_one() {
        assert_eq!(snap_position(20, 400, 344, 62, AREA, f64::NAN), (8, 400));
    }
}
