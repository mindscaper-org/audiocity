import { ApiError, requiredString } from './core.ts';
import type { Database } from './database.ts';

export interface AudioRecord {
	id: string; owner_id: string; blob_id: string; name: string; title: string; slug: string;
	category: string; description: string; tags: string; license: string; visibility: string;
	is_downloadable: number; duration: number; created: number; updated: number;
	origin: 'upload' | 'shared-folder'; shared_path: string; shared_size: number;
	shared_mtime: number; shared_mime: string; shared_present: number;
}

export const defaultCategories = [
	['music', 'Music'], ['podcast', 'Podcast'], ['voiceover', 'Voiceover'], ['sfx', 'SFX'],
	['cover', 'Cover'], ['beats', 'Beats'], ['audiobook', 'Audiobook'], ['recording', 'Recording'], ['other', 'Other'],
] as const;
export const audioLicenses = [
	{ id: 'none', name: 'No license selected' },
	{ id: 'arr', name: 'All rights reserved' }, { id: 'cc-0', name: 'CC0 1.0 — Public domain dedication' },
	{ id: 'cc-by', name: 'Creative Commons Attribution 4.0' },
	{ id: 'cc-by-sa', name: 'Creative Commons Attribution-ShareAlike 4.0' },
	{ id: 'cc-by-nc', name: 'Creative Commons Attribution-NonCommercial 4.0' },
	{ id: 'cc-by-nc-sa', name: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0' },
	{ id: 'cc-by-nd', name: 'Creative Commons Attribution-NoDerivatives 4.0' },
	{ id: 'cc-by-nc-nd', name: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0' },
];
const licenses = new Set(audioLicenses.map(license => license.id));
export const mutableFields = new Set(['title', 'slug', 'category', 'description', 'tags', 'license', 'is_listed', 'is_downloadable', 'visibility', 'public']);

export function initializeAudioSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS audio (
		id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, blob_id TEXT NOT NULL,
		name TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, category TEXT NOT NULL,
		description TEXT NOT NULL, tags TEXT NOT NULL, license TEXT NOT NULL,
		visibility TEXT NOT NULL, is_downloadable INTEGER NOT NULL,
		duration INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL,
		UNIQUE(owner_id, slug)
	);
	CREATE INDEX IF NOT EXISTS audio_owner_created ON audio(owner_id, created);
	CREATE INDEX IF NOT EXISTS audio_visibility ON audio(visibility);
	CREATE TABLE IF NOT EXISTS audio_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS library_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, include_shared INTEGER NOT NULL DEFAULT 1);`);
	const columns = new Set(db.all<{ name: string }>('PRAGMA table_info(audio)').map(row => row.name));
	for (const [name, definition] of [
		['origin', "TEXT NOT NULL DEFAULT 'upload'"], ['shared_path', "TEXT NOT NULL DEFAULT ''"],
		['shared_size', 'INTEGER NOT NULL DEFAULT 0'], ['shared_mtime', 'REAL NOT NULL DEFAULT 0'],
		['shared_mime', "TEXT NOT NULL DEFAULT ''"], ['shared_present', 'INTEGER NOT NULL DEFAULT 0'],
	]) if (!columns.has(name!)) db.exec(`ALTER TABLE audio ADD COLUMN ${name} ${definition}`);
	// Seed once so categories deleted by an administrator stay deleted after restart.
	db.exec('CREATE TABLE IF NOT EXISTS library_migrations (id TEXT PRIMARY KEY)');
	if (!db.get("SELECT id FROM library_migrations WHERE id='categories-v1'")) db.transaction(() => {
		for (const [id, name] of defaultCategories) db.run('INSERT OR IGNORE INTO audio_categories(id,name) VALUES (?,?)', id, name);
		db.run("UPDATE audio SET category='voiceover' WHERE category='voice-over'");
		db.run("UPDATE audio SET category='sfx' WHERE category='sound-design'");
		db.run("INSERT INTO library_migrations(id) VALUES ('categories-v1')");
	});
}

export function boolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new ApiError(422, `${field} must be a boolean.`, 'ValidationError');
	return value;
}

export function audioSlug(value: string): string {
	return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100).replace(/-$/, '') || 'audio';
}

export function validateMetadata(db: Database, body: Record<string, unknown>, current: AudioRecord): AudioRecord {
	const result = { ...current };
	if ('title' in body) result.title = requiredString(body.title, 'title', 256);
	if ('slug' in body) {
		result.slug = requiredString(body.slug, 'slug', 100);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)) throw new ApiError(422, 'slug must contain lowercase letters, numbers, and hyphens.', 'ValidationError');
	}
	if ('description' in body) {
		if (typeof body.description !== 'string' || body.description.length > 500) throw new ApiError(422, 'description must contain at most 500 characters.', 'ValidationError');
		result.description = body.description;
	}
	if ('tags' in body) {
		if (!Array.isArray(body.tags) || body.tags.length > 50) throw new ApiError(422, 'tags must be an array of at most 50 strings.', 'ValidationError');
		result.tags = JSON.stringify([...new Set(body.tags.map(tag => requiredString(tag, 'tag', 64)))]);
	}
	if ('category' in body) {
		const input = requiredString(body.category, 'category', 64);
		const value = input === 'voice-over' ? 'voiceover' : input === 'sound-design' ? 'sfx' : input;
		if (!db.get('SELECT id FROM audio_categories WHERE id=?', value)) throw new ApiError(422, 'Unsupported category.', 'ValidationError');
		result.category = value;
	}
	if ('license' in body) {
		const value = requiredString(body.license, 'license', 32);
		if (!licenses.has(value)) throw new ApiError(422, 'Unsupported license.', 'ValidationError');
		result.license = value;
	}
	if ('is_listed' in body) result.visibility = boolean(body.is_listed, 'is_listed') ? 'public' : 'unlisted';
	if ('public' in body) result.visibility = boolean(body.public, 'public') ? 'public' : 'unlisted';
	if ('visibility' in body) {
		if (typeof body.visibility !== 'string' || !['private', 'unlisted', 'public'].includes(body.visibility)) throw new ApiError(422, 'visibility must be private, unlisted, or public.', 'ValidationError');
		result.visibility = body.visibility;
	}
	if ('is_downloadable' in body) result.is_downloadable = Number(boolean(body.is_downloadable, 'is_downloadable'));
	if (current.origin === 'shared-folder') {
		// Access to the configured folder is a server setting, not per-file publishing.
		result.visibility = 'shared'; result.is_downloadable = 1;
	}
	return result;
}

export function saveMetadata(db: Database, row: AudioRecord, timestamp: number): void {
	db.run('UPDATE audio SET title=?,slug=?,category=?,description=?,tags=?,license=?,visibility=?,is_downloadable=?,updated=? WHERE id=?',
		row.title, row.slug, row.category, row.description, row.tags, row.license, row.visibility, row.is_downloadable, timestamp, row.id);
}
