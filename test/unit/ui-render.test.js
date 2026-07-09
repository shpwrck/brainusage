import {describe, expect, test} from 'bun:test';

import {
    buildUsageViewModel,
    computeUtilizationPct,
    formatRelativeTime,
    getDotColor,
    getPaceColor,
    PANEL_ITEMS,
    PANEL_LABEL_MODES,
} from '../../shared/ui/render.js';

const NOW = new Date('2026-02-09T10:00:00Z').getTime();

function makeWindow(label, pct, resetsInText, dotColor, pace = null) {
    return {
        label,
        remainingPct: pct,
        remainingText: `${pct}% left`,
        resetsInText,
        dotColor,
        pacePct: pace?.pacePct ?? null,
        paceText: pace?.paceText ?? 'On pace: --',
        paceColor: pace?.paceColor ?? 'red',
    };
}

describe('buildUsageViewModel', () => {
    test('renders placeholder values when summary is null', () => {
        const view = buildUsageViewModel(null, {now: NOW});

        expect(view.panelLabel).toBe('--');
        expect(view.services).toHaveLength(2);
        expect(view.services[0].name).toBe('Codex');
        expect(view.services[1].name).toBe('Claude');

        for (const svc of view.services) {
            expect(svc.warning).toBe('');

            for (const w of svc.windows) {
                expect(w.remainingPct).toBe(0);
                expect(w.remainingText).toBe('-- left');
                expect(w.resetsInText).toBe('--');
                expect(w.dotColor).toBe('red');
            }
        }

        expect(view.version).toBe('brainusage 1.0.1');
        expect(view.lastUpdate).toBe('Next update in --');
    });

    test('maps usage values with relative reset times', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            lastUpdatedAtIso: '2026-02-09T09:58:00.000Z',
            providers: {
                claude: {
                    code: 'OK',
                    data: {
                        sessionRemainingPct: 60,
                        weeklyRemainingPct: 25,
                        sessionResetsAtIso: '2026-02-09T12:18:00.000Z',
                        weeklyResetsAtIso: '2026-02-13T17:00:00.000Z',
                    },
                },
                codex: {
                    code: 'AUTH_EXPIRED',
                    data: {
                        sessionRemainingPct: 73,
                        weeklyRemainingPct: 91,
                        sessionResetsAtIso: '2026-02-09T12:18:00.000Z',
                        weeklyResetsAtIso: '2026-02-13T17:00:00.000Z',
                    },
                },
            },
        }, {now: NOW});

        expect(view.panelLabel).toBe('12%');

        const codex = view.services[0];
        expect(codex.name).toBe('Codex');
        expect(codex.windows[0]).toEqual(makeWindow('Session', 73, 'Resets in 2h 18m', 'green'));
        expect(codex.windows[1]).toEqual(makeWindow('Weekly', 91, 'Resets in 4d 7h', 'green'));
        expect(codex.warning).toBe('Codex: authentication expired');

        const claude = view.services[1];
        expect(claude.name).toBe('Claude');
        expect(claude.windows[0]).toEqual(makeWindow('Session', 60, 'Resets in 2h 18m', 'yellow'));
        expect(claude.windows[1]).toEqual(makeWindow('Weekly', 25, 'Resets in 4d 7h', 'red'));
        expect(claude.warning).toBe('');
    });

    test('shows warning messages for error states', () => {
        const view = buildUsageViewModel({
            providers: {
                claude: {code: 'NETWORK_ERROR', data: null},
                codex: {code: 'PARTIAL_DATA', data: null},
            },
        }, {now: NOW});

        expect(view.services[1].warning).toBe('Claude: network error');
        expect(view.services[0].warning).toBe('Codex: partial usage data');
    });

    test('formats next update countdown from last update time', () => {
        const view = buildUsageViewModel({
            lastUpdatedAtIso: '2026-02-09T09:58:00.000Z',
            providers: {},
        }, {now: NOW, pollIntervalMs: 180_000});

        expect(view.lastUpdate).toBe('Next update in 1m');
    });

    test('shows 0m when update is overdue', () => {
        const view = buildUsageViewModel({
            lastUpdatedAtIso: '2026-02-09T09:50:00.000Z',
            providers: {},
        }, {now: NOW, pollIntervalMs: 180_000});

        expect(view.lastUpdate).toBe('Next update in 0m');
    });

    test('accepts custom version string', () => {
        const view = buildUsageViewModel(null, {now: NOW, version: 'test 1.0'});
        expect(view.version).toBe('test 1.0');
    });

    test('panelLabelMode claude-session shows claude session %', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            providers: {
                claude: {
                    code: 'OK',
                    data: {sessionRemainingPct: 60, weeklyRemainingPct: 25},
                },
                codex: {
                    code: 'OK',
                    data: {sessionRemainingPct: 73, weeklyRemainingPct: 91},
                },
            },
        }, {now: NOW, panelLabelMode: 'claude-session'});
        expect(view.panelLabel).toBe('60%');
    });

    test('panelLabelMode claude-weekly shows claude weekly %', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            providers: {
                claude: {
                    code: 'OK',
                    data: {sessionRemainingPct: 60, weeklyRemainingPct: 25},
                },
            },
        }, {now: NOW, panelLabelMode: 'claude-weekly'});
        expect(view.panelLabel).toBe('25%');
    });

    test('panelLabelMode codex-session shows codex session %', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            providers: {
                codex: {
                    code: 'OK',
                    data: {sessionRemainingPct: 73, weeklyRemainingPct: 91},
                },
            },
        }, {now: NOW, panelLabelMode: 'codex-session'});
        expect(view.panelLabel).toBe('73%');
    });

    test('panelLabelMode codex-weekly shows codex weekly %', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            providers: {
                codex: {
                    code: 'OK',
                    data: {sessionRemainingPct: 73, weeklyRemainingPct: 91},
                },
            },
        }, {now: NOW, panelLabelMode: 'codex-weekly'});
        expect(view.panelLabel).toBe('91%');
    });

    test('panelLabelMode defaults to min', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 12.4,
            providers: {
                claude: {
                    code: 'OK',
                    data: {sessionRemainingPct: 60, weeklyRemainingPct: 25},
                },
            },
        }, {now: NOW});
        expect(view.panelLabel).toBe('12%');
    });

    test('panelLabelMode with missing provider data shows --', () => {
        const view = buildUsageViewModel({providers: {}}, {now: NOW, panelLabelMode: 'claude-session'});
        expect(view.panelLabel).toBe('--');
    });

    test('panelLabelMode with unknown mode falls back to min', () => {
        const view = buildUsageViewModel({
            minRemainingPct: 42,
            providers: {},
        }, {now: NOW, panelLabelMode: 'unknown-mode'});
        expect(view.panelLabel).toBe('42%');
    });
});

