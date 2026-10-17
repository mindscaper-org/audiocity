import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, now, objectBody, requiredString } from './core.ts';
import type { Authentication, AuthClient, TokenGrant } from './auth.ts';
import { digest, scopeValue, secret } from './auth.ts';
import { audacityLinkHtml, authorizationHtml, browserHandoffHtml } from './auth-ui.ts';
import { brandIcons } from './branding.ts';

interface Flow {
	hash: string; cookie_hash: string; client_id: string; redirect_uri: string;
	scope: string; state: string; challenge: string; expires: number;
}
interface Code { user_id: string; client_id: string; redirect_uri: string; scope: string; challenge: string; expires: number }
function validRedirect(value: unknown): string {
	const raw = requiredString(value, 'redirect_uri', 2048);
	let url: URL;
	try { url = new URL(raw); } catch { throw new ApiError(422, 'Invalid redirect URI.'); }
	const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
	if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
		throw new ApiError(422, 'Redirects must use HTTPS or an HTTP loopback address, without credentials or fragments.');
	}
	return raw;
}
function legacyLoopback(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
			&& url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}
function cookies(request: FastifyRequest): Record<string, string> {
	return Object.fromEntries((request.headers.cookie ?? '').split(';').map(value => {
		const [name, ...parts] = value.trim().split('=');
		return [name ?? '', parts.join('=')];
	}));
}
function challengeValue(body: Record<string, unknown>, client: AuthClient): string {
	if (body.code_challenge === undefined && client.legacy) return '';
	if (body.code_challenge_method !== 'S256' || typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) {
		throw new ApiError(422, 'An S256 PKCE challenge is required.');
	}
	return body.code_challenge;
}
function urlWithResult(flow: Flow, key: 'code' | 'error', value: string): string {
	const target = new URL(flow.redirect_uri);
	target.searchParams.set(key, value);
	if (flow.state) target.searchParams.set('state', flow.state);
	return target.href;
}

