import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { Authentication, registerAuthRoutes } from '../src/auth.ts';
import { ApiError } from '../src/core.ts';
import type { Config } from '../src/core.ts';
import { Database } from '../src/database.ts';

async function fixture(overrides: Partial<Config> = {}) {
	const config: Config = { dataDir: '/tmp', publicUrl: 'http://localhost:3000', host: '127.0.0.1', port: 3000,
		registration: false, corsOrigins: [], maxUploadBytes: 1000, maxUserBytes: 10000, uploadTtlSeconds: 100,
		tokenTtlSeconds: 3600, adminEmail: 'admin@example.test', adminPassword: 'correct horse battery staple',
		audacityClientId: 'audiocity-desktop', audacityClientSecret: 'local-desktop-secret', logger: false, ...overrides };
	const db = new Database(':memory:');
	const auth = new Authentication(config, db);
	const generated = await auth.initialize();
	const app = Fastify();
	app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
		done(null, Object.fromEntries(new URLSearchParams(body as string)));
	});
	app.setErrorHandler((error, _request, reply) => {
		const status = error instanceof ApiError ? error.statusCode : 500;
		void reply.code(status).send({ message: error instanceof Error ? error.message : 'Unknown error' });
	});
	registerAuthRoutes(app, { config, auth });
	const login = (payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/auth/token', payload: {
		grant_type: 'password', username: config.adminEmail, password: config.adminPassword, ...payload
	} });
	return { config, db, auth, app, generated, login, async close() { await app.close(); db.close(); } };
}

void test('bootstrap administrator persists and passwords and tokens are hashed', async () => {
	const f = await fixture();
	try {
		const login = await f.login();
		assert.equal(login.statusCode, 200);
		const token = login.json<{ access_token: string; refresh_token: string }>();
		assert.ok(token.access_token.length >= 40);
		const user = await f.app.inject({ url: '/user/me', headers: { authorization: `Bearer ${token.access_token}` } });
		assert.equal(user.statusCode, 200);
		assert.equal(user.json<{ profile: { name: string } }>().profile.name, 'admin');
		const row = f.db.get<{ password_hash: string }>('SELECT password_hash FROM users');
		assert.ok(row?.password_hash.startsWith('scrypt:'));
		const stored = JSON.stringify(f.db.all('SELECT * FROM auth_tokens'));
		assert.ok(!stored.includes(token.access_token));
		assert.ok(!stored.includes(token.refresh_token));
		assert.equal(await f.auth.initialize(), undefined);
	} finally { await f.close(); }
});

void test('invalid credentials, missing bearer, and expired tokens are rejected', async () => {
	const f = await fixture();
	try {
		assert.equal((await f.login({ password: 'incorrect password' })).statusCode, 401);
		for (const path of ['/me', '/auth/me', '/user/me']) assert.equal((await f.app.inject(path)).statusCode, 401);
		const token = (await f.login()).json<{ access_token: string }>().access_token;
		f.db.run('UPDATE auth_tokens SET access_expires = 1');
		for (const path of ['/me', '/auth/me', '/user/me']) {
			assert.equal((await f.app.inject({ url: path, headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
		}
	} finally { await f.close(); }
});

void test('refresh rotates both tokens and logout revokes the session', async () => {
	const f = await fixture();
	try {
		const first = (await f.login()).json<{ access_token: string; refresh_token: string }>();
		const refreshed = await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token } });
		assert.equal(refreshed.statusCode, 200);
		assert.equal((await f.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${first.access_token}` } })).statusCode, 401);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token } })).statusCode, 401);
		const next = refreshed.json<{ access_token: string; refresh_token: string }>();
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${next.access_token}` } })).statusCode, 204);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: next.refresh_token } })).statusCode, 401);
	} finally { await f.close(); }
});

