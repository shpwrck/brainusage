const VERSION = 'brainusage 1.0.1';

export const PANEL_LABEL_MODES = ['min', 'claude-session', 'claude-weekly', 'codex-session', 'codex-weekly'];

// Single source of truth for the multi-metric panel display: keys, per-provider
// grouping, and the labels every consumer (panel widgets, settings menu) derives from.
export const PANEL_METRICS = [
    {key: 'codex-session', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Session', shortLabel: 's', field: 'sessionRemainingPct'},
    {key: 'codex-weekly', providerKey: 'codex', providerName: 'Codex', windowLabel: 'Week', shortLabel: 'w', field: 'weeklyRemainingPct'},
    {key: 'claude-session', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Session', shortLabel: 's', field: 'sessionRemainingPct'},
    {key: 'claude-weekly', providerKey: 'claude', providerName: 'Claude', windowLabel: 'Week', shortLabel: 'w', field: 'weeklyRemainingPct'},
];

export const PANEL_DISPLAY_MODES = PANEL_METRICS.map((metric) => metric.key);
export const PANEL_PERCENT_MODES = ['remaining', 'used'];
export const PANEL_LABEL_STYLES = ['expanded', 'compact'];

// Selection is stored as a set of keys; rendering always uses the canonical
// PANEL_METRICS order. A non-array (unset) or a selection containing no valid
// key falls back to showing everything, so a stale/renamed stored value can
// never blank the panel. An explicitly empty selection means "show nothing".
function normalizePanelDisplayModes(modes) {
    if (!Array.isArray(modes))
        return [...PANEL_DISPLAY_MODES];

    if (modes.length === 0)
        return [];

    const requested = new Set(modes);
    const valid = PANEL_DISPLAY_MODES.filter((key) => requested.has(key));

    return valid.length > 0 ? valid : [...PANEL_DISPLAY_MODES];
}

function buildPanelGroups(summary, panelDisplayModes, panelPercentMode, panelLabelStyle) {
    if (!summary)
        return [];

    const groups = [];
    const groupByProvider = new Map();

    for (const key of normalizePanelDisplayModes(panelDisplayModes)) {
        const metric = PANEL_METRICS.find((entry) => entry.key === key);
        const remainingPct = summary?.providers?.[metric.providerKey]?.data?.[metric.field];
        const value = panelPercentMode === 'used' && Number.isFinite(remainingPct)
            ? 100 - remainingPct
            : remainingPct;

        let group = groupByProvider.get(metric.providerKey);
        if (!group) {
            group = {
                providerKey: metric.providerKey,
                providerName: metric.providerName,
                items: [],
            };
            groupByProvider.set(metric.providerKey, group);
            groups.push(group);
        }

        group.items.push({
            key: metric.key,
            label: panelLabelStyle === 'compact' ? metric.shortLabel : metric.windowLabel,
            percentText: formatPercent(value),
            // Health color always tracks remaining%, regardless of percent mode.
            dotColor: getDotColor(remainingPct),
        });
    }

    return groups;
}

function getPanelLabelValue(summary, mode) {
    if (mode === 'min' || !mode)
        return summary?.minRemainingPct;

    const providers = summary?.providers;
    if (!providers)
        return undefined;

    switch (mode) {
        case 'claude-session': return providers.claude?.data?.sessionRemainingPct;
        case 'claude-weekly':  return providers.claude?.data?.weeklyRemainingPct;
        case 'codex-session':  return providers.codex?.data?.sessionRemainingPct;
        case 'codex-weekly':   return providers.codex?.data?.weeklyRemainingPct;
        default: return summary?.minRemainingPct;
    }
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

function buildWindowViewModel(label, remainingPct, resetsAtIso, now) {
    return {
        label,
        remainingPct: Number.isFinite(remainingPct) ? Math.round(remainingPct) : 0,
        remainingText: formatRemainingText(remainingPct),
        resetsInText: formatResetsIn(resetsAtIso, now),
        dotColor: getDotColor(remainingPct),
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
                now,
            ),
            buildWindowViewModel(
                'Weekly',
                data?.weeklyRemainingPct,
                data?.weeklyResetsAtIso,
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
    const panelLabelMode = deps.panelLabelMode ?? 'min';
    const panelPercentMode = deps.panelPercentMode === 'used' ? 'used' : 'remaining';
    const panelLabelStyle = deps.panelLabelStyle === 'compact' ? 'compact' : 'expanded';

    const claude = summary?.providers?.claude ?? null;
    const codex = summary?.providers?.codex ?? null;

    return {
        panelLabel: formatPercent(getPanelLabelValue(summary, panelLabelMode)),
        panelGroups: buildPanelGroups(summary, deps.panelDisplayModes, panelPercentMode, panelLabelStyle),
        panelPercentMode,
        panelLabelStyle,
        services: [
            buildServiceViewModel('Codex', codex?.data, codex?.code, now),
            buildServiceViewModel('Claude', claude?.data, claude?.code, now),
        ],
        version,
        lastUpdate: formatNextUpdate(summary?.lastUpdatedAtIso, pollIntervalMs, now),
    };
}