describe('panelItems', () => {
    const SUMMARY = {
        minRemainingPct: 12.4,
        providers: {
            claude: {
                code: 'OK',
                data: {sessionRemainingPct: 60, weeklyRemainingPct: 25},
            },
            codex: {
                code: 'OK',
                data: {sessionRemainingPct: 73, weeklyRemainingPct: 91},
            },
        },
    };

    test('PANEL_ITEMS includes every legacy panel label mode', () => {
        const keys = new Set(PANEL_ITEMS.map(item => item.key));
        for (const mode of PANEL_LABEL_MODES)
            expect(keys.has(mode)).toBe(true);
    });

    test('multiple items are labeled and joined', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-session', 'codex-session'],
        });
        expect(view.panelLabel).toBe('C 60% · X 73%');
    });

    test('single item stays unlabeled', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-weekly'],
        });
        expect(view.panelLabel).toBe('25%');
    });

    test('panelShowLabels false drops labels', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-session', 'codex-weekly'],
            panelShowLabels: false,
        });
        expect(view.panelLabel).toBe('60% · 91%');
    });

    test('min mixes with provider items', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['min', 'codex-session'],
        });
        expect(view.panelLabel).toBe('Min 12% · X 73%');
    });

    test('empty list renders a placeholder', () => {
        const view = buildUsageViewModel(SUMMARY, {now: NOW, panelItems: []});
        expect(view.panelLabel).toBe('--');
    });

    test('unknown keys are ignored', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['bogus', 'claude-session'],
        });
        expect(view.panelLabel).toBe('60%');
    });

    test('missing provider data renders -- per item', () => {
        const view = buildUsageViewModel({minRemainingPct: 42, providers: {}}, {
            now: NOW,
            panelItems: ['claude-session', 'codex-session'],
        });
        expect(view.panelLabel).toBe('C -- · X --');
    });

    test('panelItems takes precedence over panelLabelMode', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['codex-weekly'],
            panelLabelMode: 'claude-session',
        });
        expect(view.panelLabel).toBe('91%');
    });
});

