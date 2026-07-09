const VERSION = 'brainusage 1.0.1';

export const PANEL_LABEL_MODES = ['min', 'claude-session', 'claude-weekly', 'codex-session', 'codex-weekly'];

export const PANEL_ITEMS = [
    {key: 'min', label: 'Overall minimum', shortLabel: 'Min', providerKey: null, providerName: null, windowLabel: 'Min', window: null, metric: 'remaining'},
    {key: 'claude-session', label: 'Claude session', shortLabel: 'C', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Session', window: 'session', metric: 'remaining'},
    {key: 'claude-weekly', label: 'Claude weekly', shortLabel: 'Cw', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Week', window: 'weekly', metric: 'remaining'},
    {key: 'codex-session', label: 'Codex session', shortLabel: 'X', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Session', window: 'session', metric: 'remaining'},
    {key: 'codex-weekly', label: 'Codex weekly', shortLabel: 'Xw', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Week', window: 'weekly', metric: 'remaining'},
    // Utilization (pace) items: projected end-of-window usage. The '↑' marks a
    // pace metric versus the plain remaining-% items above.
    {key: 'claude-session-pace', label: 'Claude session pace', shortLabel: 'C↑', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Sess pace', window: 'session', metric: 'pace'},
    {key: 'claude-weekly-pace', label: 'Claude weekly pace', shortLabel: 'Cw↑', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Wk pace', window: 'weekly', metric: 'pace'},
    {key: 'codex-session-pace', label: 'Codex session pace', shortLabel: 'X↑', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Sess pace', window: 'session', metric: 'pace'},
    {key: 'codex-weekly-pace', label: 'Codex weekly pace', shortLabel: 'Xw↑', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Wk pace', window: 'weekly', metric: 'pace'},
];

const PANEL_ITEM_SHORT_LABELS = {};
for (const item of PANEL_ITEMS)
    PANEL_ITEM_SHORT_LABELS[item.key] = item.shortLabel;

function getPanelItemValue(summary, item, now) {
    if (!item || item.window === null)
        return summary?.minRemainingPct;

    const data = summary?.providers?.[item.providerKey]?.data;
    if (!data)
        return undefined;

    const remainingPct = item.window === 'session'
        ? data.sessionRemainingPct
        : data.weeklyRemainingPct;

    if (item.metric === 'remaining')
        return remainingPct;

    const resetsAtIso = item.window === 'session' ? data.sessionResetsAtIso : data.weeklyResetsAtIso;
    const windowMs = item.window === 'session' ? data.sessionWindowMs : data.weeklyWindowMs;
    const pace = computeUtilizationPct(remainingPct, resetsAtIso, windowMs, now);
    return Number.isFinite(pace) ? pace : undefined;
}

function getPanelLabelValue(summary, mode, now) {
    if (mode === 'min' || !mode)
        return summary?.minRemainingPct;

    const item = PANEL_ITEMS.find((entry) => entry.key === mode);
    if (!item)
        return summary?.minRemainingPct;

    return getPanelItemValue(summary, item, now);
}

function buildPanelLabel(summary, deps, now) {
    if (!Array.isArray(deps.panelItems))
        return formatPercent(getPanelLabelValue(summary, deps.panelLabelMode ?? 'min', now));

    const items = deps.panelItems.filter(key => key in PANEL_ITEM_SHORT_LABELS);
    if (items.length === 0)
        return '--';

    const showLabels = (deps.panelShowLabels ?? true) && items.length > 1;

    return items
        .map(key => {
            const pct = formatPercent(getPanelLabelValue(summary, key, now));
            return showLabels ? `${PANEL_ITEM_SHORT_LABELS[key]} ${pct}` : pct;
        })
        .join(' · ');
}

// Structured form of the panel label for widget-based renderers (GNOME):
// items grouped per provider so each group can carry the provider logo, with
// a health color per value. The joined-string panelLabel remains for KDE.
function buildPanelGroups(summary, deps, now) {
    if (!summary || !Array.isArray(deps.panelItems))
        return [];

    const showLabels = deps.panelShowLabels ?? true;
    const groups = [];
    const groupByProvider = new Map();

    for (const key of deps.panelItems) {
        const item = PANEL_ITEMS.find((entry) => entry.key === key);
        if (!item)
            continue;

        const groupKey = item.providerKey ?? item.key;
        let group = groupByProvider.get(groupKey);
        if (!group) {
            group = {providerKey: item.providerKey, items: []};
            groupByProvider.set(groupKey, group);
            groups.push(group);
        }

        const pct = getPanelItemValue(summary, item, now);
        group.items.push({
            key,
            label: showLabels ? item.windowLabel : '',
            percentText: formatPercent(pct),
            dotColor: item.metric === 'pace' ? getPaceColor(pct) : getDotColor(pct),
        });
    }

    return groups;
}

function formatPercent(value) {
    if (!Number.isFinite(value))
        return '--';

    return `${Math.round(value)}%`;
}

export function getDotColor(pct) {
    if (!Number.isFinite(pct))
        return 'red';

    if (pct >= 70)
        return 'green';

    if (pct >= 30)
        return 'yellow';

    return 'red';
}

// A pace projection needs enough of the window to have elapsed to be meaningful;
// in the first sliver of a window a tiny sample extrapolates to wild numbers.
const MIN_ELAPSED_FRACTION = 0.05;

// Projected end-of-window utilization: extrapolate the usage consumed so far
// across the full window. 100 means on pace to use the entire window by the time
// it resets; below 100 means quota will be left unused; above 100 means usage is
// on pace to be exhausted before the reset. Returns null when it cannot be
// projected (missing window duration/reset, or too early in the window).
export function computeUtilizationPct(remainingPct, resetsAtIso, windowMs, now) {
    if (!Number.isFinite(remainingPct) || !Number.isFinite(windowMs) || windowMs <= 0)
        return null;

    if (!resetsAtIso)
        return null;

    const resetsAt = new Date(resetsAtIso).getTime();
    // A reset time at or before now means the stored window has already expired
    // (stale data between polls); its pace is no longer current, so report it as
    // unknown rather than projecting the old window's usage.
    if (Number.isNaN(resetsAt) || resetsAt <= now)
        return null;

    const elapsedFraction = Math.min(1, (windowMs - (resetsAt - now)) / windowMs);
    if (!Number.isFinite(elapsedFraction) || elapsedFraction < MIN_ELAPSED_FRACTION)
        return null;

    const usedPct = Math.max(0, 100 - remainingPct);
    return usedPct / elapsedFraction;
}

// Pace color is inverted from remaining%: the goal is to fully use each window,
// so a high projected utilization is healthy and a low one means wasted quota.
export function getPaceColor(pacePct) {
    if (!Number.isFinite(pacePct))
        return 'red';

    if (pacePct >= 85)
        return 'green';

    if (pacePct >= 55)
        return 'yellow';

    return 'red';
}

function formatPaceText(pacePct) {
    if (!Number.isFinite(pacePct))
        return 'On pace: --';

    return `On pace: ${Math.round(pacePct)}%`;
}

export function formatRelativeTime(iso, now) {
    if (!iso)
        return '--';

    const target = new Date(iso).getTime();
    if (Number.isNaN(target))
        return '--';

    const diffMs = target - now;
    if (diffMs <= 0)
        return '--';

    const totalMinutes = Math.floor(diffMs / 60_000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0)
        parts.push(`${days}d`);

    if (hours > 0)
        parts.push(`${hours}h`);

    if (minutes > 0 || parts.length === 0)
        parts.push(`${minutes}m`);

    return parts.join(' ');
}

function formatRemainingText(pct) {
    if (!Number.isFinite(pct))
        return '-- left';

    return `${Math.round(pct)}% left`;
}

function formatResetsIn(iso, now) {
    const rel = formatRelativeTime(iso, now);
    if (rel === '--')
        return '--';

    return `Resets in ${rel}`;
}

function toWarningText(providerLabel, code) {
    if (code === 'AUTH_EXPIRED')
        return `${providerLabel}: authentication expired`;

    if (code === 'PARTIAL_DATA')
        return `${providerLabel}: partial usage data`;

    if (code === 'NETWORK_ERROR')
        return `${providerLabel}: network error`;

    if (code === 'SCHEMA_CHANGED')
        return `${providerLabel}: schema changed`;

    return '';
}

function buildWindowViewModel(label, remainingPct, resetsAtIso, windowMs, now) {
    const pacePct = computeUtilizationPct(remainingPct, resetsAtIso, windowMs, now);

    return {
        label,
        remainingPct: Number.isFinite(remainingPct) ? Math.round(remainingPct) : 0,
        remainingText: formatRemainingText(remainingPct),
        resetsInText: formatResetsIn(resetsAtIso, now),
        dotColor: getDotColor(remainingPct),
        pacePct: Number.isFinite(pacePct) ? Math.round(pacePct) : null,
        paceText: formatPaceText(pacePct),
        paceColor: getPaceColor(pacePct),
    };
}

function buildServiceViewModel(name, providerData, providerCode, now) {
    const data = providerData ?? null;

    return {
        name,
        windows: [
            buildWindowViewModel(
                'Session',
                data?.sessionRemainingPct,
                data?.sessionResetsAtIso,
                data?.sessionWindowMs,
                now,
            ),
            buildWindowViewModel(
                'Weekly',
                data?.weeklyRemainingPct,
                data?.weeklyResetsAtIso,
                data?.weeklyWindowMs,
                now,
            ),
        ],
        warning: toWarningText(name, providerCode),
    };
}

function formatNextUpdate(lastUpdatedAtIso, pollIntervalMs, now) {
    if (!lastUpdatedAtIso || !Number.isFinite(pollIntervalMs))
        return 'Next update in --';

    const lastMs = new Date(lastUpdatedAtIso).getTime();
    if (Number.isNaN(lastMs))
        return 'Next update in --';

    const nextMs = lastMs + pollIntervalMs;
    const diffMs = nextMs - now;

    if (diffMs <= 0)
        return 'Next update in 0m';

    const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
    return `Next update in ${totalMinutes}m`;
}

export function buildUsageViewModel(summary, deps = {}) {
    const now = deps.now ?? Date.now();
    const version = deps.version ?? VERSION;
    const pollIntervalMs = deps.pollIntervalMs ?? 180_000;

    const claude = summary?.providers?.claude ?? null;
    const codex = summary?.providers?.codex ?? null;

    return {
        panelLabel: buildPanelLabel(summary, deps, now),
        panelGroups: buildPanelGroups(summary, deps, now),
        services: [
            buildServiceViewModel('Codex', codex?.data, codex?.code, now),
            buildServiceViewModel('Claude', claude?.data, claude?.code, now),
        ],
        version,
        lastUpdate: formatNextUpdate(summary?.lastUpdatedAtIso, pollIntervalMs, now),
    };
}
