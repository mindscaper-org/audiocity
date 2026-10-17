import assert from 'node:assert/strict';
import test from 'node:test';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, relative, upload } from './helpers.ts';

interface Created { project: { id: string }; snapshot: { id: string }; sync: { file: UploadDescriptor } }

// Audacity 3's resumed uploader checks only these S3-style query fields.
function cachedUploadExpiry(url: string): number | undefined {
	const query = new URL(url).searchParams;
	const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(query.get('X-Amz-Date') ?? '');
	const ttl = query.get('X-Amz-Expires');
	if (!date || ttl === null) return undefined;
	return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(date[4]), Number(date[5]), Number(date[6])) + Number(ttl) * 1000;
}

await test('Audacity detects expired cached upload URLs and resumes with renewed capabilities', async t => {
	const f = await fixture({ uploadTtlSeconds: 2 }); t.after(() => f.cleanup());
	t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
	const headers = { authorization: `Bearer ${f.token}` };
	const created = (await f.app.inject({ method: 'POST', url: '/project', headers, payload: { name: 'Interrupted upload', blocks: [] } })).json<Created>();
	t.mock.timers.tick(3000);
	const expiry = cachedUploadExpiry(created.sync.file.url);
	assert.ok(expiry !== undefined && expiry < Date.now(), 'the cached URL must trigger Audacity to GET fresh sync descriptors');
	assert.equal(expiry, f.ctx.blobs.get(created.sync.file.id)!.expires * 1000);
	const forged = new URL(created.sync.file.url);
	forged.searchParams.set('X-Amz-Date', '20990101T000000Z');
	assert.equal((await f.app.inject({ method: 'PUT', url: relative(forged.href), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('metadata') })).statusCode, 403, 'expiry hints cannot extend the actual capability');

	const root = `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`;
	const resumed = (await f.app.inject({ url: root, headers })).json<Created['sync']>();
	assert.notEqual(resumed.file.url, created.sync.file.url);
	for (const url of [resumed.file.url, resumed.file.success, resumed.file.fail, resumed.file.progress!]) {
		assert.equal(cachedUploadExpiry(url), f.ctx.blobs.get(resumed.file.id)!.expires * 1000);
	}
	assert.ok(cachedUploadExpiry(resumed.file.url)! > Date.now());
	await upload(f.app, resumed.file, Buffer.from('resumed project metadata'));
	assert.equal((await f.app.inject({ method: 'POST', url: root, headers })).statusCode, 204);
});
