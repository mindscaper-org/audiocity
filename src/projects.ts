import type { FastifyInstance, FastifyRequest } from 'fastify';
import { open } from 'node:fs/promises';
import { ApiError, now, objectBody, pageQuery } from './core.ts';
import type { BlobInfo, Context } from './core.ts';
import { completeSnapshot, projectInfo, snapshotInfo, syncState } from './projects-protocol.ts';
import { collectUnusedBlocks, createProject, createSnapshot, getProject, getSnapshot, projectForm, projectSchema } from './projects-store.ts';
import type { ProjectRow, SnapshotRow } from './projects-store.ts';
import { inspectAudio } from './audio-formats.ts';

interface ProjectParams { projectId: string; snapshotId: string }
const ids = (request: FastifyRequest) => request.params as ProjectParams;

export async function registerProjectRoutes(app: FastifyInstance, ctx: Context): Promise<void> {
	projectSchema(ctx);
	ctx.blobs.setValidator('project-mixdown', async (blob, path) => {
		const { mime } = await inspectAudio(path);
		ctx.db.run('UPDATE blobs SET mime=? WHERE id=?', mime, blob.id);
	});
	// Earlier versions accepted mixdowns but labeled every container as WAV.
	for (const blob of ctx.db.all<BlobInfo>("SELECT * FROM blobs WHERE kind='project-mixdown' AND state IN ('uploaded','ready')")) {
		try {
			const { mime } = await inspectAudio(blob.path);
			if (mime !== blob.mime) ctx.db.run('UPDATE blobs SET mime=? WHERE id=?', mime, blob.id);
		} catch {
			// Retain unrecognized legacy bytes without advertising them as playable audio.
			ctx.db.run("UPDATE blobs SET mime='application/octet-stream' WHERE id=?", blob.id);
		}
	}
	ctx.blobs.setValidator('project-archive', async (_blob, path) => {
		const file = await open(path, 'r');
		try {
			const header = Buffer.alloc(16); const result = await file.read(header, 0, 16, 0);
			if (result.bytesRead !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) throw new ApiError(422, 'AUP3 and AUP4 archives must be standalone SQLite project files.', 'InvalidProjectArchive');
		} finally { await file.close(); }
	});
	app.post('/project', (request, reply) => {
		const user = ctx.auth.requireUser(request, 'projects');
		const form = projectForm(objectBody(request.body));
		const result = ctx.db.transaction(() => {
			const project = createProject(ctx, user, form);
			const snapshot = createSnapshot(ctx, project, { ...form, head: '', force: false });
			return { project: projectInfo(ctx, getProject(ctx, user, project.id)), snapshot: snapshotInfo(ctx, snapshot), sync: syncState(ctx, project, snapshot, true) };
		});
		return reply.code(result.snapshot.transport === 'blocks' ? 200 : 201).send(result);
	});
	app.get('/project', (request) => {
		const user = ctx.auth.requireUser(request, 'projects'); const query = objectBody(request.query);
		const { page, perPage, search } = pageQuery(query);
		const filter = query.format === undefined ? undefined : typeof query.format === 'string' ? query.format : '';
		if (query.format !== undefined && !filter) throw new ApiError(422, 'Unknown project format.', 'ValidationError');
		if (filter && !['audacity', 'aup3', 'aup4'].includes(filter)) throw new ApiError(422, 'Unknown project format.', 'ValidationError');
		if (query.transport !== undefined && (typeof query.transport !== 'string' || !['all', 'blocks', 'file'].includes(query.transport))) throw new ApiError(422, 'transport must be all, blocks or file.', 'ValidationError');
		const formatCondition = filter ? 's.format=?' : query.transport === 'all' ? '1=1' : query.transport === 'file' ? "s.format!='audacity'" : "s.format='audacity'";
		const values = filter ? [user.id, `%${search}%`, filter] : [user.id, `%${search}%`];
		const condition = `FROM projects p JOIN snapshots s ON p.head_id=s.id WHERE p.owner_id=? AND p.name LIKE ? AND ${formatCondition}`;
		const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n ${condition}`, ...values)!.n;
		const rows = ctx.db.all<ProjectRow>(`SELECT p.* ${condition} ORDER BY p.updated DESC,p.id LIMIT ? OFFSET ?`, ...values, perPage, (page - 1) * perPage);
		return { items: rows.map((row) => projectInfo(ctx, row)), pagination: { total, pages: Math.ceil(total / perPage), page, size: perPage } };
	});
	app.get('/project/:projectId', (request) => {
		const user = ctx.auth.requireUser(request, 'projects');
		return projectInfo(ctx, getProject(ctx, user, ids(request).projectId));
	});
	app.patch('/project/:projectId', (request) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const form = projectForm(objectBody(request.body));
		ctx.db.run('UPDATE projects SET name=?,details=?,updated=? WHERE id=?', form.name ?? project.name, form.details ?? project.details, now(), project.id);
		return projectInfo(ctx, getProject(ctx, user, project.id));
	});
	app.post('/project/:projectId/snapshot', (request, reply) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const form = projectForm(objectBody(request.body));
		const result = ctx.db.transaction(() => {
			const snapshot = createSnapshot(ctx, project, form);
			return { project: projectInfo(ctx, getProject(ctx, user, project.id)), snapshot: snapshotInfo(ctx, snapshot), sync: syncState(ctx, project, snapshot, true) };
		});
		return reply.code(result.snapshot.transport === 'blocks' ? 200 : 201).send(result);
	});
	app.get('/project/:projectId/snapshot', (request) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const { page, perPage } = pageQuery(request.query);
		const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM snapshots WHERE project_id=?', project.id)!.n;
		const rows = ctx.db.all<SnapshotRow>('SELECT * FROM snapshots WHERE project_id=? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?', project.id, perPage, (page - 1) * perPage);
		return { items: rows.map((row) => snapshotInfo(ctx, row, true)), pagination: { total, pages: Math.ceil(total / perPage), page, size: perPage } };
	});
	app.get('/project/:projectId/snapshot/:snapshotId', (request) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		return snapshotInfo(ctx, getSnapshot(ctx, project, ids(request).snapshotId), true);
	});
	app.get('/project/:projectId/snapshot/:snapshotId/sync', (request) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		return syncState(ctx, project, getSnapshot(ctx, project, ids(request).snapshotId), true, 'upper');
	});
	app.post('/project/:projectId/snapshot/:snapshotId/sync', (request, reply) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const snapshot = getSnapshot(ctx, project, ids(request).snapshotId);
		const result = completeSnapshot(ctx, project, snapshot);
		return snapshot.format === 'audacity' ? reply.code(204).send() : result;
	});
	app.delete('/project/:projectId/snapshot/:snapshotId', async (request, reply) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const snapshot = getSnapshot(ctx, project, ids(request).snapshotId);
		if (project.synced_id === snapshot.id || (project.head_id === snapshot.id && snapshot.synced) || ctx.db.get('SELECT id FROM snapshots WHERE project_id=? AND (parent_id=? OR previous_head_id=?)', project.id, snapshot.id, snapshot.id)) throw new ApiError(409, 'A current synchronized snapshot or ancestor cannot be deleted.', 'ProjectVersionConflict');
		ctx.db.transaction(() => {
			ctx.db.run('DELETE FROM snapshots WHERE id=?', snapshot.id);
			if (project.head_id === snapshot.id) {
				const previousHead = snapshot.previous_head_id || project.synced_id;
				if (previousHead || snapshot.format === 'audacity') ctx.db.run('UPDATE projects SET head_id=?,updated=? WHERE id=?', previousHead, now(), project.id);
				else ctx.db.run('DELETE FROM projects WHERE id=?', project.id);
			}
		});
		await ctx.blobs.remove(snapshot.file_id); await ctx.blobs.remove(snapshot.mixdown_id);
		await collectUnusedBlocks(ctx, user.id);
		return reply.code(204).send();
	});
	app.delete('/project/:projectId', async (request, reply) => {
		const user = ctx.auth.requireUser(request, 'projects'); const project = getProject(ctx, user, ids(request).projectId);
		const snapshots = ctx.db.all<SnapshotRow>('SELECT * FROM snapshots WHERE project_id=?', project.id);
		ctx.db.run('DELETE FROM projects WHERE id=?', project.id);
		for (const snapshot of snapshots) { await ctx.blobs.remove(snapshot.file_id); await ctx.blobs.remove(snapshot.mixdown_id); }
		await collectUnusedBlocks(ctx, user.id);
		return reply.code(204).send();
	});
}
