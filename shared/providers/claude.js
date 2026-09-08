import {normalizeClaudeUsage} from '../core/normalize.js';

const CREDENTIALS_PATH = '~/.claude/.credentials.json';
const REFRESH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function defaultReadTextFile() {
    throw new Error('readTextFile dependency is required in this runtime');
}

function resolveCredentialsPath(homeDir) {
    if (homeDir && CREDENTIALS_PATH.startsWith('~/'))
        return `${homeDir}${CREDENTIALS_PATH.slice(1)}`;

    return CREDENTIALS_PATH;
}

function resolveAccessToken(credentials) {
    return credentials?.accessToken
        ?? credentials?.access_token
        ?? credentials?.token
        ?? null;
}

function resolveRefreshToken(credentials) {
    return credentials?.refreshToken
        ?? credentials?.refresh_token
        ?? null;
}

function resolveExpiry(credentials) {
    return credentials?.expiresAt
        ?? credentials?.expires_at
        ?? credentials?.expiry
        ?? null;
}

function isTokenExpired(credentials) {
    const expiry = resolveExpiry(credentials);

    if (expiry === null || expiry === undefined)
        return false;

    if (typeof expiry === 'number') {
        const millis = expiry > 1e12 ? expiry : expiry * 1000;
        return Date.now() >= millis;
    }

    const parsed = Date.parse(expiry);
    if (Number.isNaN(parsed))
        return false;

    return Date.now() >= parsed;
}

function ok(data) {
    return {ok: true, data};
}

function fail(code, message, data = null) {
    const result = {
        ok: false,
        error: {
            code,
            message,
        },
    };

    if (data)
        result.data = data;

    return result;
}

function mapHttpStatusToErrorCode(status) {
    if (status === 401 || status === 403)
        return 'auth_expired';

    if (status === 404)
        return 'schema_changed';

    if (status === 429)
        return 'rate_limited';

    if (status >= 500 && status < 600)
        return 'network_error';

    return 'network_error';
}

async function parseUsageResponse(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function fetchUsage(fetchImpl, accessToken) {
    const response = await fetchImpl(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
            'authorization': `Bearer ${accessToken}`,
            'anthropic-beta': OAUTH_BETA_HEADER,
        },
    });

    if (!response.ok)
        return fail(mapHttpStatusToErrorCode(response.status), `Usage request failed with status ${response.status}`);

    const json = await parseUsageResponse(response);
    if (!json)
        return fail('schema_changed', 'Usage endpoint returned invalid JSON');

    return ok(json);
}

async function refreshAccessToken(fetchImpl, refreshToken, scopes) {
    if (!refreshToken)
        return fail('auth_expired', 'OAuth refresh token is missing');

    const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        ...(Array.isArray(scopes) && scopes.length ? {scope: scopes.join(' ')} : {}),
    });

    const response = await fetchImpl(REFRESH_ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body,
    });

    if (!response.ok)
        return fail(response.status === 400 ? 'auth_expired' : mapHttpStatusToErrorCode(response.status), `Refresh request failed with status ${response.status}`);

    let payload;
    try {
        payload = await response.json();
    } catch {
        return fail('schema_changed', 'Refresh endpoint returned invalid JSON');
    }

    const accessToken = resolveAccessToken(payload);
    if (!accessToken)
        return fail('auth_expired', 'Refresh response did not include an access token');

    return ok({
        accessToken,
        refreshToken: resolveRefreshToken(payload) ?? refreshToken,
        ...(Number.isFinite(payload.refresh_token_expires_in)
            ? {refreshTokenExpiresAt: Date.now() + payload.refresh_token_expires_in * 1000} : {}),
        expiresAt: resolveExpiry(payload) ?? (Number.isFinite(payload.expires_in)
            ? Date.now() + payload.expires_in * 1000 : null),
    });
}