void test('registration is closed by default and only administrators can create users', async () => {
	const f = await fixture();
	try {
		const payload = { email: 'listener@example.test', password: 'another long password', name: 'Listener' };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/register', payload })).statusCode, 403);
		const admin = (await f.login()).json<{ access_token: string }>().access_token;
		const added = await f.app.inject({ method: 'POST', url: '/admin/users', payload, headers: { authorization: `Bearer ${admin}` } });
		assert.equal(added.statusCode, 201);
		assert.equal(added.json<{ admin: boolean }>().admin, false);
		const normal = (await f.login({ username: payload.email, password: payload.password })).json<{ access_token: string }>().access_token;
		assert.equal((await f.app.inject({ method: 'POST', url: '/admin/users', payload: { ...payload, email: 'other@example.test' }, headers: { authorization: `Bearer ${normal}` } })).statusCode, 403);
	} finally { await f.close(); }
});

void test('registration validates passwords and cannot grant administrator privileges', async () => {
	const f = await fixture({ registration: true });
	try {
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'bad', password: 'short' } })).statusCode, 422);
		const response = await f.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'new@example.test', password: 'new strong password', admin: true } });
		assert.equal(response.statusCode, 201);
		assert.equal(response.json<{ admin: boolean }>().admin, false);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'NEW@example.test', password: 'new strong password' } })).statusCode, 409);
	} finally { await f.close(); }
});

void test('Audacity password grant validates its configured local client credentials', async () => {
	const f = await fixture();
	try {
		assert.equal((await f.login({ client_id: f.config.audacityClientId, client_secret: 'wrong', scope: 'all' })).statusCode, 401);
		const response = await f.login({ client_id: f.config.audacityClientId, client_secret: f.config.audacityClientSecret, scope: 'all' });
		assert.equal(response.statusCode, 200);
		assert.equal(response.json<{ token_type: string }>().token_type, 'Bearer');
		const token = response.json<{ access_token: string }>().access_token;
		const me = await f.app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } });
		assert.equal(me.statusCode, 200);
		const user = me.json<{ id: string; username: string; avatar: string; profile: { name: string } }>();
		assert.ok(user.id && user.username);
		assert.equal(user.avatar, '');
		assert.equal(user.profile.name, 'admin');
		const handoff = await f.app.inject(`/auth/check-and-redirect?${new URLSearchParams({ token, user: user.id, url: `${f.config.publicUrl}/${user.username}/audio/uploaded-audio/edit` })}`);
		assert.equal(handoff.statusCode, 200);
	} finally { await f.close(); }
});

async function registerClient(f: Awaited<ReturnType<typeof fixture>>, redirect = 'http://127.0.0.1:3847/callback') {
	const response = await f.app.inject({ method: 'POST', url: '/auth/client', payload: { client_name: 'Soundscaper', redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
	assert.equal(response.statusCode, 201);
	return { id: response.json<{ client_id: string }>().client_id, redirect };
}

async function authorize(f: Awaited<ReturnType<typeof fixture>>, client: { id: string; redirect: string }, scope = 'projects') {
	const verifier = 'a'.repeat(64);
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect, scope, code_challenge: challenge, code_challenge_method: 'S256', state: 'safe-state' });
	const page = await f.app.inject(`/auth/authorize?${query}`);
	assert.equal(page.statusCode, 200);
	const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
	assert.ok(flow);
	const cookie = String(page.headers['set-cookie']).split(';')[0];
	const result = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } });
	assert.equal(result.statusCode, 303);
	const target = new URL(String(result.headers.location));
	assert.equal(target.searchParams.get('state'), 'safe-state');
	return { code: target.searchParams.get('code'), verifier };
}

void test('Soundscaper public clients use exact redirects and PKCE codes are one-time', async () => {
	const f = await fixture();
	try {
		const client = await registerClient(f);
		const grant = await authorize(f, client);
		const payload = { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, client_id: client.id, redirect_uri: client.redirect };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { ...payload, code_verifier: 'b'.repeat(64) } })).statusCode, 401);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { ...payload, redirect_uri: `${client.redirect}/other` } })).statusCode, 401);
		const exchange = await f.app.inject({ method: 'POST', url: '/auth/token', payload });
		assert.equal(exchange.statusCode, 200);
		assert.equal(exchange.json<{ scope: string }>().scope, 'projects');
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload })).statusCode, 401);
	} finally { await f.close(); }
});

