/**
 * Viewport thresholds shared by the CSS stages in `globals.css` and the
 * handful of layouts that have to branch in JS (`useIsMobile`).
 *
 * Keep the two in step. A layout that collapses its rails in CSS at one
 * width and in JS at another produces exactly the bug this constant was
 * introduced to kill: the article read view stacking its rails at 1240
 * while the editor kept a 320px properties rail down to 768, so the
 * same article changed shape the moment you clicked Edit.
 */

/**
 * Narrow desktop. Content rails stack, the header search collapses to
 * its icon — but the shell (sidebar, global cluster) is untouched.
 *
 * Derived, not chosen: the article read view spends 248 + 240 + 320 on
 * chrome plus 80px of body padding at every width, so its reading
 * measure is `viewport - 888`. A 45-character minimum is about 340px of
 * text, which needs 1228px of viewport.
 */
export const NARROW_DESKTOP_PX = 1240;
