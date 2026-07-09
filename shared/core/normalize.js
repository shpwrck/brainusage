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

// Claude's OAuth usage windows are fixed durations named by the payload keys.
const CLAUDE_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const CLAUDE_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function minutesToMs(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return null;

    return minutes * 60_000;
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
            sessionWindowMs: CLAUDE_SESSION_WINDOW_MS,
            weeklyWindowMs: CLAUDE_WEEKLY_WINDOW_MS,
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
            sessionWindowMs: minutesToMs(primaryWindow?.window_minutes),
            weeklyWindowMs: minutesToMs(secondaryWindow?.window_minutes),
        },
        hasPrimaryWindow: Boolean(primaryWindow),
        hasSecondaryWindow: Boolean(secondaryWindow),
        hasPartialData: !primaryWindow || !secondaryWindow,
    };
}