void test('OAuth rejects unsafe redirects, absent PKCE, unsupported scope, and cross-browser consent', async () => {
	const f = await fixture();
	try {
		for (const uri of ['http://example.com/callback', 'javascript:alert(1)', 'https://user:pass@example.com/a', 'audacity://link']) {
			assert.equal((await f.app.inject({ method: 'POST', url: '/auth/client', payload: { redirect_uris: [uri] } })).statusCode, 422);
		}
		const client = await registerClient(f);
		const base = { response_type: 'code', client_id: client.id, redirect_uri: client.redirect, scope: 'all' };
		assert.equal((await f.app.inject(`/auth/authorize?${new URLSearchParams(base)}`)).statusCode, 422);
		const query = new URLSearchParams({ ...base, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
		query.set('redirect_uri', 'https://evil.example/callback');
		assert.equal((await f.app.inject(`/auth/authorize?${query}`)).statusCode, 422);
		query.set('redirect_uri', client.redirect); query.set('scope', 'admin');
		assert.equal((await f.app.inject(`/auth/authorize?${query}`)).statusCode, 422);
		query.set('scope', 'all');
		const page = await f.app.inject(`/auth/authorize?${query}`);
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/authorize', payload: { flow, username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } })).statusCode, 403);
	} finally { await f.close(); }
});

void test('OAuth forms in separate tabs retain independent browser validation', async () => {
	const f = await fixture();
	try {
		const client = await registerClient(f);
		const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect,
			code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
		const jar = new Map<string, string>();
		const forms: string[] = [];
		const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
		for (let tab = 0; tab < 2; tab++) {
			const page = await f.app.inject({ url: `/auth/authorize?${query}`, headers: { cookie: cookieHeader() } });
			assert.equal(page.statusCode, 200);
			const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
			assert.ok(flow);
			forms.push(flow);
			const cookie = String(page.headers['set-cookie']).split(';')[0]!;
			const separator = cookie.indexOf('=');
			jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
		}
		const approved = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie: cookieHeader() },
			payload: { flow: forms[0], username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } });
		assert.equal(approved.statusCode, 303);
		assert.ok(new URL(String(approved.headers.location)).searchParams.get('code'));
		assert.match(String(approved.headers['set-cookie']), /Max-Age=0/);
		const removed = String(approved.headers['set-cookie']).split('=')[0]!;
		jar.delete(removed);
		const cancelled = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie: cookieHeader() },
			payload: { flow: forms[1], consent: 'deny' } });
		assert.equal(cancelled.statusCode, 303);
		assert.equal(new URL(String(cancelled.headers.location)).searchParams.get('error'), 'access_denied');
		assert.match(String(cancelled.headers['set-cookie']), /Max-Age=0/);
	} finally { await f.close(); }
});

void test('public-scoped token cannot enter project routes and refresh is client bound', async () => {
	const f = await fixture();
	try {
		f.app.get('/project-probe', request => f.auth.requireUser(request, 'projects'));
		const client = await registerClient(f);
		const grant = await authorize(f, client, 'public');
		const exchange = await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, client_id: client.id, redirect_uri: client.redirect } });
		const token = exchange.json<{ access_token: string; refresh_token: string }>();
		assert.equal((await f.app.inject({ url: '/project-probe', headers: { authorization: `Bearer ${token.access_token}` } })).statusCode, 403);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: token.refresh_token } })).statusCode, 401);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.id } })).statusCode, 200);
	} finally { await f.close(); }
});

