import { randomUUID } from 'node:crypto';
import { ApiError, now, requiredString } from './core.ts';
import type { Context, UploadDescriptor, User } from './core.ts';

export interface ProjectRow {
	id: string; owner_id: string; name: string; details: string; slug: string;
	created: number; updated: number; head_id: string; synced_id: string;
}
export interface SnapshotRow {
	id: string; project_id: string; parent_id: string; previous_head_id: string; format: string;
	file_id: string; file_upload: string; mixdown_id: string; mixdown_upload: string;
	created: number; updated: number; synced: number;
}
export interface BlockRow { owner_id: string; hash: string; blob_id: string; upload: string }
export interface ProjectForm { name: string | undefined; details: string | undefined; head: string; force: boolean; hashes: string[]; format: string | undefined; size: number | undefined }

export function projectSchema(ctx: Context): void {
	ctx.db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, details TEXT NOT NULL,
			slug TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
			head_id TEXT NOT NULL DEFAULT '', synced_id TEXT NOT NULL DEFAULT ''
		);
		CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
		CREATE TABLE IF NOT EXISTS snapshots (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			parent_id TEXT NOT NULL, previous_head_id TEXT NOT NULL, format TEXT NOT NULL, file_id TEXT NOT NULL, file_upload TEXT NOT NULL,
			mixdown_id TEXT NOT NULL, mixdown_upload TEXT NOT NULL, created INTEGER NOT NULL,
			updated INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS snapshots_project ON snapshots(project_id);
		CREATE TABLE IF NOT EXISTS project_blocks (
			owner_id TEXT NOT NULL, hash TEXT NOT NULL, blob_id TEXT NOT NULL, upload TEXT NOT NULL,
			PRIMARY KEY(owner_id, hash)
		);
		CREATE TABLE IF NOT EXISTS snapshot_blocks (
			snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
			owner_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(snapshot_id, hash)
		);
		CREATE INDEX IF NOT EXISTS project_blocks_canonical_hash ON project_blocks(owner_id, lower(hash));
		CREATE TABLE IF NOT EXISTS native_project_ids (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE
		);
		INSERT INTO native_project_ids (project_id)
			SELECT p.id FROM projects p JOIN snapshots s ON p.head_id=s.id
			WHERE s.format='audacity' AND NOT EXISTS (SELECT 1 FROM native_project_ids n WHERE n.project_id=p.id)
			ORDER BY p.created,p.id;
	`);
}

export function projectForm(body: Record<string, unknown>): ProjectForm {
	const format = body.format === undefined ? undefined : requiredString(body.format, 'format', 16).toLowerCase();
	if (format !== undefined && !['aup3', 'aup4', 'audacity'].includes(format)) throw new ApiError(422, 'format must be audacity, aup3 or aup4.', 'ValidationError');
	const blocks = body.blocks ?? [];
	if (!Array.isArray(blocks) || blocks.length > 100_000) throw new ApiError(422, 'blocks must contain at most 100000 hashes.', 'ValidationError');
	const hashes = [...new Set(blocks.map((hash: unknown) => requiredString(hash, 'block hash', 256).toLowerCase()))];
	if (hashes.some((hash) => !/^[A-Za-z0-9_-]+$/.test(hash))) throw new ApiError(422, 'Block hashes must be alphanumeric, underscores or hyphens.', 'ValidationError');
	if (format && format !== 'audacity' && hashes.length) throw new ApiError(422, 'Whole-file projects do not accept audio block hashes.', 'ValidationError');
	const size = body.size === undefined ? undefined : Number(body.size);
	if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new ApiError(422, 'size must be a nonnegative integer.', 'ValidationError');
	if (body.force !== undefined && typeof body.force !== 'boolean') throw new ApiError(422, 'force must be a boolean.', 'ValidationError');
	return {
		name: body.name === undefined ? undefined : requiredString(body.name, 'name'),
		details: body.details === undefined ? undefined : typeof body.details === 'string' && body.details.length <= 10000 ? body.details : requiredString(body.details, 'details', 10000),
		head: body.head_snapshot_id === undefined ? '' : requiredString(body.head_snapshot_id, 'head_snapshot_id'),
		force: body.force === true, hashes, format, size,
	};
}

export function getProject(ctx: Context, user: User, id: string): ProjectRow {
	const native = /^[1-9]\d*$/.test(id)
		? ctx.db.get<{ project_id: string }>('SELECT project_id FROM native_project_ids WHERE id=? AND CAST(id AS TEXT)=?', id, id)
		: undefined;
	const row = ctx.db.get<ProjectRow>('SELECT * FROM projects WHERE id=? AND owner_id=?', native?.project_id ?? id, user.id);
	if (!row) throw new ApiError(404, 'Project not found.', 'NotFound');
	return row;
}

export function projectClientId(ctx: Context, project: ProjectRow): string {
	// Audacity 3 uses this ID in unquoted SQL identifiers and an INTEGER PRIMARY KEY.
	// Preserve the storage UUID and legacy routes while returning a stable decimal ID.
	return ctx.db.get<{ id: string }>('SELECT CAST(id AS TEXT) AS id FROM native_project_ids WHERE project_id=?', project.id)?.id ?? project.id;
}

export function getSnapshot(ctx: Context, project: ProjectRow, id: string): SnapshotRow {
	const row = ctx.db.get<SnapshotRow>('SELECT * FROM snapshots WHERE id=? AND project_id=?', id, project.id);
	if (!row) throw new ApiError(404, 'Snapshot not found.', 'NotFound');
	return row;
}

export function snapshotBlocks(ctx: Context, snapshot: SnapshotRow): BlockRow[] {
	return ctx.db.all<BlockRow>('SELECT b.* FROM project_blocks b JOIN snapshot_blocks s ON b.owner_id=s.owner_id AND b.hash=s.hash WHERE s.snapshot_id=? ORDER BY b.hash', snapshot.id);
}

export function createProject(ctx: Context, user: User, form: ProjectForm): ProjectRow {
	const id = randomUUID(); const date = now();
	const name = form.name ?? 'Untitled project';
	const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'project'}-${id.slice(0, 8)}`;
	ctx.db.run('INSERT INTO projects (id,owner_id,name,details,slug,created,updated) VALUES (?,?,?,?,?,?,?)', id, user.id, name, form.details ?? '', slug, date, date);
	return getProject(ctx, user, id);
}