describe('panelGroups', () => {
    const SUMMARY = {
        minRemainingPct: 12.4,
        providers: {
            claude: {
                code: 'OK',
                data: {sessionRemainingPct: 60, weeklyRemainingPct: 25},
            },
            codex: {
                code: 'OK',
                data: {sessionRemainingPct: 73, weeklyRemainingPct: 91},
            },
        },
    };

    test('groups provider metrics with window labels and health colors', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-session', 'claude-weekly', 'codex-session'],
        });

        expect(view.panelGroups).toEqual([
            {providerKey: 'claude', items: [
                {key: 'claude-session', label: 'Session', percentText: '60%', dotColor: 'yellow'},
                {key: 'claude-weekly', label: 'Week', percentText: '25%', dotColor: 'red'},
            ]},
            {providerKey: 'codex', items: [
                {key: 'codex-session', label: 'Session', percentText: '73%', dotColor: 'green'},
            ]},
        ]);
    });

    test('min renders as its own group without a provider', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['min', 'codex-session'],
        });

        expect(view.panelGroups[0]).toEqual({providerKey: null, items: [
            {key: 'min', label: 'Min', percentText: '12%', dotColor: 'red'},
        ]});
    });

    test('panelShowLabels false empties item labels but keeps values', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-session'],
            panelShowLabels: false,
        });

        expect(view.panelGroups).toEqual([
            {providerKey: 'claude', items: [
                {key: 'claude-session', label: '', percentText: '60%', dotColor: 'yellow'},
            ]},
        ]);
    });

    test('unknown keys are skipped and empty selection yields no groups', () => {
        expect(buildUsageViewModel(SUMMARY, {now: NOW, panelItems: ['bogus']}).panelGroups).toEqual([]);
        expect(buildUsageViewModel(SUMMARY, {now: NOW, panelItems: []}).panelGroups).toEqual([]);
    });

    test('missing provider data renders placeholder with red status', () => {
        const view = buildUsageViewModel({providers: {}}, {
            now: NOW,
            panelItems: ['codex-session'],
        });

        expect(view.panelGroups).toEqual([
            {providerKey: 'codex', items: [
                {key: 'codex-session', label: 'Session', percentText: '--', dotColor: 'red'},
            ]},
        ]);
    });

    test('null summary and legacy panelLabelMode callers get no groups', () => {
        expect(buildUsageViewModel(null, {now: NOW}).panelGroups).toEqual([]);
        expect(buildUsageViewModel(SUMMARY, {now: NOW, panelLabelMode: 'min'}).panelGroups).toEqual([]);
    });
});

describe('formatRelativeTime', () => {
    test('formats hours and minutes', () => {
        const reset = '2026-02-09T12:18:00.000Z';
        expect(formatRelativeTime(reset, NOW)).toBe('2h 18m');
    });

    test('formats days and hours', () => {
        const reset = '2026-02-13T17:00:00.000Z';
        expect(formatRelativeTime(reset, NOW)).toBe('4d 7h');
    });

    test('formats minutes only', () => {
        const reset = '2026-02-09T10:31:00.000Z';
        expect(formatRelativeTime(reset, NOW)).toBe('31m');
    });

    test('returns -- for past timestamps', () => {
        const reset = '2026-02-09T09:00:00.000Z';
        expect(formatRelativeTime(reset, NOW)).toBe('--');
    });

    test('returns -- for null', () => {
        expect(formatRelativeTime(null, NOW)).toBe('--');
    });

    test('returns -- for invalid ISO', () => {
        expect(formatRelativeTime('not-a-date', NOW)).toBe('--');
    });

    test('returns 0m when difference is under 1 minute', () => {
        const reset = '2026-02-09T10:00:30.000Z';
        expect(formatRelativeTime(reset, NOW)).toBe('0m');
    });
});