void test('administrator identity alone cannot bypass OAuth permission scope', async () => {
	const f = await fixture();
	try {
		const token = (await f.login({ scope: 'public' })).json<{ access_token: string }>().access_token;
		const response = await f.app.inject({ method: 'POST', url: '/admin/users', headers: { authorization: `Bearer ${token}` }, payload: { email: 'blocked@example.test', password: 'a long enough password' } });
		assert.equal(response.statusCode, 403);
	} finally { await f.close(); }
});

void test('combined scopes survive refresh without privilege expansion', async () => {
	const f = await fixture();
	try {
		const first = (await f.login({ scope: 'projects public' })).json<{ refresh_token: string }>();
		const refreshed = await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token } });
		assert.equal(refreshed.statusCode, 200);
		assert.equal(refreshed.json<{ scope: string }>().scope, 'projects public');
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: refreshed.json<{ refresh_token: string }>().refresh_token, scope: 'all' } })).statusCode, 422);
	} finally { await f.close(); }
});

void test('legacy Audacity can authorize without PKCE and codes expire', async () => {
	const f = await fixture();
	try {
		const client = { id: f.config.audacityClientId, redirect: 'audacity://link' };
		const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect, scope: 'all' });
		const page = await f.app.inject(`/auth/authorize?${query}`);
		assert.equal(page.statusCode, 200);
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		const cookie = String(page.headers['set-cookie']).split(';')[0];
		const authorized = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } });
		const code = new URL(String(authorized.headers.location)).searchParams.get('code');
		const grant = { grant_type: 'authorization_code', client_id: client.id, client_secret: f.config.audacityClientSecret, redirect_uri: client.redirect, code };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: grant })).statusCode, 200);
		const again = await authorize(f, client);
		f.db.run('UPDATE oauth_codes SET expires = 1');
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { ...grant, code: again.code } })).statusCode, 401);
	} finally { await f.close(); }
});

void test('Audacity 3 manual linking displays a one-time URI bound to its configured browser callback', async () => {
	const f = await fixture();
	try {
		const redirect = `${f.config.publicUrl}/auth/callback`;
		const page = await f.app.inject(`/auth/authorize?${new URLSearchParams({ response_type: 'code', client_id: f.config.audacityClientId, redirect_uri: redirect, scope: 'all' })}`);
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		const cookie = String(page.headers['set-cookie']).split(';')[0];
		const approved = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } });
		assert.equal(approved.statusCode, 303);
		const target = new URL(String(approved.headers.location));
		assert.equal(target.origin + target.pathname, redirect);
		const callback = await f.app.inject(target.pathname + target.search);
		assert.equal(callback.statusCode, 200);
		assert.equal(callback.headers['cache-control'], 'no-store');
		assert.equal(callback.headers['referrer-policy'], 'no-referrer');
		assert.ok(String(callback.headers['content-security-policy']).includes("default-src 'none'"));
		const token = callback.body.match(/<textarea[^>]*>([^<]+)<\/textarea>/)?.[1];
		assert.ok(token);
		const uri = new URL(token);
		assert.equal(uri.protocol, 'audacity:');
		assert.equal(uri.hostname, 'link');
		const code = uri.searchParams.get('authorization_code');
		assert.equal(code, target.searchParams.get('code'));
		assert.equal(uri.searchParams.has('code'), false, 'Audacity uses authorization_code to select OAuthRedirectURL instead of audacity://link.');
		const grant = { grant_type: 'authorization_code', client_id: f.config.audacityClientId, client_secret: f.config.audacityClientSecret, redirect_uri: redirect, code };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { ...grant, redirect_uri: 'audacity://link' } })).statusCode, 401);
		const exchange = await f.app.inject({ method: 'POST', url: '/auth/token', payload: grant });
		assert.equal(exchange.statusCode, 200);
		assert.equal((await f.app.inject({ url: '/me', headers: { authorization: `Bearer ${exchange.json<{ access_token: string }>().access_token}` } })).statusCode, 200);
		assert.equal((await f.app.inject(target.pathname + target.search)).statusCode, 401);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: grant })).statusCode, 401);
		assert.equal((await f.app.inject('/auth/callback?code=invalid')).statusCode, 401);
		const other = await authorize(f, await registerClient(f));
		assert.equal((await f.app.inject(`/auth/callback?code=${other.code ?? ''}`)).statusCode, 401);
	} finally { await f.close(); }
});

