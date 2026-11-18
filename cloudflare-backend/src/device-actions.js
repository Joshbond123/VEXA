/**
 * Shared device-action helpers.
 *
 * The chat model and some agent prompts emit coordinates as FRACTIONS of the
 * screen (e.g. x:0.1639, y:0.0205). Those were stored verbatim and the emulator
 * ran `input tap 0 0`, so every tap landed in the top-left corner and the phone
 * appeared frozen ("queued device action ... wait"). Any value in 0..1 is
 * treated as normalised and scaled to the device's real pixels.
 */

export const DEFAULT_RESOLUTION = { width: 1080, height: 2400 };

/** Parse a "1080x2400" (or "1080×2400") session resolution string. */
export function resolutionFromSession(session) {
  const m = String(session?.resolution || '').match(/(\d+)\s*[x×]\s*(\d+)/);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return DEFAULT_RESOLUTION;
}

/** Scale normalised (0..1) coordinates to pixels; leave pixel values alone. */
export function normalizeDeviceAction(raw, resolution = DEFAULT_RESOLUTION) {
  const action = { ...(raw || {}) };
  const { width, height } = resolution;
  const px = (v, span) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    // 0..1 (but not exactly 0, a legitimate pixel) means normalised.
    if (n > 0 && n <= 1) return Math.round(n * span);
    return Math.round(n);
  };
  if (action.action === 'tap' || action.action === 'scroll') {
    action.x = px(action.x, width);
    action.y = px(action.y, height);
  } else if (action.action === 'swipe') {
    // Callers use two conventions: the chat schema sends x/y/x2/y2, the runner
    // and emulator send x1/y1/x2/y2. Normalise to pixels and expose BOTH so the
    // emulator finds the fields it reads regardless of which one produced it.
    const sx = px(action.x1 != null ? action.x1 : action.x, width);
    const sy = px(action.y1 != null ? action.y1 : action.y, height);
    const ex = px(action.x2, width);
    const ey = px(action.y2, height);
    action.x = sx; action.y = sy;
    action.x1 = sx; action.y1 = sy;
    action.x2 = ex; action.y2 = ey;
  }
  return action;
}
