import {describe, expect, test} from 'bun:test';

import {createClaudeProvider, claudeProviderConfig} from '../../shared/providers/claude.js';

function createJsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        },
    };
}

describe('Claude provider', () => {
    test('returns missing_creds when credentials file is absent', async () => {
        const provider = createClaudeProvider({
            readTextFile: async () => {
                throw new Error('ENOENT');
            },
            fetch: async () => createJsonResponse(200, {}),
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('missing_creds');
    });

    test('returns parse_error when credentials JSON is invalid', async () => {
        const provider = createClaudeProvider({
            readTextFile: async () => '{bad json',
            fetch: async () => createJsonResponse(200, {}),
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('parse_error');
    });

    test('refreshes when token is expired then normalizes usage response', async () => {
        const calls = [];
        const fetchMock = async (url, options) => {
            calls.push({url, options});

            if (url === claudeProviderConfig.REFRESH_ENDPOINT) {
                expect(options.headers['content-type']).toBe('application/json');
                expect(JSON.parse(options.body).grant_type).toBe('refresh_token');
                return createJsonResponse(200, {
                    access_token: 'fresh-token',
                    expires_at: new Date(Date.now() + 60_000).toISOString(),
                });
            }

            if (url === claudeProviderConfig.USAGE_ENDPOINT) {
                expect(options.headers['anthropic-beta']).toBe('oauth-2025-04-20');
                expect(options.headers.authorization).toBe('Bearer fresh-token');

                return createJsonResponse(200, {
                    five_hour: {
                        utilization: 40,
                        resets_at: '2026-02-09T00:00:00.000Z',
                    },
                    seven_day: {
                        utilization: 75,
                        resets_at: '2026-02-12T00:00:00.000Z',
                    },
                });
            }

            throw new Error(`Unexpected URL: ${url}`);
        };

        const provider = createClaudeProvider({
            readTextFile: async () => JSON.stringify({
                claudeAiOauth: {
                    access_token: 'stale-token',
                    refresh_token: 'refresh-token',
                    expires_at: new Date(Date.now() - 60_000).toISOString(),
                },
            }),
            fetch: fetchMock,
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            sessionRemainingPct: 60,
            weeklyRemainingPct: 25,
            sessionResetsAtIso: '2026-02-09T00:00:00.000Z',
            weeklyResetsAtIso: '2026-02-12T00:00:00.000Z',
            sessionWindowMs: 5 * 60 * 60 * 1000,
            weeklyWindowMs: 7 * 24 * 60 * 60 * 1000,
        });
        expect(calls.map((entry) => entry.url)).toEqual([
            claudeProviderConfig.REFRESH_ENDPOINT,
            claudeProviderConfig.USAGE_ENDPOINT,
        ]);
    });

    test('refreshes after usage 401 and retries once', async () => {
        let usageCallCount = 0;

        const provider = createClaudeProvider({
            readTextFile: async () => JSON.stringify({
                claudeAiOauth: {
                    access_token: 'initial-token',
                    refresh_token: 'refresh-token',
                },
            }),
            fetch: async (url, options) => {
                if (url === claudeProviderConfig.USAGE_ENDPOINT) {
                    usageCallCount += 1;

                    if (usageCallCount === 1)
                        return createJsonResponse(401, {});

                    expect(options.headers.authorization).toBe('Bearer retried-token');
                    return createJsonResponse(200, {
                        five_hour: {utilization: 10, resets_at: '2026-02-09T00:00:00.000Z'},
                        seven_day: {utilization: 50, resets_at: '2026-02-12T00:00:00.000Z'},
                    });
                }

                if (url === claudeProviderConfig.REFRESH_ENDPOINT) {
                    return createJsonResponse(200, {
                        access_token: 'retried-token',
                    });
                }

                throw new Error(`Unexpected URL: ${url}`);
            },
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(true);
        expect(usageCallCount).toBe(2);
        expect(result.data.sessionRemainingPct).toBe(90);
    });

    test('returns auth_expired when refresh is rejected', async () => {
        const provider = createClaudeProvider({
            readTextFile: async () => JSON.stringify({
                claudeAiOauth: {
                    access_token: 'expired',
                    refresh_token: 'bad-refresh',
                    expires_at: new Date(Date.now() - 60_000).toISOString(),
                },
            }),
            fetch: async (url) => {
                if (url === claudeProviderConfig.REFRESH_ENDPOINT)
                    return createJsonResponse(401, {});

                throw new Error(`Unexpected URL: ${url}`);
            },
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('auth_expired');
    });

    test('returns network_error when fetch throws', async () => {
        const provider = createClaudeProvider({
            readTextFile: async () => JSON.stringify({
                claudeAiOauth: {
                    access_token: 'token',
                    refresh_token: 'refresh-token',
                },
            }),
            fetch: async () => {
                throw new Error('network down');
            },
        });

        const result = await provider.getUsage();

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('network_error');
    });
});

function rotatingProvider(options = {}) {
    let raw = JSON.stringify({extra: 'preserved', claudeAiOauth: {
        accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 1, subscriptionType: 'max',
    }});
    let refreshes = 0;
    const provider = createClaudeProvider({
        readTextFile: async () => raw,
        replaceTextFile: async (_path, expected, updated) => {
            expect(raw).toBe(expected);
            if (options.saveFailure?.()) throw new Error('write failed');
            raw = updated;
        },
        fetch: async (url, init) => {
            if (url === claudeProviderConfig.REFRESH_ENDPOINT) {
                refreshes++;
                return createJsonResponse(200, {access_token: 'new', refresh_token: 'refresh-new', expires_in: 3600});
            }
            expect(init.headers.authorization).toBe('Bearer new');
            return createJsonResponse(200, {five_hour: {utilization: 10}, seven_day: {utilization: 20}});
        },
    });
    return {provider, raw: () => JSON.parse(raw), refreshes: () => refreshes};
}

test('persists rotated Claude credentials, expiry and unrelated metadata across polls', async () => {
    const fixture = rotatingProvider();
    expect((await fixture.provider.getUsage()).ok).toBe(true);
    expect((await fixture.provider.getUsage()).ok).toBe(true);
    expect(fixture.refreshes()).toBe(1);
    expect(fixture.raw().extra).toBe('preserved');
    expect(fixture.raw().claudeAiOauth.subscriptionType).toBe('max');
    expect(fixture.raw().claudeAiOauth.refreshToken).toBe('refresh-new');
    expect(fixture.raw().claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
});

test('retries saving without spending the old refresh token again', async () => {
    let fail = true;
    const fixture = rotatingProvider({saveFailure: () => fail});
    expect((await fixture.provider.getUsage()).ok).toBe(false);
    fail = false;
    expect((await fixture.provider.getUsage()).ok).toBe(true);
    expect(fixture.refreshes()).toBe(1);
    expect(fixture.raw().claudeAiOauth.refreshToken).toBe('refresh-new');
});

test('re-reads credentials after another client logs in', async () => {
    let token = 'one';
    const provider = createClaudeProvider({
        readTextFile: async () => JSON.stringify({claudeAiOauth: {accessToken: token}}),
        fetch: async (_url, init) => {
            expect(init.headers.authorization).toBe(`Bearer ${token}`);
            return createJsonResponse(200, {five_hour: {utilization: 10}, seven_day: {utilization: 20}});
        },
    });
    expect((await provider.getUsage()).ok).toBe(true);
    token = 'two';
    expect((await provider.getUsage()).ok).toBe(true);
});


test('keeps refreshed credentials in memory on a read-only runtime', async () => {
    let refreshes = 0;
    const provider = createClaudeProvider({
        readTextFile: async () => JSON.stringify({claudeAiOauth: {accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1}}),
        fetch: async (url, init) => {
            if (url === claudeProviderConfig.REFRESH_ENDPOINT) {
                refreshes++;
                return createJsonResponse(200, {access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600});
            }
            expect(init.headers.authorization).toBe('Bearer new');
            return createJsonResponse(200, {five_hour: {utilization: 10}, seven_day: {utilization: 20}});
        },
    });
    expect((await provider.getUsage()).ok).toBe(true);
    expect((await provider.getUsage()).ok).toBe(true);
    expect(refreshes).toBe(1);
});

test('a rejected refresh is an auth error and does not overwrite credentials', async () => {
    const provider = createClaudeProvider({
        readTextFile: async () => JSON.stringify({claudeAiOauth: {refreshToken: 'rejected'}}),
        replaceTextFile: async () => { throw new Error('must not write'); },
        fetch: async () => createJsonResponse(400, {error: 'invalid_grant'}),
    });
    expect((await provider.getUsage()).error.code).toBe('auth_expired');
});
