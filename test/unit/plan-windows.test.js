import {expect, test} from 'bun:test';
import {normalizeCodexUsage} from '../../shared/core/normalize.js';
import {buildUsageViewModel} from '../../shared/ui/render.js';
import {computeSummary} from '../../shared/core/aggregate.js';
import {createCodexProvider} from '../../shared/providers/codex.js';

const weekly = {used_percent: 23, limit_window_seconds: 604800, reset_at: 1789473970};
for (const slot of ['primary_window', 'secondary_window']) {
    test(`weekly-only plan in ${slot} has no session or false zero`, async () => {
        const payload = {plan_type: 'pro', rate_limit: {primary_window: null, secondary_window: null, [slot]: weekly}};
        const provider = createCodexProvider({readTextFile: async () => JSON.stringify({tokens: {access_token: 'test'}}),
            fetch: async () => ({ok: true, json: async () => payload})});
        const result = await provider.getUsage();
        expect(result.ok).toBe(true);
        expect(result.data.sessionRemainingPct).toBeNull();
        expect(result.data.weeklyRemainingPct).toBe(77);
        const summary = computeSummary(new Map([['codex', {data: result.data, code: 'OK'}]]));
        expect(summary.minRemainingPct).toBe(77);
        const view = buildUsageViewModel(summary, {panelItems: ['codex-session', 'codex-weekly', 'codex-session-pace']});
        expect(view.services[0].name).toBe('Codex (Pro)');
        expect(view.services[0].warning).toBe('');
        expect(view.services[0].windows.map(w => w.label)).toEqual(['Weekly']);
        expect(view.panelLabel).toBe('77%');
        expect(view.panelGroups[0].items.map(i => i.key)).toEqual(['codex-weekly']);
    });
}

test('plan name does not override the actual windows', () => {
    const normalized = normalizeCodexUsage({plan_type: 'pro', rate_limit: {
        primary_window: {used_percent: 30, limit_window_seconds: 18000}, secondary_window: weekly}});
    expect(normalized.data.availableWindows).toEqual(['session', 'weekly']);
    expect(normalized.data.sessionRemainingPct).toBe(70);
});

test('malformed usage stays unknown rather than becoming zero or full quota', () => {
    for (const used_percent of [null, undefined, 'bad', NaN]) {
        const normalized = normalizeCodexUsage({rate_limit: {primary_window: {...weekly, used_percent}}});
        expect(normalized.hasPartialData).toBe(true);
        expect(normalized.data.weeklyRemainingPct).toBeNull();
    }
});