export class OAuthAuthorization {
	private readonly auth: Authentication;
	constructor(auth: Authentication) { this.auth = auth; }
	register(app: FastifyInstance): void {
		const base = this.auth.config.publicUrl;
		const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
		app.get('/.well-known/oauth-authorization-server', () => ({
			issuer: base, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`,
			registration_endpoint: `${base}/auth/client`,
			response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token', 'password'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
			code_challenge_methods_supported: ['S256'], scopes_supported: ['public', 'projects', 'all']
		}));
		app.post('/auth/client', limited, (request, reply) => this.registerClient(objectBody(request.body), reply));
		app.get('/auth/authorize', limited, (request, reply) => this.start(objectBody(request.query), reply));
		app.post('/auth/authorize', limited, async (request, reply) => this.finish(request, reply));
		app.get('/auth/check-and-redirect', limited, (request, reply) => this.browserHandoff(objectBody(request.query), reply));
		app.get('/auth/callback', (request, reply) => this.linkCallback(objectBody(request.query), reply));
	}
	private linkCallback(body: Record<string, unknown>, reply: FastifyReply) {
		reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
			.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
		if (body.code === undefined) {
			return reply.type('text/html').send(`<!doctype html><title>Audiocity</title>${brandIcons}<p>Return to your application and use Sign-in and get the token to link your account.</p>`);
		}
		const code = requiredString(body.code, 'code', 200);
		const grant = this.auth.db.get<Code>('SELECT * FROM oauth_codes WHERE hash = ? AND expires > ?', digest(code), now());
		if (!grant || grant.client_id !== this.auth.config.audacityClientId || grant.redirect_uri !== `${this.auth.config.publicUrl}/auth/callback`) {
			throw new ApiError(401, 'Linking token expired or already used. Use Sign-in and get the token again.', 'Unauthorized');
		}
		return reply.type('text/html; charset=utf-8').send(audacityLinkHtml(code));
	}
	private browserHandoff(body: Record<string, unknown>, reply: FastifyReply) {
		const token = requiredString(body.token, 'token', 200);
		const user = this.auth.userFromToken(token);
		if (body.user !== user.id) throw new ApiError(401, 'Token does not belong to the requested account.');
		const raw = requiredString(body.url, 'url', 2048);
		// Audacity 3's integer-keyed owner cache cannot store legacy UUID project IDs,
		// so it can omit the username and emit "//projects/ID" after a save.
		const missingOwner = raw.match(/^\/\/projects((?:\/(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|\d+))?(?:\?[^#]*)?)$/i);
		const destination = missingOwner ? `/${user.username}/projects${missingOwner[1]}` : raw;
		let target: URL;
		try { target = new URL(destination, this.auth.config.publicUrl); } catch { throw new ApiError(422, 'Invalid browser destination.'); }
		if (target.origin !== this.auth.config.publicUrl || target.username || target.password) throw new ApiError(422, 'Browser destination must belong to this Audiocity server.');
		const nonce = secret();
		return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
			.header('Content-Security-Policy', `default-src 'none'; img-src 'self'; script-src 'nonce-${nonce}'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'`)
			.type('text/html; charset=utf-8').send(browserHandoffHtml(token, target.href, nonce));
	}
	private registerClient(body: Record<string, unknown>, reply: FastifyReply) {
		if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 10) {
			throw new ApiError(422, 'Between 1 and 10 redirect_uris are required.');
		}
		if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
			throw new ApiError(422, 'Dynamic clients must use token_endpoint_auth_method none and PKCE.');
		}
		const redirects = [...new Set(body.redirect_uris.map(validRedirect))];
		const name = body.client_name === undefined ? 'Unnamed application' : requiredString(body.client_name, 'client_name', 100);
		const id = `client_${randomUUID()}`;
		this.auth.db.run('INSERT INTO oauth_clients VALUES (?, ?, ?)', id, name, JSON.stringify(redirects));
		return reply.code(201).header('Cache-Control', 'no-store').send({
			client_id: id, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
		});
	}
	private start(body: Record<string, unknown>, reply: FastifyReply) {
		if (body.response_type !== 'code') throw new ApiError(422, 'response_type must be code.');
		const client = this.auth.authorizationClient(requiredString(body.client_id, 'client_id', 200));
		const redirect = requiredString(body.redirect_uri, 'redirect_uri', 2048);
		if (!client.redirects.includes(redirect) && !(client.legacy && legacyLoopback(redirect))) throw new ApiError(422, 'redirect_uri does not exactly match a registered redirect.');
		const scope = scopeValue(body.scope, client.legacy ? 'all' : 'public');
		const state = body.state === undefined ? '' : requiredString(body.state, 'state', 2048);
		const challenge = challengeValue(body, client);
		const flow = secret(), cookie = secret();
		this.auth.db.run('DELETE FROM oauth_flows WHERE expires <= ?', now());
		this.auth.db.run('DELETE FROM oauth_codes WHERE expires <= ?', now());
		this.auth.db.run('INSERT INTO oauth_flows VALUES (?, ?, ?, ?, ?, ?, ?, ?)', digest(flow), digest(cookie), client.id, redirect, scope, state, challenge, now() + 600);
		// Each tab needs its own binding; a single cookie invalidates older forms.
		this.flowCookie(reply, digest(flow), cookie, 600);
		return this.html(reply, authorizationHtml(flow, client.name, scope), redirect);
	}
	private flowCookie(reply: FastifyReply, flowHash: string, value: string, maxAge: number): void {
		const secure = this.auth.config.publicUrl.startsWith('https:') ? '; Secure' : '';
		reply.header('Set-Cookie', `audiocity_oauth_${flowHash}=${value}; Path=/auth/authorize; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
	}
	private html(reply: FastifyReply, html: string, redirect: string) {
		const target = new URL(redirect);
		// Registered callbacks are validated above. Escape CSP delimiters and wildcards
		// rather than embedding a caller-controlled URL as policy syntax. Queries do
		// not form part of CSP path matching; OAuth still enforces the exact URI.
		const source = `${target.protocol}//${target.host}${target.pathname}`.replaceAll(/[^A-Za-z0-9.:/[\]_%~-]/gu,
			character => `%${character.codePointAt(0)!.toString(16).padStart(2, '0').toUpperCase()}`);
		return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
			.header('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' ${source}; frame-ancestors 'none'; base-uri 'none'`)
			.type('text/html; charset=utf-8').send(html);
	}
	private async finish(request: FastifyRequest, reply: FastifyReply) {
		const body = objectBody(request.body);
		const flowId = requiredString(body.flow, 'flow', 100);
		const flow = this.auth.db.get<Flow>('SELECT * FROM oauth_flows WHERE hash = ? AND expires > ?', digest(flowId), now());
		if (!flow || digest(cookies(request)[`audiocity_oauth_${flow.hash}`] ?? '') !== flow.cookie_hash) throw new ApiError(403, 'Authorization form expired or browser validation failed. Open the authorization link again.');
		if (body.consent === 'deny') {
			this.auth.db.run('DELETE FROM oauth_flows WHERE hash = ?', flow.hash);
			this.flowCookie(reply, flow.hash, '', 0);
			return reply.code(303).redirect(urlWithResult(flow, 'error', 'access_denied'));
		}
		if (body.consent !== 'allow') throw new ApiError(422, 'Explicit consent is required.');
		let user;
		try { user = await this.auth.authenticate(body.username, body.password); }
		catch (error) {
			if (!(error instanceof ApiError) || error.statusCode !== 401) throw error;
			const client = this.auth.authorizationClient(flow.client_id);
			return this.html(reply.code(401), authorizationHtml(flowId, client.name, flow.scope, 'Invalid email or password.'), flow.redirect_uri);
		}
		const code = secret();
		this.auth.db.transaction(() => {
			const removed = this.auth.db.run('DELETE FROM oauth_flows WHERE hash = ? AND expires > ?', flow.hash, now());
			if (Number(removed.changes) !== 1) throw new ApiError(403, 'Authorization form has already been used.');
			this.auth.db.run('INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?, ?, ?)', digest(code), user.id, flow.client_id, flow.redirect_uri, flow.scope, flow.challenge, now() + 120);
		});
		this.flowCookie(reply, flow.hash, '', 0);
		return reply.code(303).redirect(urlWithResult(flow, 'code', code));
	}
	exchange(body: Record<string, unknown>, client: AuthClient): TokenGrant {
		const raw = requiredString(body.code, 'code', 200);
		return this.auth.db.transaction(() => {
			const code = this.auth.db.get<Code>('SELECT * FROM oauth_codes WHERE hash = ? AND expires > ?', digest(raw), now());
			if (!code || code.client_id !== client.id || code.redirect_uri !== body.redirect_uri) throw new ApiError(401, 'Invalid authorization code.', 'Unauthorized');
			if (code.challenge) {
				const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
				if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || Buffer.from(digest(verifier), 'hex').toString('base64url') !== code.challenge) {
					throw new ApiError(401, 'Invalid PKCE verifier.', 'Unauthorized');
				}
			}
			this.auth.db.run('DELETE FROM oauth_codes WHERE hash = ?', digest(raw));
			return { userId: code.user_id, scope: code.scope, clientId: client.id };
		});
	}
}
