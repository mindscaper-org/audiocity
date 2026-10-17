import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, now, objectBody, pageQuery, requiredString } from './core.ts';
import type { Context, User } from './core.ts';
import { audioFormat, validateAudio } from './audio-formats.ts';
import { audioLicenses, audioSlug, boolean, initializeAudioSchema, mutableFields, saveMetadata, validateMetadata } from './audio-metadata.ts';
import type { AudioRecord } from './audio-metadata.ts';
import { SharedLibrary } from './shared-library.ts';

export async function registerAudioRoutes(app: FastifyInstance, ctx: Context): Promise<void> {
	initializeAudioSchema(ctx.db);
	const shared = new SharedLibrary(ctx.db, ctx.config);
	await shared.initialize();
	app.get('/shared-media/:id', (request, reply) => shared.send(request, reply));
	ctx.blobs.setValidator('audio', async (blob, path) => {
		const duration = await validateAudio(path, blob.mime);
		ctx.db.run('UPDATE audio SET duration=? WHERE id=?', duration, blob.resource_id);
	});

	function owner(request: FastifyRequest): User { return ctx.auth.requireUser(request, 'audio'); }
	function find(id: string, userId?: string): AudioRecord {
		const row = id.startsWith('slug:') && userId
			? ctx.db.get<AudioRecord>('SELECT * FROM audio WHERE owner_id=? AND slug=?', userId, id.slice(5))
			: ctx.db.get<AudioRecord>('SELECT * FROM audio WHERE id=?', id);
		if (!row || (row.origin === 'shared-folder' && !row.shared_present) || (userId && row.owner_id !== userId)) throw new ApiError(404, 'Audio not found.', 'NotFound');
		return row;
	}
	function queryId(request: FastifyRequest): string {
		return requiredString(objectBody(request.query).id, 'id');
	}
	function visible(request: FastifyRequest, id: string, download = false): AudioRecord {
		const row = find(id);
		const user = request.headers.authorization ? owner(request) : undefined;
		if (row.origin === 'shared-folder') {
			if (!user) throw new ApiError(404, 'Audio not found.', 'NotFound');
			return row;
		}
		if (user?.id === row.owner_id) return row;
		if (row.visibility === 'private' || !ctx.blobs.ready(row.blob_id) || (download && !row.is_downloadable)) {
			throw new ApiError(404, 'Audio not found.', 'NotFound');
		}
		return row;
	}
	function metadata(row: AudioRecord, legacyList = false, viewer?: User) {
		const user = ctx.auth.findUser(row.owner_id);
		const folder = row.origin === 'shared-folder';
		const blob = folder ? undefined : ctx.blobs.get(row.blob_id);
		const ready = folder ? Boolean(row.shared_present) : ctx.blobs.ready(row.blob_id);
		const url = ready ? folder ? shared.downloadUrl(row) : ctx.blobs.downloadUrl(row.blob_id) : '';
		return {
			id: row.id, title: row.title, slug: row.slug, name: row.name,
			category: row.category, description: row.description, tags: JSON.parse(row.tags) as string[], license: row.license,
			visibility: row.visibility, is_public: row.visibility === 'public', is_listed: row.visibility === 'public',
			is_downloadable: Boolean(row.is_downloadable), status: ready ? 'ready' : blob?.state === 'failed' ? 'failed' : 'pending',
			author_name: folder ? 'Shared library' : user?.name ?? '', username: user?.username ?? '',
			author: legacyList ? folder ? 'Shared library' : user?.name ?? '' : { id: row.owner_id },
			created: row.created, date_created: row.created, date_updated: row.updated,
			image: '', source: { size: folder ? row.shared_size : typeof ready === 'object' ? ready.size : 0, duration: row.duration, mime: folder ? row.shared_mime : blob?.mime ?? '' },
			play: { url, duration: row.duration, waveform: '' },
			url: `${ctx.config.publicUrl}/public/audio/${row.id}`,
			playback_path: `/audio/${row.id}/play`, origin: row.origin,
			can_edit: Boolean(viewer && (folder ? viewer.admin : viewer.id === row.owner_id)),
		};
	}
	function includeShared(user: User): boolean {
		return ctx.db.get<{ include_shared: number }>('SELECT include_shared FROM library_preferences WHERE user_id=?', user.id)?.include_shared !== 0;
	}
	function sourceWhere(user: User, source: string): { sql: string; values: string[] } {
		const mine = "(origin='upload' AND owner_id=?)";
		const common = "((origin='upload' AND visibility='public' AND blob_id IN (SELECT id FROM blobs WHERE state='ready')) OR (origin='shared-folder' AND shared_present=1))";
		return source === 'mine' ? { sql: mine, values: [user.id] }
			: source === 'shared' ? { sql: common, values: [] }
			: { sql: `(${mine} OR ${common})`, values: [user.id] };
	}
	function admin(request: FastifyRequest): User {
		const user = owner(request);
		if (!user.admin) throw new ApiError(403, 'Administrator access required.', 'Forbidden');
		return user;
	}
	function editable(id: string, user: User): AudioRecord {
		const row = find(id);
		if (row.origin === 'shared-folder' ? !user.admin : row.owner_id !== user.id) throw new ApiError(404, 'Audio not found.', 'NotFound');
		return row;
	}
	function ensureUnique(row: AudioRecord): void {
		if (ctx.db.get('SELECT id FROM audio WHERE owner_id=? AND slug=? AND id<>?', row.owner_id, row.slug, row.id)) {
			throw new ApiError(409, 'This audio slug is already in use.', 'Conflict');
		}
	}

	async function create(request: FastifyRequest) {
		const user = owner(request);
		const body = objectBody(request.body);
		if (request.routeOptions.url === '/v1/audio/create') requiredString(body.category, 'category', 64);
		const mime = requiredString(body.mime, 'mime', 100);
		audioFormat(mime);
		if (!Number.isSafeInteger(body.size) || Number(body.size) < 1 || Number(body.size) > ctx.config.maxUploadBytes) {
			throw new ApiError(422, `size must be between 1 and ${ctx.config.maxUploadBytes} bytes.`, 'ValidationError');
		}
		const name = body.name === undefined ? 'Untitled audio' : requiredString(body.name, 'name', 256);
		const title = name.replace(/\.[^.]{1,8}$/, '') || name;
		let row = validateMetadata(ctx.db, body, {
			id: randomUUID(), owner_id: user.id, blob_id: '', name, title, slug: audioSlug(title),
			category: 'other', description: '', tags: '[]', license: 'arr', visibility: 'unlisted',
			is_downloadable: 0, duration: 0, created: now(), updated: now(),
			origin: 'upload', shared_path: '', shared_size: 0, shared_mtime: 0, shared_mime: '', shared_present: 0,
		});
		if (body.slug === undefined) {
			const base = row.slug;
			for (let index = 2; ctx.db.get('SELECT id FROM audio WHERE owner_id=? AND slug=?', user.id, row.slug); index++) row.slug = `${base.slice(0, 90)}-${index}`;
		}
		ensureUnique(row);
		const policy = ctx.blobs.create(user.id, {
			kind: 'audio', resourceId: row.id, mime, expectedSize: Number(body.size),
		});
		row = { ...row, blob_id: policy.id };
		try {
			ctx.db.run(`INSERT INTO audio (id,owner_id,blob_id,name,title,slug,category,description,tags,license,visibility,is_downloadable,duration,created,updated)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.owner_id, row.blob_id, row.name, row.title, row.slug, row.category,
				row.description, row.tags, row.license, row.visibility, row.is_downloadable, row.duration, row.created, row.updated);
		} catch (error) { await ctx.blobs.remove(policy.id); throw error; }
		const audio = metadata(row, false, user);
		return { ...policy, audio, extra: { audio } };
	}

	for (const url of ['/v1/audio/create', '/audio']) app.post(url, async (request, reply) => reply.code(201).send(await create(request)));

	app.get('/v1/search', { config: { rateLimit: {
		max: 60, timeWindow: '1 minute', keyGenerator: request => owner(request).id,
	} } }, async request => {
		const user = owner(request);
		await shared.scan();
		const query = objectBody(request.query);
		const search = query.query ?? '';
		const types = query.types ?? '';
		const pageValue = query.page ?? '1';
		if (typeof search !== 'string' || search.length > 256 || typeof types !== 'string'
			|| typeof pageValue !== 'string' || !/^[1-9]\d{0,5}$/.test(pageValue)
			|| (types && types.split(',').some(type => !['audio', 'author', 'collection'].includes(type)))) {
			throw new ApiError(422, 'Supply a query of at most 256 characters, valid result types and a positive page.', 'ValidationError');
		}
		if (types && !types.split(',').includes('audio')) return [];
		const term = search.trim();
		const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
		const matching = term.startsWith('#')
			? 'EXISTS (SELECT 1 FROM json_each(audio.tags) WHERE value=? COLLATE NOCASE)'
			: `(audio.title LIKE ? ESCAPE '\\' OR audio.description LIKE ? ESCAPE '\\' OR users.name LIKE ? ESCAPE '\\'
				OR EXISTS (SELECT 1 FROM json_each(audio.tags) WHERE value LIKE ? ESCAPE '\\'))`;
		const params = term.startsWith('#') ? [term.slice(1)] : [pattern, pattern, pattern, pattern];
		const scope = includeShared(user) ? sourceWhere(user, 'shared') : { sql: "(origin='upload' AND audio.owner_id=? AND visibility='public' AND blob_id IN (SELECT id FROM blobs WHERE state='ready'))", values: [user.id] };
		const rows = ctx.db.all<AudioRecord>(`SELECT audio.* FROM audio LEFT JOIN users ON users.id=audio.owner_id
			WHERE ${scope.sql} AND ${matching}
			ORDER BY audio.created DESC,audio.rowid DESC LIMIT 10 OFFSET ?`, ...scope.values, ...params, (Number(pageValue) - 1) * 10);
		return rows.map(row => ({ type: 'audio', model: metadata(row) }));
	});

	async function list(request: FastifyRequest, legacy: boolean, library = false) {
		const user = owner(request);
		await shared.scan();
		const query = objectBody(request.query);
		const { page, perPage, search } = pageQuery(legacy || library ? query : { 'per-page': 50, ...query });
		const sort = query.sort ?? 'newest';
		if (typeof sort !== 'string' || !['newest', 'oldest', 'az'].includes(sort)) throw new ApiError(422, 'sort must be newest, oldest, or az.', 'ValidationError');
		const source = library && query.source !== undefined ? query.source : includeShared(user) ? 'all' : 'mine';
		if (typeof source !== 'string' || !['mine', 'shared', 'all'].includes(source)) throw new ApiError(422, 'source must be mine, shared, or all.', 'ValidationError');
		const where = sourceWhere(user, source);
		const order = sort === 'az' ? 'title COLLATE NOCASE ASC,id ASC' : `created ${sort === 'oldest' ? 'ASC' : 'DESC'},rowid ${sort === 'oldest' ? 'ASC' : 'DESC'}`;
		const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
		const filter = `${where.sql} AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(audio.tags) WHERE value LIKE ? ESCAPE '\\'))`;
		const values = [...where.values, pattern, pattern, pattern];
		const total = ctx.db.get<{ count: number }>(`SELECT count(*) AS count FROM audio WHERE ${filter}`, ...values)?.count ?? 0;
		const rows = ctx.db.all<AudioRecord>(`SELECT * FROM audio WHERE ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`, ...values, perPage, (page - 1) * perPage);
		const items = rows.map(row => metadata(row, legacy, user));
		return legacy || library ? { items, pagination: { total, pages: Math.ceil(total / perPage), page, size: perPage } } : items;
	}
	app.get('/v1/audio/list', request => list(request, false));
	app.get('/my/audio', request => list(request, true));
	app.get('/library/audio', request => list(request, false, true));
	app.get('/library/options', () => ({
		categories: ctx.db.all<{ id: string; name: string }>('SELECT id,name FROM audio_categories ORDER BY rowid'),
		licenses: audioLicenses, shared_folder: Boolean(ctx.config.sharedDir),
	}));
	app.get('/library/preferences', request => ({ include_shared: includeShared(owner(request)) }));
	app.patch('/library/preferences', request => {
		const user = owner(request); const body = objectBody(request.body);
		const include = boolean(body.include_shared, 'include_shared');
		ctx.db.run('INSERT INTO library_preferences(user_id,include_shared) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET include_shared=excluded.include_shared', user.id, Number(include));
		return { include_shared: include };
	});
	app.post('/admin/shared/rescan', async request => { admin(request); return { files: await shared.scan(true) }; });
	app.get('/admin/categories', request => { admin(request); return { items: ctx.db.all('SELECT id,name FROM audio_categories ORDER BY rowid') }; });
	app.post('/admin/categories', (request, reply) => {
		admin(request); const body = objectBody(request.body);
		const id = requiredString(body.id, 'id', 64); const name = requiredString(body.name, 'name', 100);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ['voice-over', 'sound-design'].includes(id)) throw new ApiError(422, 'Use a lowercase category ID with letters, numbers, and hyphens.', 'ValidationError');
		if (ctx.db.get('SELECT id FROM audio_categories WHERE id=?', id)) throw new ApiError(409, 'This category ID is already in use.', 'Conflict');
		ctx.db.run('INSERT INTO audio_categories(id,name) VALUES (?,?)', id, name);
		return reply.code(201).send({ id, name });
	});
	app.patch<{ Params: { id: string } }>('/admin/categories/:id', request => {
		admin(request); const id = request.params.id;
		if (!ctx.db.get('SELECT id FROM audio_categories WHERE id=?', id)) throw new ApiError(404, 'Category not found.', 'NotFound');
		const name = requiredString(objectBody(request.body).name, 'name', 100);
		ctx.db.run('UPDATE audio_categories SET name=? WHERE id=?', name, id); return { id, name };
	});
	app.delete<{ Params: { id: string } }>('/admin/categories/:id', (request, reply) => {
		admin(request); const id = request.params.id;
		if (!ctx.db.get('SELECT id FROM audio_categories WHERE id=?', id)) throw new ApiError(404, 'Category not found.', 'NotFound');
		if (id === 'other' || ctx.db.get('SELECT id FROM audio WHERE category=? LIMIT 1', id)) throw new ApiError(409, 'The default category or a category used by audio cannot be deleted.', 'Conflict');
		ctx.db.run('DELETE FROM audio_categories WHERE id=?', id); return reply.code(204).send();
	});
	function resolveAudio(request: FastifyRequest, username: string, slug: string) {
		const row = ctx.db.get<AudioRecord>('SELECT audio.* FROM audio JOIN users ON users.id=audio.owner_id WHERE users.username=? AND audio.slug=?', username, slug);
		if (!row) throw new ApiError(404, 'Audio not found.', 'NotFound');
		return metadata(visible(request, row.id), false, request.headers.authorization ? owner(request) : undefined);
	}
	app.get('/library/audio/resolve', request => {
		const query = objectBody(request.query);
		return resolveAudio(request, requiredString(query.username, 'username', 100), requiredString(query.slug, 'slug', 100));
	});
	app.get<{ Params: { username: string; slug: string } }>('/public/audio/by-slug/:username/:slug', request => resolveAudio(request, request.params.username, request.params.slug));
	app.get<{ Params: { id: string } }>('/library/audio/:id', request => metadata(visible(request, request.params.id), false, request.headers.authorization ? owner(request) : undefined));
	function patchAudio(request: FastifyRequest, id: string) {
		const user = owner(request); const row = editable(id, user); const body = objectBody(request.body);
		if (!Object.keys(body).some(key => mutableFields.has(key))) throw new ApiError(422, 'Supply at least one editable audio field.', 'ValidationError');
		const updated = validateMetadata(ctx.db, body, row); ensureUnique(updated); saveMetadata(ctx.db, updated, now());
		return metadata(find(id), false, user);
	}
	app.patch<{ Params: { id: string } }>('/library/audio/:id', request => patchAudio(request, request.params.id));
	app.patch('/library/audio/batch', request => {
		const user = owner(request); const body = objectBody(request.body);
		if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000) throw new ApiError(422, 'items must contain between 1 and 1000 audio edits.', 'ValidationError');
		const ids = new Set<string>();
		const edits = body.items.map(value => {
			const edit = objectBody(value); const id = requiredString(edit.id, 'id', 100);
			if (ids.has(id)) throw new ApiError(422, 'Each audio ID may appear only once.', 'ValidationError');
			ids.add(id);
			if (!Object.keys(edit).some(key => mutableFields.has(key))) throw new ApiError(422, 'Supply at least one editable audio field for each item.', 'ValidationError');
			return validateMetadata(ctx.db, edit, editable(id, user));
		});
		ctx.db.transaction(() => {
			const targets = new Set<string>();
			for (const row of edits) {
				const key = `${row.owner_id}:${row.slug}`;
				if (targets.has(key)) throw new ApiError(409, 'Two edits use the same audio slug.', 'Conflict');
				targets.add(key);
				const conflict = ctx.db.get<{ id: string }>('SELECT id FROM audio WHERE owner_id=? AND slug=? AND id<>?', row.owner_id, row.slug, row.id);
				if (conflict && !ids.has(conflict.id)) throw new ApiError(409, 'This audio slug is already in use.', 'Conflict');
			}
			// Temporary unique values permit atomic swaps without breaking the unique index.
			for (const row of edits) ctx.db.run('UPDATE audio SET slug=? WHERE id=?', `batch-${randomUUID()}`, row.id);
			for (const row of edits) saveMetadata(ctx.db, row, now());
		});
		return { items: edits.map(row => metadata(find(row.id), false, user)) };
	});
	app.get('/v1/audio/view', request => {
		const user = owner(request); const id = queryId(request);
		let row: AudioRecord;
		try { row = find(id, user.id); }
		catch (error) {
			row = find(id);
			if (!(row.origin === 'shared-folder' || row.visibility === 'public' && ctx.blobs.ready(row.blob_id))) throw error;
		}
		return metadata(row, false, user);
	});
	app.get<{ Params: { id: string } }>('/audio/:id', request => metadata(visible(request, request.params.id)));
	app.get<{ Params: { id: string } }>('/public/audio/:id', request => {
		const row = find(request.params.id);
		if (row.origin !== 'upload' || row.visibility === 'private' || !ctx.blobs.ready(row.blob_id)) throw new ApiError(404, 'Audio not found.', 'NotFound');
		return metadata(row);
	});
	app.get('/public/audio', request => {
		const { page, perPage } = pageQuery(request.query);
		const where = "origin='upload' AND visibility='public' AND blob_id IN (SELECT id FROM blobs WHERE state='ready')";
		const total = ctx.db.get<{ count: number }>(`SELECT count(*) AS count FROM audio WHERE ${where}`)?.count ?? 0;
		const rows = ctx.db.all<AudioRecord>(`SELECT * FROM audio WHERE ${where} ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?`, perPage, (page - 1) * perPage);
		return { items: rows.map(row => metadata(row)), pagination: { total, pages: Math.ceil(total / perPage), page, size: perPage } };
	});
	app.get<{ Params: { id: string } }>('/download/:id', request => {
		const row = visible(request, request.params.id, true);
		if (row.origin === 'shared-folder') return { items: [{ format: audioFormat(row.shared_mime), url: shared.downloadUrl(row), size: row.shared_size, source: true }] };
		const blob = ctx.blobs.ready(row.blob_id);
		if (!blob) throw new ApiError(409, 'The audio upload is not ready.', 'Conflict');
		return { items: [{ format: audioFormat(blob.mime), url: ctx.blobs.downloadUrl(blob.id), size: blob.size, source: true }] };
	});

	app.patch('/v1/audio/update', request => {
		const row = find(queryId(request), owner(request).id);
		const body = objectBody(request.body);
		if (!Object.keys(body).some(key => mutableFields.has(key))) throw new ApiError(422, 'Supply at least one editable audio field.', 'ValidationError');
		const updated = validateMetadata(ctx.db, body, row);
		ensureUnique(updated);
		ctx.db.run('UPDATE audio SET title=?,slug=?,category=?,description=?,tags=?,license=?,visibility=?,is_downloadable=?,updated=? WHERE id=?',
			updated.title, updated.slug, updated.category, updated.description, updated.tags, updated.license, updated.visibility, updated.is_downloadable, now(), updated.id);
		return metadata(find(updated.id));
	});
	app.post('/v1/audio/delete', async (request, reply) => {
		const row = find(queryId(request), owner(request).id);
		await ctx.blobs.remove(row.blob_id);
		ctx.db.run('DELETE FROM audio WHERE id=?', row.id);
		return reply.code(204).send();
	});
}