void test('generated administrator password is returned once and consent can be denied without credentials', async () => {
	const f = await fixture({ adminPassword: undefined });
	try {
		assert.ok(f.generated && f.generated.length >= 32);
		assert.equal((await f.login({ password: f.generated })).statusCode, 200);
		assert.equal(await f.auth.initialize(), undefined);
		const client = await registerClient(f);
		const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'denied' });
		const page = await f.app.inject(`/auth/authorize?${query}`);
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		const cookie = String(page.headers['set-cookie']).split(';')[0];
		const denied = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, consent: 'deny' } });
		assert.equal(denied.statusCode, 303);
		const target = new URL(String(denied.headers.location));
		assert.equal(target.searchParams.get('error'), 'access_denied');
		assert.equal(target.searchParams.get('state'), 'denied');
		assert.equal(f.db.all('SELECT * FROM oauth_codes').length, 0);
	} finally { await f.close(); }
});

void test('Audacity 4 registration returns its expected token response', async () => {
	const f = await fixture({ registration: true });
	try {
		const payload = { email: 'audacity4@example.test', password: 'new audacity password', client_id: f.config.audacityClientId, client_secret: f.config.audacityClientSecret };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/register', payload: { ...payload, client_secret: 'wrong' } })).statusCode, 401);
		assert.equal(f.db.get('SELECT id FROM users WHERE email = ?', payload.email), undefined);
		const response = await f.app.inject({ method: 'POST', url: '/auth/register', payload });
		assert.equal(response.statusCode, 200);
		assert.equal(response.json<{ scope: string }>().scope, 'all');
		const me = await f.app.inject({ url: '/user/me', headers: { authorization: `Bearer ${response.json<{ access_token: string }>().access_token}` } });
		assert.equal(me.statusCode, 200);
		assert.equal(me.json<{ email: string }>().email, payload.email);
	} finally { await f.close(); }
});

void test('Audacity 4 loopback authorization allows only its root callback and defaults to all scope', async () => {
	const f = await fixture();
	try {
		const base = { response_type: 'code', client_id: f.config.audacityClientId, authclient: 'google' };
		for (const redirect of ['http://127.0.0.1.evil.example:9876/', 'http://127.0.0.1:9876/not-root', 'http://127.0.0.1:9876/?forward=evil', 'http://user:pass@127.0.0.1:9876/']) {
			assert.equal((await f.app.inject(`/auth/authorize?${new URLSearchParams({ ...base, redirect_uri: redirect })}`)).statusCode, 422);
		}
		const redirect = 'http://127.0.0.1:39877/';
		const page = await f.app.inject(`/auth/authorize?${new URLSearchParams({ ...base, redirect_uri: redirect })}`);
		assert.equal(page.statusCode, 200);
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		const cookie = String(page.headers['set-cookie']).split(';')[0];
		const authorized = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, username: f.config.adminEmail, password: f.config.adminPassword, consent: 'allow' } });
		const code = new URL(String(authorized.headers.location)).searchParams.get('code');
		const grant = { grant_type: 'authorization_code', client_id: f.config.audacityClientId, client_secret: f.config.audacityClientSecret, redirect_uri: redirect, code };
		const response = await f.app.inject({ method: 'POST', url: '/auth/token', payload: grant });
		assert.equal(response.statusCode, 200);
		assert.equal(response.json<{ scope: string }>().scope, 'all');
	} finally { await f.close(); }
});