export function createClaudeProvider(options = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const readTextFile = options.readTextFile ?? defaultReadTextFile;
    const homeDir = options.homeDir ?? globalThis.process?.env?.HOME ?? null;
    const credentialsPath = resolveCredentialsPath(homeDir);

    // Keep rotated credentials between polls, including on read-only runtimes.
    // A changed file always wins, so a CLI login/account switch is respected.
    let cached = null;

    async function saveCached() {
        if (!cached?.pending || typeof options.replaceTextFile !== 'function')
            return;
        await options.replaceTextFile(credentialsPath, cached.source, cached.updated);
        cached.source = cached.updated;
        cached.pending = false;
    }

    return {
        async getUsage() {
            if (typeof fetchImpl !== 'function')
                return fail('network_error', 'Fetch implementation is unavailable');

            let rawCredentials;
            try {
                rawCredentials = await readTextFile(credentialsPath);
            } catch {
                return fail('missing_creds', `Missing credentials at ${credentialsPath}`);
            }

            if (!rawCredentials)
                return fail('missing_creds', `Missing credentials at ${credentialsPath}`);

            let parsedCredentials;
            try {
                parsedCredentials = JSON.parse(rawCredentials);
            } catch {
                return fail('parse_error', 'Unable to parse Claude credentials JSON');
            }

            if (cached && cached.source !== rawCredentials)
                cached = null;
            const oauthCredentials = cached?.oauth ?? parsedCredentials?.claudeAiOauth;
            if (!oauthCredentials)
                return fail('missing_creds', 'Missing claudeAiOauth in credentials JSON');

            let accessToken = resolveAccessToken(oauthCredentials);
            let refreshToken = resolveRefreshToken(oauthCredentials);
            let didRefresh = false;
            const refresh = async () => {
                const refreshed = await refreshAccessToken(fetchImpl, refreshToken, oauthCredentials.scopes);
                if (!refreshed.ok)
                    return refreshed;
                didRefresh = true;
                accessToken = refreshed.data.accessToken;
                refreshToken = refreshed.data.refreshToken;
                const oauth = {...oauthCredentials, ...refreshed.data};
                // Keep aliases consistent for clients using snake_case credentials.
                if ('access_token' in oauth) oauth.access_token = accessToken;
                if ('refresh_token' in oauth) oauth.refresh_token = refreshToken;
                if ('expires_at' in oauth) oauth.expires_at = oauth.expiresAt;
                if ('expiry' in oauth) oauth.expiry = oauth.expiresAt;
                if ('token' in oauth) oauth.token = accessToken;
                cached = {
                    source: rawCredentials,
                    oauth,
                    updated: JSON.stringify({...parsedCredentials, claudeAiOauth: oauth}),
                    pending: true,
                };
                await saveCached();
                return refreshed;
            };

            try {
                await saveCached();
                // A pending save can have changed the on-disk snapshot before
                // another refresh (for example, a subsequent usage 401).
                if (cached && !cached.pending) {
                    rawCredentials = cached.source;
                    parsedCredentials = JSON.parse(rawCredentials);
                }
                if (!accessToken || isTokenExpired(oauthCredentials)) {
                    const refreshed = await refresh();
                    if (!refreshed.ok)
                        return refreshed;

                    accessToken = refreshed.data.accessToken;
                }

                let usageResponse = await fetchUsage(fetchImpl, accessToken);
                if (!didRefresh && !usageResponse.ok && usageResponse.error.code === 'auth_expired') {
                    const refreshed = await refresh();
                    if (!refreshed.ok)
                        return refreshed;

                    usageResponse = await fetchUsage(fetchImpl, refreshed.data.accessToken);
                }

                if (!usageResponse.ok)
                    return usageResponse;

                const normalized = normalizeClaudeUsage(usageResponse.data);
                if (!normalized.hasSessionUsage && !normalized.hasWeeklyUsage)
                    return fail('schema_changed', 'Usage payload is missing expected utilization fields');

                if (!normalized.hasSessionUsage || !normalized.hasWeeklyUsage)
                    return fail('partial_data', 'Usage payload is missing one utilization field', normalized.data);

                return ok(normalized.data);
            } catch {
                return fail('network_error', 'Network request failed while calling Claude APIs');
            }
        },
    };
}

export const claudeProviderConfig = {
    CREDENTIALS_PATH,
    REFRESH_ENDPOINT,
    USAGE_ENDPOINT,
    OAUTH_BETA_HEADER,
    CLAUDE_CLIENT_ID,
};
