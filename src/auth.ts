import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, now, objectBody, requiredString } from './core.ts';
import type { AuthService, Config, Context, User } from './core.ts';
import type { Database } from './database.ts';
import { OAuthAuthorization } from './auth-oauth.ts';

interface UserRow extends User { password_hash: string }
interface TokenRow { id: string; user_id: string; scope: string; client_id: string; refresh_expires: number }
export interface AuthClient { id: string; name: string; redirects: string[]; legacy: boolean }
export interface TokenGrant { userId: string; scope: string; clientId: string }

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function secret(): string { return randomBytes(32).toString('base64url'); }
export function scopeValue(value: unknown, fallback = 'public'): string {
	if (value !== undefined && typeof value !== 'string') throw new ApiError(422, 'OAuth scope must be a string.');
	const scopes = typeof value === 'string' && value.trim() ? value.trim().split(/\s+/) : fallback.split(/\s+/);
	if (scopes.some(scope => !['public', 'projects', 'all'].includes(scope))) throw new ApiError(422, 'Unsupported OAuth scope.');
	return [...new Set(scopes)].sort().join(' ');
}
function passwordKey(password: string, salt: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
			if (error) reject(error); else resolve(key);
		});
	});
}
async function hashPassword(password: string): Promise<string> {
	const salt = secret();
	return `scrypt:${salt}:${(await passwordKey(password, salt)).toString('hex')}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [, salt, expected] = stored.split(':');
	const computed = await passwordKey(password, salt ?? 'audiocity-invalid-account');
	const expectedKey = Buffer.from(expected ?? '0'.repeat(128), 'hex');
	return expectedKey.length === computed.length && timingSafeEqual(expectedKey, computed);
}
function safeEqual(first: string, second: string): boolean {
	return timingSafeEqual(Buffer.from(digest(first)), Buffer.from(digest(second)));
}
function publicUser(row: UserRow): User {
	return { id: row.id, email: row.email, username: row.username, name: row.name, admin: Boolean(row.admin) };
}
function passwordValue(value: unknown): string {
	if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
		throw new ApiError(422, 'Password must contain between 12 and 256 characters.');
	}
	return value;
}

export class Authentication implements AuthService {
	readonly config: Config;
	readonly db: Database;
	constructor(config: Config, db: Database) { this.config = config; this.db = db; }
	async initialize(): Promise<string | undefined> {
		this.db.exec(`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
			admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS auth_tokens (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE,
			scope TEXT NOT NULL, client_id TEXT NOT NULL, access_expires INTEGER NOT NULL,
			refresh_expires INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS oauth_clients (
			id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS oauth_codes (
			hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
			redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS oauth_flows (
			hash TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, client_id TEXT NOT NULL,
			redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL,
			challenge TEXT NOT NULL, expires INTEGER NOT NULL);`);
		if (this.db.get('SELECT id FROM users WHERE admin = 1 LIMIT 1')) return undefined;
		const generated = this.config.adminPassword ? undefined : secret();
		await this.createUser({ email: this.config.adminEmail, password: this.config.adminPassword ?? generated }, true);
		return generated;
	}
	async createUser(body: Record<string, unknown>, admin = false): Promise<User> {
		const email = requiredString(body.email, 'email', 254).toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'A valid email address is required.');
		const password = passwordValue(body.password);
		if (this.db.get('SELECT id FROM users WHERE email = ?', email)) throw new ApiError(409, 'An account with that email already exists.');
		const id = randomUUID();
		const localName = email.split('@')[0] ?? 'user';
		const username = `${localName.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40)}-${id.slice(0, 8)}`;
		const name = typeof body.name === 'string' && body.name.trim() ? requiredString(body.name, 'name', 100) : localName;
		const passwordHash = await hashPassword(password);
		// Hashing yields to concurrent registrations; check again before the unique insert.
		if (this.db.get('SELECT id FROM users WHERE email = ?', email)) throw new ApiError(409, 'An account with that email already exists.');
		this.db.run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, username, name, passwordHash, Number(admin), now());
		return { id, email, username, name, admin };
	}
	async resetPassword(email: string, password: string, expectedHash?: string): Promise<User> {
		const row = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email.toLowerCase().trim());
		if (!row) throw new ApiError(404, 'Account was not found.');
		const passwordHash = await hashPassword(passwordValue(password));
		this.db.transaction(() => {
			const current = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.id);
			if (!current || (expectedHash !== undefined && current.password_hash !== expectedHash)) {
				throw new ApiError(401, 'Credentials changed; sign in again.');
			}
			this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, row.id);
			this.db.run('DELETE FROM auth_tokens WHERE user_id = ?', row.id);
			this.db.run('DELETE FROM oauth_codes WHERE user_id = ?', row.id);
			// Forms have no account binding until sign-in; expire them conservatively.
			this.db.run('DELETE FROM oauth_flows');
		});
		return publicUser(row);
	}
	async changePassword(request: FastifyRequest, body: Record<string, unknown>): Promise<void> {
		const user = this.requireUser(request);
		const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id);
		await this.authenticate(user.email, body.current_password);
		await this.resetPassword(user.email, passwordValue(body.new_password), row?.password_hash);
	}
	findUser(id: string): User | undefined {
		const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
		return row ? publicUser(row) : undefined;
	}
	requireUser(request: FastifyRequest, scope?: 'audio' | 'projects'): User {
		return this.userFromToken(request.headers.authorization?.match(/^Bearer ([\w-]+)$/i)?.[1], scope);
	}
	userFromToken(token: string | undefined, scope?: 'audio' | 'projects'): User {
		const row = token ? this.db.get<TokenRow>('SELECT * FROM auth_tokens WHERE access_hash = ? AND access_expires > ?', digest(token), now()) : undefined;
		if (!row) throw new ApiError(401, 'A valid bearer token is required.', 'Unauthorized');
		const scopes = row.scope.split(' ');
		if (scope === 'projects' && scopes.includes('public') && !scopes.includes('projects')) {
			throw new ApiError(403, 'This token is limited to the public API.', 'Forbidden');
		}
		if (scope === 'projects' && !scopes.includes('all') && !scopes.includes('projects')) {
			throw new ApiError(403, 'This token does not grant project access.', 'Forbidden');
		}
		if (scope === 'audio' && !scopes.includes('all') && !scopes.includes('public')) {
			throw new ApiError(403, 'This token does not grant audio access.', 'Forbidden');
		}
		const user = this.findUser(row.user_id);
		if (!user) throw new ApiError(401, 'Account is unavailable.');
		return user;
	}
	async authenticate(username: unknown, password: unknown): Promise<User> {
		const identifier = typeof username === 'string' ? username.toLowerCase().trim().slice(0, 254) : '';
		const row = this.db.get<UserRow>('SELECT * FROM users WHERE email = ? OR username = ?', identifier, identifier);
		const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
		const valid = await verifyPassword(candidate, row?.password_hash ?? '');
		const current = row ? this.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', row.id) : undefined;
		if (!valid || !row || current?.password_hash !== row.password_hash) throw new ApiError(401, 'Invalid email or password.', 'Unauthorized');
		return publicUser(row);
	}
	client(body: Record<string, unknown>, firstParty = false): AuthClient {
		if (body.client_id === undefined && firstParty) return { id: 'audiocity-web', name: 'Audiocity console', redirects: [], legacy: false };
		const id = requiredString(body.client_id, 'client_id', 200);
		if (id === this.config.audacityClientId) {
			if (typeof body.client_secret !== 'string' || !safeEqual(body.client_secret, this.config.audacityClientSecret)) {
				throw new ApiError(401, 'Invalid client credentials.', 'Unauthorized');
			}
			return this.authorizationClient(id);
		}
		return this.authorizationClient(id);
	}
	authorizationClient(id: string): AuthClient {
		if (id === this.config.audacityClientId) return { id, name: 'Audacity', redirects: ['audacity://link', `${this.config.publicUrl}/auth/callback`], legacy: true };
		const row = this.db.get<{ id: string; name: string; redirect_uris: string }>('SELECT * FROM oauth_clients WHERE id = ?', id);
		if (!row) throw new ApiError(401, 'Unknown OAuth client.', 'Unauthorized');
		return { id: row.id, name: row.name, redirects: JSON.parse(row.redirect_uris) as string[], legacy: false };
	}
	issueTokens(grant: TokenGrant) {
		const accessToken = secret(), refreshToken = secret();
		this.db.run('DELETE FROM auth_tokens WHERE refresh_expires <= ?', now());
		this.db.run('INSERT INTO auth_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), grant.userId,
			digest(accessToken), digest(refreshToken), grant.scope, grant.clientId, now() + this.config.tokenTtlSeconds, now() + 30 * 86400);
		return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: this.config.tokenTtlSeconds, scope: grant.scope };
	}
	async token(body: Record<string, unknown>, oauth: OAuthAuthorization) {
		const client = this.client(body, true);
		if (body.grant_type === 'password') {
			if (client.id !== 'audiocity-web' && !client.legacy) throw new ApiError(400, 'Public clients must use authorization code with PKCE.');
			const user = await this.authenticate(body.username, body.password);
			return this.issueTokens({ userId: user.id, scope: scopeValue(body.scope, 'all'), clientId: client.id });
		}
		if (body.grant_type === 'authorization_code') return this.issueTokens(oauth.exchange(body, client));
		if (body.grant_type === 'refresh_token') {
			const refresh = requiredString(body.refresh_token, 'refresh_token', 200);
			return this.db.transaction(() => {
				const row = this.db.get<TokenRow>('SELECT * FROM auth_tokens WHERE refresh_hash = ? AND refresh_expires > ?', digest(refresh), now());
				if (!row || row.client_id !== client.id) {
					// Audacity clears a rejected stored refresh token only after HTTP 422.
					throw new ApiError(client.legacy ? 422 : 401, 'Invalid refresh token.', client.legacy ? 'ValidationError' : 'Unauthorized');
				}
				const scope = scopeValue(body.scope, row.scope);
				if (row.scope !== 'all' && scope.split(' ').some(item => !row.scope.split(' ').includes(item))) throw new ApiError(422, 'Refresh cannot expand scope.');
				this.db.run('DELETE FROM auth_tokens WHERE id = ?', row.id);
				return this.issueTokens({ userId: row.user_id, scope, clientId: client.id });
			});
		}
		throw new ApiError(400, 'Unsupported grant_type.');
	}
	requireAdmin(request: FastifyRequest): void {
		const user = this.requireUser(request);
		const token = request.headers.authorization?.slice(7) ?? '';
		const row = this.db.get<{ scope: string }>('SELECT scope FROM auth_tokens WHERE access_hash = ?', digest(token));
		if (!user.admin || row?.scope !== 'all') throw new ApiError(403, 'Administrator access with all scope is required.');
	}
	logout(request: FastifyRequest): void {
		this.requireUser(request);
		const token = request.headers.authorization?.slice(7) ?? '';
		this.db.run('DELETE FROM auth_tokens WHERE access_hash = ?', digest(token));
	}
}

export function registerAuthRoutes(app: FastifyInstance, context: Pick<Context, 'auth' | 'config'>): void {
	const auth = context.auth as Authentication;
	const oauth = new OAuthAuthorization(auth);
	const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
	app.post('/auth/token', limited, async (request, reply) => {
		reply.header('Cache-Control', 'no-store');
		return auth.token(objectBody(request.body), oauth);
	});
	app.post('/auth/register', limited, async (request, reply) => {
		if (!context.config.registration) throw new ApiError(403, 'Public registration is disabled.');
		const body = objectBody(request.body);
		const client = body.client_id === undefined ? undefined : auth.client(body);
		if (client && !client.legacy) throw new ApiError(400, 'Register through this server before authorizing a public client.');
		const user = await auth.createUser(body);
		if (client) return auth.issueTokens({ userId: user.id, scope: 'all', clientId: client.id });
		return reply.code(201).send(user);
	});
	app.post('/admin/users', async (request, reply) => {
		auth.requireAdmin(request);
		return reply.code(201).send(await auth.createUser(objectBody(request.body)));
	});
	for (const path of ['/me', '/auth/me', '/user/me']) {
		app.get(path, (request, reply) => {
			reply.header('Cache-Control', 'no-store');
			const user = auth.requireUser(request);
			return { ...user, avatar: '', profile: { name: user.name } };
		});
	}
	app.post('/auth/password', limited, async (request, reply) => {
		await auth.changePassword(request, objectBody(request.body));
		return reply.code(204).send();
	});
	app.post('/auth/logout', (request, reply) => { auth.logout(request); return reply.code(204).send(); });
	oauth.register(app);
}