void test('password change checks the current password and revokes every session and pending code', async () => {
	const f = await fixture();
	try {
		const first = (await f.login()).json<{ access_token: string; refresh_token: string }>();
		const second = (await f.login()).json<{ access_token: string; refresh_token: string }>();
		const client = await registerClient(f);
		const grant = await authorize(f, client);
		const headers = { authorization: `Bearer ${first.access_token}` };
		const payload = { current_password: f.config.adminPassword, new_password: 'replacement long password' };
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/password', headers, payload: { ...payload, current_password: 'wrong' } })).statusCode, 401);
		assert.equal((await f.app.inject({ url: '/auth/me', headers })).statusCode, 200);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/password', headers, payload: { ...payload, new_password: 'short' } })).statusCode, 422);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/password', headers, payload })).statusCode, 204);
		for (const token of [first, second]) {
			assert.equal((await f.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token.access_token}` } })).statusCode, 401);
			assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'refresh_token', refresh_token: token.refresh_token } })).statusCode, 401);
		}
		assert.equal((await f.login()).statusCode, 401);
		assert.equal((await f.login({ password: payload.new_password })).statusCode, 200);
		assert.equal((await f.app.inject({ method: 'POST', url: '/auth/token', payload: { grant_type: 'authorization_code', client_id: client.id, code: grant.code, code_verifier: grant.verifier, redirect_uri: client.redirect } })).statusCode, 401);
	} finally { await f.close(); }
});

void test('offline password recovery validates the account and password before revocation', async () => {
	const f = await fixture();
	try {
		await f.login();
		await assert.rejects(f.auth.resetPassword('missing@example.test', 'new valid password'), { statusCode: 404 });
		await assert.rejects(f.auth.resetPassword(f.config.adminEmail, 'short'), { statusCode: 422 });
		assert.equal(f.db.all('SELECT * FROM auth_tokens').length, 1);
		const user = await f.auth.resetPassword(f.config.adminEmail.toUpperCase(), 'offline replacement password');
		assert.equal(user.email, f.config.adminEmail);
		assert.equal(f.db.all('SELECT * FROM auth_tokens').length, 0);
		assert.equal((await f.login({ password: 'offline replacement password' })).statusCode, 200);
	} finally { await f.close(); }
});

void test('Audacity browser handoff validates token ownership and only redirects within this server', async () => {
	const f = await fixture();
	try {
		const token = (await f.login()).json<{ access_token: string }>().access_token;
		const user = f.db.get<{ id: string; username: string }>('SELECT id, username FROM users');
		assert.ok(user);
		const path = `/${user.username}/audio/uploaded-recording/edit?mtm_campaign=Audacity&mtm_source=Audacity-3.7.9&mtm_content=Share_Audio_Menu`;
		const params = new URLSearchParams({ token, user: user.id, url: path });
		const handoff = await f.app.inject(`/auth/check-and-redirect?${params}`);
		assert.equal(handoff.statusCode, 200);
		assert.equal(handoff.headers['cache-control'], 'no-store');
		assert.equal(handoff.headers['referrer-policy'], 'no-referrer');
		assert.match(String(handoff.headers['content-security-policy']), /script-src 'nonce-/);
		assert.match(handoff.body, /sessionStorage\.setItem\("audiocity\.access-token"/);
		assert.match(handoff.body, /history\.replaceState/);
		const script = handoff.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
		assert.ok(script);
		let destination: string | undefined;
		const stored: unknown[][] = [];
		runInNewContext(script, {
			history: { replaceState() {} },
			sessionStorage: { setItem: (...values: unknown[]) => { stored.push(values); } },
			location: { replace: (url: string) => { destination = url; } }
		});
		assert.deepEqual(stored, [['audiocity.access-token', token]]);
		assert.equal(destination, `${f.config.publicUrl}${path}`);
		for (const url of ['https://evil.example/', '//evil.example/path', String.raw`\\evil.example\path`, String.raw`/\evil.example/path`, 'http://localhost:3000@evil.example/', 'http://user:pass@localhost:3000/', 'javascript:alert(1)', 'http://[invalid', '//projects.evil.example/123', '//projects:8080/123', '//projects@evil.example/123', String.raw`//projects\@evil.example/123`, '//projects/123/../../evil', '//projects/unrecognized/path', 'http://projects/123']) {
			params.set('url', url);
			assert.equal((await f.app.inject(`/auth/check-and-redirect?${params}`)).statusCode, 422, url);
		}
		params.set('url', `${f.config.publicUrl}/`); params.set('user', 'other-user');
		assert.equal((await f.app.inject(`/auth/check-and-redirect?${params}`)).statusCode, 401);
		params.set('user', user.id); params.set('token', 'invalid');
		assert.equal((await f.app.inject(`/auth/check-and-redirect?${params}`)).statusCode, 401);
	} finally { await f.close(); }
});

