function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;

    if (value < 0)
        return 0;

    if (value > 100)
        return 100;

    return value;
}

function unixSecondsToIso(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds))
        return null;

    return new Date(seconds * 1000).toISOString();
}

// Usage windows are fixed durations: a rolling 5-hour session window and a
// 7-day weekly window. Both Claude and Codex share this cadence. Codex's
// wham/usage payload doesn't carry a window duration, so these are the
// fallback when it isn't provided explicitly.
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function minutesToMs(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return null;

    return minutes * 60_000;
}

// Prefer an explicit window duration from the payload; fall back to the known
// fixed duration when the window exists but doesn't report one.
function windowMsFor(window, fallbackMs) {
    if (!window)
        return null;

    return minutesToMs(window.window_minutes) ?? fallbackMs;
}

export function normalizeClaudeUsage(payload) {
    const fiveHourUtilization = Number(payload?.five_hour?.utilization);
    const sevenDayUtilization = Number(payload?.seven_day?.utilization);

    return {
        data: {
            sessionRemainingPct: clampPercent(100 - fiveHourUtilization),
            weeklyRemainingPct: clampPercent(100 - sevenDayUtilization),
            sessionResetsAtIso: payload?.five_hour?.resets_at ?? null,
            weeklyResetsAtIso: payload?.seven_day?.resets_at ?? null,
            sessionWindowMs: SESSION_WINDOW_MS,
            weeklyWindowMs: WEEKLY_WINDOW_MS,
        },
        hasSessionUsage: Number.isFinite(fiveHourUtilization),
        hasWeeklyUsage: Number.isFinite(sevenDayUtilization),
    };
}

export function normalizeCodexUsage(payload) {
    const primaryWindow = payload?.rate_limit?.primary_window;
    const secondaryWindow = payload?.rate_limit?.secondary_window;

    return {
        data: {
            sessionRemainingPct: clampPercent(100 - Number(primaryWindow?.used_percent)),
            weeklyRemainingPct: clampPercent(100 - Number(secondaryWindow?.used_percent)),
            sessionResetsAtIso: unixSecondsToIso(primaryWindow?.reset_at),
            weeklyResetsAtIso: unixSecondsToIso(secondaryWindow?.reset_at),
            sessionWindowMs: windowMsFor(primaryWindow, SESSION_WINDOW_MS),
            weeklyWindowMs: windowMsFor(secondaryWindow, WEEKLY_WINDOW_MS),
        },
        hasPrimaryWindow: Boolean(primaryWindow),
        hasSecondaryWindow: Boolean(secondaryWindow),
        hasPartialData: !primaryWindow || !secondaryWindow,
    };
}
