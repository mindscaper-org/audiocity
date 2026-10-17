import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, now } from './core.ts';
import type { BlobInfo, BlobService, Config, UploadDescriptor, UploadOptions } from './core.ts';
import type { Database } from './database.ts';

interface Transfer extends BlobInfo {
	capability_hash: string;
	expires: number;
	max_bytes: number;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equal(left: string, right: string): boolean {
	const a = Buffer.from(left); const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export class BlobStorage implements BlobService {
	private readonly db: Database;
	private readonly config: Config;
	private key = Buffer.alloc(0);
	private readonly validators = new Map<string, UploadOptions['validate']>();
	private readonly kindValidators = new Map<string, (blob: BlobInfo, path: string) => void | Promise<void>>();
	private readonly inflight = new Map<string, { owner: string; bytes: number }>();
	constructor(db: Database, config: Config) { this.db = db; this.config = config; }
	async initialize(): Promise<void> {
		const directory = join(this.config.dataDir, 'blobs');
		await mkdir(directory, { recursive: true, mode: 0o700 });
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && /^[a-f0-9-]{36}\.[a-f0-9-]{36}\.part$/i.test(entry.name)) await rm(join(directory, entry.name), { force: true });
		}
		const keyPath = join(this.config.dataDir, 'signing.key');
		try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
		this.key = Buffer.from(await readFile(keyPath));
		if (this.key.length !== 32) throw new Error('Invalid signing key. Restore signing.key from backup.');
		this.db.exec(`CREATE TABLE IF NOT EXISTS blobs (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending', size INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL,
			sha256 TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, expected_size INTEGER,
			capability_hash TEXT NOT NULL, expires INTEGER NOT NULL, max_bytes INTEGER NOT NULL
		); CREATE INDEX IF NOT EXISTS blobs_owner ON blobs(owner_id, state);`);
		this.db.transaction(() => {
			for (const blob of this.db.all<{ id: string; path: string }>('SELECT id,path FROM blobs')) {
				if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(blob.id)) throw new Error('Invalid blob ID in the data volume.');
				const path = join(directory, blob.id);
				if (blob.path !== path) this.db.run('UPDATE blobs SET path=? WHERE id=?', path, blob.id);
			}
		});
		this.db.run("UPDATE blobs SET state='failed' WHERE state='pending' AND expires<?", now());
	}
	create(ownerId: string, options: UploadOptions): UploadDescriptor {
		const maximum = Math.min(options.maxBytes ?? this.config.maxUploadBytes, this.config.maxUploadBytes);
		if (!Number.isSafeInteger(maximum) || maximum < 1) throw new ApiError(422, 'Invalid upload limit.');
		if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize)
			|| options.expectedSize < 1 || options.expectedSize > maximum)) throw new ApiError(413, 'Invalid or excessive upload size.');
		if (this.usage(ownerId) + (options.expectedSize ?? 0) > this.config.maxUserBytes) throw new ApiError(413, 'Storage quota exceeded.');
		const mime = options.mime ?? 'application/octet-stream';
		if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) throw new ApiError(422, 'Invalid MIME type.');
		const id = randomUUID(); const token = randomBytes(32).toString('base64url'); const expires = now() + this.config.uploadTtlSeconds;
		this.db.run(`INSERT INTO blobs (id,owner_id,kind,resource_id,mime,path,expected_size,capability_hash,expires,max_bytes)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, id, ownerId, options.kind, options.resourceId, mime,
			join(this.config.dataDir, 'blobs', id), options.expectedSize ?? null, digest(token), expires, maximum);
		if (options.validate) this.validators.set(id, options.validate);
		return this.descriptor(id, token, expires);
	}
	private descriptor(id: string, token: string, expires: number): UploadDescriptor {
		const issued = new Date((expires - this.config.uploadTtlSeconds) * 1000).toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
		const base = `${this.config.publicUrl}/uploads/${id}`;
		// Audacity's resumed uploader reads these expiry hints before renewing URLs.
		const query = `?${new URLSearchParams({ token, 'X-Amz-Date': issued, 'X-Amz-Expires': String(this.config.uploadTtlSeconds) })}`;
		return { id, url: base + query, success: `${base}/success${query}`, fail: `${base}/fail${query}`, progress: `${base}/progress${query}` };
	}
	renew(id: string): UploadDescriptor {
		const blob = this.get(id);
		if (!blob || blob.state === 'failed') throw new ApiError(409, 'Upload cannot be renewed.');
		if (blob.state === 'pending' && blob.expires < now() && this.usage(blob.owner_id) + (this.inflight.has(id) ? 0 : blob.expected_size ?? 0) > this.config.maxUserBytes) {
			throw new ApiError(413, 'Storage quota exceeded.');
		}
		const token = randomBytes(32).toString('base64url'); const expires = now() + this.config.uploadTtlSeconds;
		this.db.run('UPDATE blobs SET capability_hash=?,expires=? WHERE id=?', digest(token), expires, id);
		return this.descriptor(id, token, expires);
	}
	get(id: string): BlobInfo | undefined { return this.db.get<Transfer>('SELECT * FROM blobs WHERE id=?', id); }
	setValidator(kind: string, validate: (blob: BlobInfo, path: string) => void | Promise<void>): void {
		this.kindValidators.set(kind, validate);
	}
	ready(id: string): BlobInfo | undefined { const blob = this.get(id); return blob?.state === 'ready' ? blob : undefined; }
	private usage(owner: string): number {
		const date = now();
		let reserved = this.db.get<{ bytes: number }>(`SELECT COALESCE(SUM(CASE WHEN state='pending' THEN COALESCE(expected_size,0) ELSE size END),0) bytes
			FROM blobs WHERE owner_id=? AND (state IN ('ready','uploaded') OR (state='pending' AND expires>=?))`, owner, date)?.bytes ?? 0;
		for (const [id, transfer] of this.inflight) {
			if (transfer.owner !== owner) continue;
			const blob = this.get(id);
			if (blob?.state !== 'pending') continue;
			const expected = blob.expected_size ?? 0;
			// Active transfers keep their reservation even if the URL expires midstream.
			reserved += Math.max(expected, transfer.bytes) - (blob.expires >= date ? expected : 0);
		}
		return reserved;
	}
	private capability(request: FastifyRequest): Transfer {
		const { id } = request.params as { id: string };
		const { token } = request.query as { token?: string };
		const blob = this.db.get<Transfer>('SELECT * FROM blobs WHERE id=?', id);
		if (!blob || typeof token !== 'string' || !equal(blob.capability_hash, digest(token)) || blob.expires < now()) {
			throw new ApiError(403, 'Invalid or expired upload capability.');
		}
		return blob;
	}
	async receive(request: FastifyRequest): Promise<{ id: string; size: number }> {
		const blob = this.capability(request);
		if (blob.state === 'failed') throw new ApiError(409, 'Upload was cancelled. Create a new upload.');
		if (this.inflight.has(blob.id)) throw new ApiError(409, 'Upload is already in progress.');
		const declared = request.headers['content-length'];
		const immutable = blob.state !== 'pending'; const maximum = immutable ? blob.size : blob.max_bytes;
		if (declared !== undefined && Number(declared) > maximum) throw new ApiError(immutable ? 409 : 413, immutable ? 'Uploaded content is immutable.' : 'Upload exceeds maximum size.');
		const temp = `${blob.path}.${randomUUID()}.part`;
		const hash = createHash('sha256'); let bytes = 0;
		this.inflight.set(blob.id, { owner: blob.owner_id, bytes: 0 });
		const meter = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				bytes += chunk.length;
				if (bytes > maximum) { callback(new ApiError(immutable ? 409 : 413, immutable ? 'Uploaded content is immutable.' : 'Upload exceeds maximum size.')); return; }
				if (blob.state === 'pending') {
					this.inflight.set(blob.id, { owner: blob.owner_id, bytes });
					if (this.usage(blob.owner_id) > this.config.maxUserBytes) { callback(new ApiError(413, 'Storage quota exceeded.')); return; }
				}
				hash.update(chunk); callback(null, chunk);
			},
		});
		try {
			await pipeline(request.body as Readable, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
			if (!bytes || (blob.expected_size !== null && bytes !== blob.expected_size)) throw new ApiError(422, 'Uploaded size does not match the declared size.');
			const sha256 = hash.digest('hex');
			if (blob.state !== 'pending') {
				if (sha256 !== blob.sha256) throw new ApiError(409, 'Uploaded content is immutable.');
				return { id: blob.id, size: bytes };
			}
			await this.kindValidators.get(blob.kind)?.(blob, temp);
			await this.validators.get(blob.id)?.(temp);
			// Cancellation may happen while the stream is being written.
			if (this.get(blob.id)?.state !== 'pending') throw new ApiError(409, 'Upload was cancelled.');
			await rename(temp, blob.path);
			const published = this.db.run("UPDATE blobs SET state='uploaded',size=?,sha256=? WHERE id=? AND state='pending'", bytes, sha256, blob.id);
			if (Number(published.changes) !== 1) {
				await rm(blob.path, { force: true });
				throw new ApiError(409, 'Upload was cancelled.');
			}
			this.validators.delete(blob.id);
			return { id: blob.id, size: bytes };
		} finally {
			this.inflight.delete(blob.id);
			await rm(temp, { force: true });
		}
	}
	complete(request: FastifyRequest): { id: string; size: number } {
		const blob = this.capability(request);
		if (!['uploaded', 'ready'].includes(blob.state)) throw new ApiError(409, 'Upload the complete file before confirming success.');
		this.db.run("UPDATE blobs SET state='ready' WHERE id=?", blob.id);
		return { id: blob.id, size: blob.size };
	}
	async fail(request: FastifyRequest): Promise<{ id: string }> {
		const blob = this.capability(request);
		if (blob.state === 'ready') throw new ApiError(409, 'A published upload cannot be cancelled.');
		await this.remove(blob.id); return { id: blob.id };
	}
	progress(request: FastifyRequest): void { this.capability(request); }
	downloadUrl(id: string): string {
		if (!this.ready(id)) throw new ApiError(404, 'File is not available.');
		const expires = now() + 3600;
		return `${this.config.publicUrl}/media/${id}?expires=${expires}&signature=${this.sign(id, expires)}`;
	}
	private sign(id: string, expires: number): string { return createHmac('sha256', this.key).update(`${id}:${expires}`).digest('base64url'); }
	async send(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
		const { id } = request.params as { id: string };
		const { expires, signature } = request.query as { expires?: string; signature?: string };
		const until = Number(expires);
		if (!Number.isSafeInteger(until) || until < now() || until > now() + 3660 || typeof signature !== 'string'
			|| !equal(signature, this.sign(id, until))) throw new ApiError(403, 'Invalid or expired download capability.');
		const blob = this.ready(id);
		if (!blob) throw new ApiError(404, 'File is not available.');
		try { await stat(blob.path); } catch { throw new ApiError(404, 'File bytes are missing. Restore the data volume.'); }
		reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=60').header('etag', `"${blob.sha256}"`)
			.header('content-type', blob.mime).header('x-content-type-options', 'nosniff');
		let start = 0; let end = blob.size - 1;
		const range = request.headers.range;
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2])) return reply.code(416).header('content-range', `bytes */${blob.size}`).send();
			if (!match[1]) { start = Math.max(0, blob.size - Number(match[2])); }
			else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= blob.size
				|| (!match[1] && Number(match[2]) === 0)) return reply.code(416).header('content-range', `bytes */${blob.size}`).send();
			reply.code(206).header('content-range', `bytes ${start}-${end}/${blob.size}`);
		}
		reply.header('content-length', end - start + 1);
		if (request.method === 'HEAD') return reply.send();
		return reply.send(createReadStream(blob.path, { start, end }));
	}
	async remove(id: string): Promise<void> {
		const blob = this.get(id); if (!blob) return;
		this.db.run("UPDATE blobs SET state='failed',size=0 WHERE id=?", id);
		this.validators.delete(id);
		await rm(blob.path, { force: true });
	}
}

export async function registerBlobRoutes(app: FastifyInstance, blobs: BlobStorage): Promise<void> {
	await app.register(async uploads => {
		uploads.removeAllContentTypeParsers();
		uploads.addContentTypeParser('*', (_request, payload, done) => { done(null, payload); });
		uploads.put('/uploads/:id', request => blobs.receive(request));
	});
	app.route({ method: ['GET', 'POST'], url: '/uploads/:id/success', handler: request => blobs.complete(request) });
	app.route({ method: ['GET', 'POST', 'DELETE'], url: '/uploads/:id/fail', handler: request => blobs.fail(request) });
	app.patch('/uploads/:id/progress', (request, reply) => { blobs.progress(request); void reply.code(204).send(); });
	app.get('/media/:id', (request, reply) => blobs.send(request, reply));
}