void test('Audacity project links restore a missing cached owner without treating projects as an external host', async () => {
	const f = await fixture();
	try {
		const token = (await f.login()).json<{ access_token: string }>().access_token;
		const user = f.auth.userFromToken(token);
		for (const suffix of ['', '?mtm_campaign=Audacity', '/12345678-1234-4234-8234-123456789abc?mtm_campaign=Audacity&mtm_source=Audacity-3.7.9', '/123?mtm_campaign=Audacity']) {
			const params = new URLSearchParams({ token, user: user.id, url: `//projects${suffix}` });
			const handoff = await f.app.inject(`/auth/check-and-redirect?${params}`);
			assert.equal(handoff.statusCode, 200, suffix);
			const script = handoff.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
			assert.ok(script);
			let destination: string | undefined;
			runInNewContext(script, {
				history: { replaceState() {} },
				sessionStorage: { setItem() {} },
				location: { replace: (url: string) => { destination = url; } }
			});
			assert.equal(destination, `${f.config.publicUrl}/${user.username}/projects${suffix}`);
		}
	} finally { await f.close(); }
});

void test('OAuth form CSP admits only the validated callback source and preserves it after invalid credentials', async () => {
	const f = await fixture();
	try {
		const client = await registerClient(f, 'http://127.0.0.1:4325/api/audiocom/oauth/callback?panel=audio');
		const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect, scope: 'public projects', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
		const page = await f.app.inject(`/auth/authorize?${query}`);
		const expected = "form-action 'self' http://127.0.0.1:4325/api/audiocom/oauth/callback;";
		assert.ok(String(page.headers['content-security-policy']).includes(expected));
		assert.ok(!String(page.headers['content-security-policy']).includes('?panel'));
		const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
		const cookie = String(page.headers['set-cookie']).split(';')[0];
		const rejected = await f.app.inject({ method: 'POST', url: '/auth/authorize', headers: { cookie }, payload: { flow, username: f.config.adminEmail, password: 'incorrect-password', consent: 'allow' } });
		assert.equal(rejected.statusCode, 401);
		assert.ok(String(rejected.headers['content-security-policy']).includes(expected));
	} finally { await f.close(); }
});

void test('OAuth form CSP cannot acquire directives or wildcard hosts from a registered callback URI', async () => {
	const f = await fixture();
	try {
		for (const redirect of ['https://editor.example/callback;script-src%20*', 'https://*.example/callback', 'https://editor;script-src.test/callback']) {
			const client = await registerClient(f, redirect);
			const query = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirect, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
			const page = await f.app.inject(`/auth/authorize?${query}`);
			assert.equal(page.statusCode, 200);
			const policy = String(page.headers['content-security-policy']);
			assert.ok(!policy.includes('*'));
			assert.equal(policy.split(';').length, 6);
			assert.ok(policy.includes("img-src 'self';"));
			assert.ok(!policy.includes(';script-src'));
		}
		const legacy = await f.app.inject(`/auth/authorize?${new URLSearchParams({ response_type: 'code', client_id: f.config.audacityClientId, redirect_uri: 'audacity://link', scope: 'all' })}`);
		assert.ok(String(legacy.headers['content-security-policy']).includes("form-action 'self' audacity://link;"));
	} finally { await f.close(); }
});