export function createSnapshot(ctx: Context, project: ProjectRow, form: ProjectForm): SnapshotRow {
	if (!form.force && form.head !== project.head_id) throw new ApiError(409, 'The project head changed. Refresh before saving, or explicitly force a revision.', 'ProjectVersionConflict');
	if (form.head && !ctx.db.get('SELECT id FROM snapshots WHERE id=? AND project_id=?', form.head, project.id)) throw new ApiError(409, 'The parent snapshot does not belong to this project.', 'ProjectVersionConflict');
	const previous = project.head_id ? getSnapshot(ctx, project, project.head_id) : undefined;
	const format = form.format ?? previous?.format ?? 'audacity';
	if (format !== 'audacity' && form.hashes.length) throw new ApiError(422, 'Whole-file projects do not accept audio block hashes.', 'ValidationError');
	if (previous && (format === 'audacity') !== (previous.format === 'audacity')) throw new ApiError(422, 'Create a separate project when switching between block snapshots and whole-file archives.', 'ValidationError');
	if (!previous && format === 'audacity') ctx.db.run('INSERT INTO native_project_ids (project_id) VALUES (?)', project.id);
	const id = randomUUID(); const date = now();
	const file = ctx.blobs.create(project.owner_id, {
		kind: format === 'audacity' ? 'project-file' : 'project-archive', resourceId: id,
		mime: 'application/octet-stream', maxBytes: format === 'audacity' ? 256 * 1024 * 1024 : ctx.config.maxUploadBytes,
		...(form.size === undefined ? {} : { expectedSize: form.size }),
	});
	const mixdown = ctx.blobs.create(project.owner_id, { kind: 'project-mixdown', resourceId: id, mime: 'application/octet-stream' });
	ctx.db.run('INSERT INTO snapshots (id,project_id,parent_id,previous_head_id,format,file_id,file_upload,mixdown_id,mixdown_upload,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, project.id, form.head || project.head_id, project.head_id, format, file.id, JSON.stringify(file), mixdown.id, JSON.stringify(mixdown), date, date);
	for (const hash of form.hashes) {
		let block = ctx.db.get<BlockRow>(`SELECT b.* FROM project_blocks b LEFT JOIN blobs ON blobs.id=b.blob_id
			WHERE b.owner_id=? AND lower(b.hash)=?
			ORDER BY CASE WHEN blobs.state='ready' THEN 0 ELSE 1 END, b.rowid LIMIT 1`, project.owner_id, hash);
		if (!block) {
			const descriptor = ctx.blobs.create(project.owner_id, { kind: 'project-block', resourceId: hash, mime: 'application/octet-stream', maxBytes: 64 * 1024 * 1024 });
			block = { owner_id: project.owner_id, hash, blob_id: descriptor.id, upload: JSON.stringify(descriptor) };
			ctx.db.run('INSERT INTO project_blocks (owner_id,hash,blob_id,upload) VALUES (?,?,?,?)', project.owner_id, hash, descriptor.id, block.upload);
		}
		ctx.db.run('INSERT INTO snapshot_blocks (snapshot_id,owner_id,hash) VALUES (?,?,?)', id, project.owner_id, block.hash);
	}
	ctx.db.run('UPDATE projects SET head_id=?,updated=?,name=?,details=? WHERE id=?', id, date, form.name ?? project.name, form.details ?? project.details, project.id);
	return getSnapshot(ctx, project, id);
}

export function descriptor(value: string): UploadDescriptor {
	return JSON.parse(value) as UploadDescriptor;
}

export async function collectUnusedBlocks(ctx: Context, owner: string): Promise<void> {
	const unused = ctx.db.all<BlockRow>('SELECT * FROM project_blocks b WHERE owner_id=? AND NOT EXISTS (SELECT 1 FROM snapshot_blocks s WHERE s.owner_id=b.owner_id AND s.hash=b.hash)', owner);
	for (const row of unused) {
		// A save may reuse another candidate while the previous removal awaits I/O.
		const removed = ctx.db.run(`DELETE FROM project_blocks WHERE owner_id=? AND hash=? AND blob_id=?
			AND NOT EXISTS (SELECT 1 FROM snapshot_blocks s WHERE s.owner_id=project_blocks.owner_id AND s.hash=project_blocks.hash)`, owner, row.hash, row.blob_id);
		if (Number(removed.changes) === 1) await ctx.blobs.remove(row.blob_id);
	}
}