describe('getDotColor', () => {
    test('green for >= 70', () => {
        expect(getDotColor(70)).toBe('green');
        expect(getDotColor(100)).toBe('green');
    });

    test('yellow for 30-69', () => {
        expect(getDotColor(30)).toBe('yellow');
        expect(getDotColor(69)).toBe('yellow');
    });

    test('red for < 30', () => {
        expect(getDotColor(29)).toBe('red');
        expect(getDotColor(0)).toBe('red');
    });

    test('red for non-finite', () => {
        expect(getDotColor(undefined)).toBe('red');
        expect(getDotColor(NaN)).toBe('red');
    });
});

describe('computeUtilizationPct', () => {
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
    // Half the 5h window elapsed (resets 2h30m from NOW).
    const HALFWAY_RESET = '2026-02-09T12:30:00.000Z';

    test('projects end-of-window usage from the elapsed fraction', () => {
        // 60% used in the first half of the window projects to 120%.
        expect(computeUtilizationPct(40, HALFWAY_RESET, FIVE_HOURS_MS, NOW)).toBe(120);
        // Exactly on pace to fill the window.
        expect(computeUtilizationPct(50, HALFWAY_RESET, FIVE_HOURS_MS, NOW)).toBe(100);
        // Under pace: quota will be left unused.
        expect(computeUtilizationPct(80, HALFWAY_RESET, FIVE_HOURS_MS, NOW)).toBe(40);
    });

    test('returns null too early in the window', () => {
        // Resets 4h58m from NOW => only 2m of a 5h window elapsed.
        const almostFull = '2026-02-09T14:58:00.000Z';
        expect(computeUtilizationPct(90, almostFull, FIVE_HOURS_MS, NOW)).toBeNull();
    });

    test('returns null without a window duration or reset time', () => {
        expect(computeUtilizationPct(40, HALFWAY_RESET, null, NOW)).toBeNull();
        expect(computeUtilizationPct(40, null, FIVE_HOURS_MS, NOW)).toBeNull();
        expect(computeUtilizationPct(undefined, HALFWAY_RESET, FIVE_HOURS_MS, NOW)).toBeNull();
    });
});

describe('getPaceColor', () => {
    test('green when on pace to fill (>= 85)', () => {
        expect(getPaceColor(85)).toBe('green');
        expect(getPaceColor(140)).toBe('green');
    });

    test('yellow when moderately under pace (55-84)', () => {
        expect(getPaceColor(55)).toBe('yellow');
        expect(getPaceColor(84)).toBe('yellow');
    });

    test('red when far under pace or unknown', () => {
        expect(getPaceColor(54)).toBe('red');
        expect(getPaceColor(null)).toBe('red');
    });
});

describe('utilization surfaces in windows and panel items', () => {
    const SUMMARY = {
        minRemainingPct: 40,
        providers: {
            claude: {
                code: 'OK',
                data: {
                    sessionRemainingPct: 40,
                    weeklyRemainingPct: 40,
                    sessionResetsAtIso: '2026-02-09T12:30:00.000Z',
                    weeklyResetsAtIso: null,
                    sessionWindowMs: 5 * 60 * 60 * 1000,
                    weeklyWindowMs: 7 * 24 * 60 * 60 * 1000,
                },
            },
        },
    };

    test('window view model carries projected utilization', () => {
        const claude = buildUsageViewModel(SUMMARY, {now: NOW}).services[1];
        expect(claude.windows[0].pacePct).toBe(120);
        expect(claude.windows[0].paceText).toBe('On pace: 120%');
        expect(claude.windows[0].paceColor).toBe('green');
        // Weekly has no reset time here, so pace is unknown.
        expect(claude.windows[1].pacePct).toBeNull();
        expect(claude.windows[1].paceText).toBe('On pace: --');
    });

    test('pace panel items render the projected value with pace colors', () => {
        const view = buildUsageViewModel(SUMMARY, {
            now: NOW,
            panelItems: ['claude-session-pace'],
        });
        expect(view.panelLabel).toBe('120%');
        expect(view.panelGroups).toEqual([
            {providerKey: 'claude', items: [
                {key: 'claude-session-pace', label: 'Sess pace', percentText: '120%', dotColor: 'green'},
            ]},
        ]);
    });
});
