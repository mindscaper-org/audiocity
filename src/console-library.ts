/** Library and audio page code shares the console's small DOM and API helpers. */
export const consoleLibrary = String.raw`
	const visibilityOptions = [['private', 'Private'], ['unlisted', 'Unlisted: direct link'], ['public', 'Public: shared library']];
	const defaultLicenses = [['arr', 'All rights reserved'], ['cc-0', 'CC0 1.0 Universal'], ['cc-by', 'Creative Commons Attribution 4.0'], ['cc-by-sa', 'Creative Commons Attribution-ShareAlike 4.0'], ['cc-by-nc', 'Creative Commons Attribution-NonCommercial 4.0'], ['cc-by-nc-sa', 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0'], ['cc-by-nd', 'Creative Commons Attribution-NoDerivatives 4.0'], ['cc-by-nc-nd', 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0']];
	const defaultCategories = [['music', 'Music'], ['podcast', 'Podcast'], ['voiceover', 'Voiceover'], ['sfx', 'SFX'], ['cover', 'Cover'], ['beats', 'Beats'], ['audiobook', 'Audiobook'], ['recording', 'Recording'], ['other', 'Other']];
	let audioSource;
	let audioQuery = '';
	async function libraryOptions() {
		if (!optionsPromise) {
			const pending = api('/library/options'); optionsPromise = pending;
			pending.catch(() => { if (optionsPromise === pending) optionsPromise = undefined; });
		}
		return optionsPromise;
	}
	function optionPairs(options) { return options.map(option => [option.id, option.name]); }
	function libraryFrame(tab) {
		libraryTab = tab; begin('Library');
		const tabs = node('div'); tabs.className = 'tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Library');
		for (const [id, title] of [['audio', 'Audio'], ['projects', 'Projects']]) {
			const button = node('button', title); button.type = 'button'; button.id = 'tab-' + id;
			button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab === id)); button.setAttribute('aria-controls', 'library-panel');
			button.tabIndex = tab === id ? 0 : -1;
			on(button, 'click', () => go('/library?tab=' + id));
			on(button, 'keydown', async event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'audio' : event.key === 'End' ? 'projects' : id === 'audio' ? 'projects' : 'audio'; await go('/library?tab=' + next); document.getElementById('tab-' + next)?.focus(); } });
			tabs.append(button);
		}
		workspace.append(tabs);
		const panel = node('div'); panel.id = 'library-panel'; panel.className = 'library-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'tab-' + tab); workspace.append(panel);
		return panel;
	}
	function pagination(page, hasNext, load, parent = workspace) {
		if (page === 1 && !hasNext) return;
		const navigation = node('nav'); navigation.className = 'toolbar'; navigation.setAttribute('aria-label', 'Pages'); navigation.append(node('span', 'Page ' + page));
		for (const [label, destination] of [['Previous page', page - 1], ['Next page', page + 1]]) {
			const button = node('button', label); button.type = 'button'; button.disabled = destination < 1 || destination > page && !hasNext;
			on(button, 'click', () => load(destination)); navigation.append(button);
		}
		parent.append(navigation);
	}
	function audioPlaybackPath(item) {
		if (item.origin !== 'shared-folder' && item.username && item.slug) return '/' + encodeURIComponent(item.username) + '/audio/' + encodeURIComponent(item.slug);
		return '/audio/' + encodeURIComponent(item.id) + '/play';
	}
	function editable(item) { return item.can_edit === true || item.can_edit === undefined && user && item.author && item.author.id === user.id; }
	async function audioList(page = 1) {
		requireSession(); const accountId = user.id; const view = ++viewGeneration;
		const preference = await api('/library/preferences');
		if (view !== viewGeneration || user?.id !== accountId) return;
		if (!audioSource) audioSource = preference.include_shared ? 'all' : 'mine';
		const result = await api('/library/audio?' + new URLSearchParams({ source: audioSource, page, 'per-page': 20, q: audioQuery }));
		if (view !== viewGeneration || user?.id !== accountId) return;
		const panel = libraryFrame('audio');
		const toolbar = node('div'); toolbar.className = 'toolbar';
		const source = select(toolbar, 'Files', [['mine', 'My uploads'], ['shared', 'Shared library'], ['all', 'My uploads + shared library']], audioSource);
		on(source, 'change', async () => { audioSource = source.value; await audioList(); });
		const search = node('form'); search.setAttribute('role', 'search'); const query = field(search, 'Search audio', 'search', audioQuery);
		const searchButton = node('button', 'Search'); searchButton.type = 'submit'; search.append(searchButton);
		on(search, 'submit', async () => { audioQuery = query.value.trim(); await audioList(); }); toolbar.append(search); panel.append(toolbar);
		const shared = field(panel, 'Include shared files in Audacity', 'checkbox'); shared.checked = preference.include_shared;
		const hint = node('p', 'Controls whether shared files appear in Audacity’s audio browser. Your uploads are always included.'); hint.className = 'hint'; panel.append(hint);
		on(shared, 'change', async () => { shared.disabled = true; try { await api('/library/preferences', 'PATCH', { include_shared: shared.checked }); tell('Audacity library preference saved.'); } catch (error) { shared.checked = !shared.checked; throw error; } finally { shared.disabled = false; } });
		if (!result.items.length) panel.append(node('p', audioQuery ? 'No audio matches this search.' : audioSource === 'mine' ? 'No audio yet. Use + Upload to add a recording.' : 'No shared audio on this page.'));
		for (const item of result.items) {
			const article = card(item.title, item.status + ' · ' + (item.origin === 'shared-folder' ? 'shared folder' : item.visibility) + ' · ' + item.source.size.toLocaleString() + ' bytes', panel);
			const heading = article.querySelector('h2'); heading.replaceChildren(link(item.title, audioPlaybackPath(item)));
			if (item.description) { const description = node('p', item.description); description.className = 'description'; article.append(description); }
			if (item.tags && item.tags.length) { const tags = node('p'); tags.className = 'tags'; for (const tag of item.tags) { const pill = node('span', tag); pill.className = 'tag'; tags.append(pill); } article.append(tags); }
			const actions = [['Open playback page', () => go(audioPlaybackPath(item))]];
			if (editable(item)) actions.push(['Edit details', () => go('/audio/' + encodeURIComponent(item.id) + '/edit')]);
			if (item.status === 'ready' && (editable(item) || item.is_downloadable)) actions.push(['Download original', () => audioDownload(item)]);
			actionMenu(article, actions);
		}
		pagination(page, page < result.pagination.pages, audioList, panel);
	}
	async function audioDownload(item) {
		if (item.origin === 'shared-folder') { const fresh = await api('/library/audio/' + encodeURIComponent(item.id)); download(fresh.play.url, item.name); return; }
		const result = await api('/download/' + encodeURIComponent(item.id)); download(result.items[0].url, item.name);
	}
	async function getAudio(locator) {
		if (locator.id) return api('/library/audio/' + encodeURIComponent(locator.id));
		return api('/library/audio/resolve?' + new URLSearchParams({ username: locator.username, slug: locator.slug }));
	}
	function metadataList(item, options) {
		const details = node('dl'); details.className = 'metadata';
		const category = (options?.categories || defaultCategories.map(([id, name]) => ({ id, name }))).find(entry => entry.id === item.category)?.name || item.category;
		const license = (options?.licenses || defaultLicenses.map(([id, name]) => ({ id, name }))).find(entry => entry.id === item.license)?.name || (item.license === 'none' ? 'All rights reserved' : item.license);
		for (const [label, value] of [['Uploaded by', item.author_name || item.username || 'Shared folder'], ['Category', category], ['License', license], ['Format', item.source.mime], ['Size', item.source.size.toLocaleString() + ' bytes'], ['Visibility', item.visibility]]) details.append(node('dt', label), node('dd', value));
		return details;
	}
	async function playAudio(locator) {
		const accountToken = token(); let view = ++viewGeneration; const item = await getAudio(locator);
		if (token() !== accountToken || view !== viewGeneration) return;
		begin(item.title); document.title = item.title + ' · Audiocity';
		view = viewGeneration;
		if (user) { const crumbs = node('p'); crumbs.className = 'breadcrumbs'; crumbs.append(link('← Library', '/library?tab=audio')); workspace.append(crumbs); }
		const container = node('div'); workspace.append(container);
		if (item.status === 'ready' && item.play.url) await player(container, { url: safeUrl(item.play.url), mime: item.source.mime, name: item.title });
		else container.append(node('p', 'This audio is not ready for playback.'));
		if (token() !== accountToken || view !== viewGeneration) return;
		if (item.description) { const description = node('p', item.description); description.className = 'description'; workspace.append(description); }
		if (item.tags?.length) { const tags = node('p'); tags.className = 'tags'; for (const tag of item.tags) { const pill = node('span', tag); pill.className = 'tag'; tags.append(pill); } workspace.append(tags); }
		const options = await libraryOptions();
		if (token() !== accountToken || view !== viewGeneration) return;
		workspace.append(metadataList(item, options));
		const toolbar = node('div'); toolbar.className = 'toolbar';
		if (editable(item)) toolbar.append(link('Edit details', '/audio/' + encodeURIComponent(item.id) + '/edit'));
		if (item.is_downloadable || editable(item)) { const button = node('button', 'Download original'); on(button, 'click', () => audioDownload(item)); toolbar.append(button); }
		if (item.visibility === 'public' || item.visibility === 'unlisted') {
			const share = node('a', 'Share link'); share.href = audioPlaybackPath(item); toolbar.append(share);
			const hint = node('p', item.visibility === 'public' ? 'Public audio appears in the shared library.' : 'Anyone with this link can listen.'); hint.className = 'hint'; workspace.append(hint);
		}
		workspace.append(toolbar);
	}
	async function editAudioPage(locator) {
		requireSession(); const accountId = user.id; const view = ++viewGeneration;
		const [item, options] = await Promise.all([getAudio(locator), libraryOptions()]);
		if (view !== viewGeneration || user?.id !== accountId) return;
		if (!editable(item)) throw new Error('You cannot edit this audio.');
		history.replaceState(null, '', '/audio/' + encodeURIComponent(item.id) + '/edit');
		begin('Edit: ' + item.title); const crumbs = node('p'); crumbs.className = 'breadcrumbs'; crumbs.append(link('← Playback page', audioPlaybackPath(item))); workspace.append(crumbs);
		const form = node('form'); const title = field(form, 'Title', 'text', item.title); title.required = true; title.maxLength = 256;
		const slug = field(form, 'Slug', 'text', item.slug); slug.required = true; slug.maxLength = 100; slug.pattern = '[a-z0-9]+(-[a-z0-9]+)*';
		const slugHint = node('small', item.origin === 'shared-folder' ? 'Lowercase letters, numbers, and hyphens.' : 'Lowercase letters, numbers, and hyphens. Changing this changes your share link.'); form.append(slugHint);
		const category = select(form, 'Category', optionPairs(options.categories), item.category);
		const tags = field(form, 'Tags', 'text', item.tags.join(', ')); form.append(node('small', 'Separate tags with commas.'));
		const descriptionLabel = node('label', 'Description'); const description = node('textarea'); description.value = item.description; description.maxLength = 500; descriptionLabel.append(description); form.append(descriptionLabel);
		const license = select(form, 'License', optionPairs(options.licenses), item.license === 'none' ? 'arr' : item.license);
		let visibility; let downloadable;
		if (item.origin !== 'shared-folder') {
			visibility = select(form, 'Visibility', visibilityOptions, item.visibility);
			downloadable = field(form, 'Allow other listeners to download', 'checkbox'); downloadable.checked = item.is_downloadable;
			form.append(node('small', 'Public uploads appear in everyone’s shared library. Unlisted audio is accessible to anyone with its share link.'));
		} else form.append(node('p', 'This file belongs to the shared server folder. The original filename and shared access stay fixed.'));
		submit(form, 'Save details', async () => {
			const body = { title: title.value.trim(), slug: slug.value.trim(), category: category.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean), description: description.value, license: license.value };
			if (visibility) body.visibility = visibility.value;
			if (downloadable) body.is_downloadable = downloadable.checked;
			const updated = await api('/library/audio/' + encodeURIComponent(item.id), 'PATCH', body);
			invalidateManage(item.id); await go(audioPlaybackPath(updated)); tell('Audio details saved.');
		});
		const cancel = link('Cancel', audioPlaybackPath(item)); form.append(cancel); workspace.append(form);
	}
	async function uploadFiles() {
		requireSession(); const accountId = user.id; const view = ++viewGeneration; const options = await libraryOptions(); if (view !== viewGeneration || user?.id !== accountId) return; begin('Upload files');
		workspace.append(node('p', 'Choose audio files or closed AUP3/AUP4 projects. Audio goes into the Audio tab; projects go into Projects. Originals are preserved.'));
		const form = node('form'); const files = field(form, 'Audio or project files', 'file'); files.multiple = true; files.accept = 'audio/*,.wv,.wav,.wave,.mp3,.flac,.aif,.aiff,.aifc,.ogg,.oga,.opus,.m4a,.mp4,.webm,.weba,.aac,.aup3,.aup4'; files.required = true;
		const title = field(form, 'Title (single file, optional)'); title.maxLength = 256;
		const visibility = select(form, 'Audio visibility', visibilityOptions, 'private');
		const category = select(form, 'Audio category', optionPairs(options.categories), 'recording');
		const license = select(form, 'Audio license', optionPairs(options.licenses), 'arr');
		const queue = node('ol'); queue.className = 'upload-queue'; queue.setAttribute('aria-label', 'Upload progress');
		const completed = new WeakSet();
		submit(form, 'Upload files', async () => {
			const sources = Array.from(files.files || []); if (!sources.length) throw new Error('Choose audio or project files.');
			const failures = []; let audioCount = 0; let projectCount = 0; queue.replaceChildren();
			for (const source of sources) {
				const row = node('li', source.name + ' — ' + (completed.has(source) ? 'already uploaded' : 'waiting')); queue.append(row);
				if (completed.has(source)) continue;
				try {
					row.textContent = source.name + ' — uploading…';
					const extension = source.name.split('.').pop().toLowerCase();
					const name = sources.length === 1 && title.value.trim() ? title.value.trim() : source.name.replace(/\.[^.]+$/, '');
					if (['aup3', 'aup4'].includes(extension)) {
						const result = await api('/project', 'POST', { format: extension, size: source.size, name, blocks: [] });
						await transfer(result.sync.file, source); await api('/project/' + encodeURIComponent(result.project.id) + '/snapshot/' + encodeURIComponent(result.snapshot.id) + '/sync', 'POST');
						row.textContent = source.name + ' — saved to Projects'; projectCount++;
					} else {
						const mime = { wav:'audio/wav', wave:'audio/wav', mp3:'audio/mpeg', flac:'audio/flac', wv:'audio/x-wavpack', aif:'audio/aiff', aiff:'audio/aiff', aifc:'audio/aiff', ogg:'audio/ogg', oga:'audio/ogg', opus:'audio/ogg', m4a:'audio/mp4', mp4:'audio/mp4', webm:'audio/webm', weba:'audio/webm', aac:'audio/aac' }[extension] || source.type;
						if (!mime) throw new Error('The audio format could not be identified.');
						const policy = await api('/audio', 'POST', { name: source.name, title: name, mime, size: source.size, category: category.value, visibility: visibility.value, license: license.value, is_downloadable: false });
						await transfer(policy, source); row.textContent = source.name + ' — saved to Audio'; audioCount++;
					}
					completed.add(source); row.dataset.status = 'done';
				} catch (error) { failures.push(source.name + ': ' + error.message); row.dataset.status = 'failed'; row.textContent = source.name + ' — ' + error.message; }
			}
			if (failures.length) { tell('Some files could not be uploaded. Retry keeps the files already completed. ' + failures.join(' '), true); return; }
			invalidateManage();
			if (form.isConnected) await go('/library?tab=' + (projectCount && !audioCount ? 'projects' : 'audio'));
			tell(audioCount + ' audio file(s) and ' + projectCount + ' project(s) uploaded.');
		});
		workspace.append(form, queue);
	}
`;
