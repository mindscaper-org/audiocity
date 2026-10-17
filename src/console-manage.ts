/** Spreadsheet interaction stays in the browser; a save sends one atomic metadata batch. */
export const consoleManage = String.raw`
	const manageColumns = [
		['title', 'Title'], ['slug', 'Slug'], ['category', 'Category'], ['tags', 'Tags'],
		['description', 'Description'], ['license', 'License'], ['visibility', 'Visibility'], ['is_downloadable', 'Downloadable']
	];
	const manageRows = [];
	const manageDrafts = new Map();
	let managePage = 0;
	let manageHasNext = true;
	let manageSelection = { anchor: [0, 0], focus: [0, 0] };
	let manageUndo = [];
	let manageRedo = [];
	let manageSaving = false;
	let manageGeneration = 0;
	function resetManage() { manageGeneration++; manageRows.splice(0); manageDrafts.clear(); managePage = 0; manageHasNext = true; manageUndo = []; manageRedo = []; }
	function invalidateManage() { if (!manageDrafts.size) resetManage(); }
	function rawValue(item, key) {
		if (key === 'tags') return item.tags.join(', ');
		if (key === 'is_downloadable') return String(item.is_downloadable);
		if (key === 'license' && item.license === 'none') return 'arr';
		return String(item[key] ?? '');
	}
	function cellValue(row, col) { const item = manageRows[row]; const key = manageColumns[col][0]; return manageDrafts.get(item.id)?.[key] ?? rawValue(item, key); }
	function cellEditable(row, col) { return editable(manageRows[row]) && !(manageRows[row].origin === 'shared-folder' && ['visibility', 'is_downloadable'].includes(manageColumns[col][0])); }
	function selectedBounds() {
		const a = manageSelection.anchor; const b = manageSelection.focus;
		return { top: Math.min(a[0], b[0]), bottom: Math.max(a[0], b[0]), left: Math.min(a[1], b[1]), right: Math.max(a[1], b[1]) };
	}
	function parseTsv(text) {
		const rows = []; let row = []; let value = ''; let quoted = false; let closed = false;
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			if (quoted) {
				if (char === '"') { if (text[index + 1] === '"') { value += '"'; index++; } else { quoted = false; closed = true; } }
				else value += char;
			} else if (char === '"' && value === '' && !closed) quoted = true;
			else if (char === '\t') { row.push(value); value = ''; closed = false; }
			else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; row.push(value); rows.push(row); row = []; value = ''; closed = false; }
			else { if (closed) throw new Error('Invalid quoted clipboard data.'); value += char; }
		}
		if (quoted) throw new Error('The clipboard contains an unclosed quoted field.');
		if (row.length || value !== '' || !rows.length) { row.push(value); rows.push(row); }
		const width = rows[0].length;
		if (rows.some(row => row.length !== width)) throw new Error('Paste a rectangular range of cells.');
		return rows;
	}
	function tsvValue(value) { return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value; }
	function currentSelectionTsv() {
		const range = selectedBounds(); const rows = [];
		for (let row = range.top; row <= range.bottom; row++) { const values = []; for (let col = range.left; col <= range.right; col++) values.push(tsvValue(cellValue(row, col))); rows.push(values.join('\t')); }
		return rows.join('\r\n');
	}
	function changeCells(changes, remember = true) {
		if (manageSaving) throw new Error('Wait for the current save to finish before editing.');
		if (changes.some(([row, col]) => !cellEditable(row, col))) throw new Error('This range contains read-only cells. Select only fields you can edit.');
		const previous = changes.map(([row, col]) => [row, col, cellValue(row, col)]);
		if (remember) { manageUndo.push(previous); manageRedo = []; }
		for (const [row, col, value] of changes) {
			const item = manageRows[row]; const key = manageColumns[col][0]; const draft = { ...(manageDrafts.get(item.id) || {}) };
			if (value === rawValue(item, key)) delete draft[key]; else draft[key] = value;
			if (Object.keys(draft).length) manageDrafts.set(item.id, draft); else manageDrafts.delete(item.id);
		}
		refreshGrid();
	}
	function pasteCells(text) {
		const values = parseTsv(text); const range = selectedBounds(); const changes = [];
		const height = values.length === 1 && values[0].length === 1 ? range.bottom - range.top + 1 : values.length;
		const width = values.length === 1 && values[0].length === 1 ? range.right - range.left + 1 : values[0].length;
		if (range.top + height > manageRows.length || range.left + width > manageColumns.length) throw new Error('The pasted range exceeds the loaded table. Load more files or select a smaller range.');
		for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) changes.push([range.top + row, range.left + col, values.length === 1 && values[0].length === 1 ? values[0][0] : values[row][col]]);
		changeCells(changes);
		manageSelection = { anchor: [range.top, range.left], focus: [range.top + height - 1, range.left + width - 1] }; refreshSelection();
	}
	function gridCell(row, col) { return workspace.querySelector('[role="gridcell"][data-row="' + row + '"][data-col="' + col + '"]'); }
	function refreshSelection(focus = false) {
		const range = selectedBounds();
		workspace.querySelectorAll('[role="gridcell"]').forEach(cell => {
			const row = Number(cell.dataset.row); const col = Number(cell.dataset.col);
			cell.setAttribute('aria-selected', String(row >= range.top && row <= range.bottom && col >= range.left && col <= range.right));
			cell.tabIndex = row === manageSelection.focus[0] && col === manageSelection.focus[1] ? 0 : -1;
		});
		if (focus) gridCell(...manageSelection.focus)?.focus({ preventScroll: false });
	}
	function refreshGrid() {
		workspace.querySelectorAll('[role="gridcell"]').forEach(cell => {
			const row = Number(cell.dataset.row); const col = Number(cell.dataset.col); const key = manageColumns[col][0];
			if (!cell.querySelector('input,textarea')) cell.textContent = cellValue(row, col) || ' ';
			cell.classList.toggle('dirty', Boolean(manageDrafts.get(manageRows[row].id) && key in manageDrafts.get(manageRows[row].id)));
		});
		const status = document.getElementById('manage-changes');
		if (status) status.textContent = manageRows.length + ' files loaded. ' + (manageDrafts.size ? manageDrafts.size + ' file(s) with unsaved changes.' : 'All changes saved.');
		const save = document.getElementById('manage-save'); if (save) save.disabled = manageSaving || !manageDrafts.size;
		const cancel = document.getElementById('manage-cancel'); if (cancel) cancel.disabled = manageSaving || !manageDrafts.size;
		refreshSelection();
	}
	function selectCell(row, col, extend = false) {
		row = Math.max(0, Math.min(manageRows.length - 1, row)); col = Math.max(0, Math.min(manageColumns.length - 1, col));
		if (!extend) manageSelection.anchor = [row, col]; manageSelection.focus = [row, col]; refreshSelection(true);
	}
	function editCell(row, col, initial) {
		if (manageSaving) return;
		if (!cellEditable(row, col)) { tell('This field is read only.', true); return; }
		const cell = gridCell(row, col); if (!cell || cell.querySelector('input,textarea')) return;
		const key = manageColumns[col][0]; const input = node(key === 'description' ? 'textarea' : 'input');
		if (key !== 'description') input.type = 'text'; input.value = initial === undefined ? cellValue(row, col) : initial;
		input.setAttribute('aria-label', manageColumns[col][1] + ' for ' + manageRows[row].title);
		if (['category', 'license', 'visibility', 'is_downloadable'].includes(key)) input.setAttribute('list', 'grid-options-' + key);
		cell.replaceChildren(input); input.focus(); if (initial === undefined) input.select();
		let done = false;
		const finish = (save, fill = false) => {
			if (done) return; done = true; const value = input.value; cell.replaceChildren(node('span', cellValue(row, col) || ' '));
			if (save) {
				const range = fill ? selectedBounds() : { top: row, bottom: row, left: col, right: col }; const changes = [];
				for (let r = range.top; r <= range.bottom; r++) for (let c = range.left; c <= range.right; c++) changes.push([r, c, value]);
				try { changeCells(changes); } catch (error) { fail(error); refreshGrid(); }
			} else refreshGrid();
		};
		on(input, 'blur', () => finish(true));
		on(input, 'keydown', event => {
			event.stopPropagation();
			if (event.key === 'Escape') { event.preventDefault(); finish(false); cell.focus(); }
			if (event.key === 'Enter' && key === 'description' && event.shiftKey) return;
			if (event.key === 'Enter') { event.preventDefault(); finish(true, event.ctrlKey || event.metaKey); if (event.ctrlKey || event.metaKey) refreshSelection(true); else selectCell(row + (event.shiftKey ? -1 : 1), col); }
			if (event.key === 'Tab') { event.preventDefault(); finish(true); let next = row * manageColumns.length + col + (event.shiftKey ? -1 : 1); next = Math.max(0, Math.min(manageRows.length * manageColumns.length - 1, next)); selectCell(Math.floor(next / manageColumns.length), next % manageColumns.length); }
		});
	}
	function gridKey(event) {
		if (event.target.closest('input,textarea')) return;
		const row = manageSelection.focus[0]; const col = manageSelection.focus[1]; const range = selectedBounds(); const modified = event.ctrlKey || event.metaKey;
		if (modified && ['c', 'v', 'a'].includes(event.key.toLowerCase())) {
			if (event.key.toLowerCase() === 'a') { event.preventDefault(); manageSelection = { anchor: [0, 0], focus: [manageRows.length - 1, manageColumns.length - 1] }; refreshSelection(true); }
			return;
		}
		if (modified && ['z', 'y'].includes(event.key.toLowerCase())) {
			event.preventDefault(); const undo = event.key.toLowerCase() === 'z' && !event.shiftKey; const from = undo ? manageUndo : manageRedo; const to = undo ? manageRedo : manageUndo; const changes = from.pop();
			if (changes) { to.push(changes.map(([r, c]) => [r, c, cellValue(r, c)])); changeCells(changes, false); } return;
		}
		if (modified && ['d', 'r'].includes(event.key.toLowerCase())) {
			event.preventDefault(); const changes = [];
			for (let r = range.top; r <= range.bottom; r++) for (let c = range.left; c <= range.right; c++) { if (event.key.toLowerCase() === 'd' ? r > range.top : c > range.left) changes.push([r, c, cellValue(event.key.toLowerCase() === 'd' ? range.top : r, event.key.toLowerCase() === 'r' ? range.left : c)]); }
			if (changes.length) changeCells(changes); return;
		}
		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) {
			event.preventDefault(); let r = row; let c = col;
			if (event.key === 'ArrowUp') r--; if (event.key === 'ArrowDown') r++; if (event.key === 'ArrowLeft') c--; if (event.key === 'ArrowRight') c++;
			if (event.key === 'Home') { c = 0; if (modified) r = 0; } if (event.key === 'End') { c = manageColumns.length - 1; if (modified) r = manageRows.length - 1; }
			if (event.key === 'Tab') { let next = r * manageColumns.length + c + (event.shiftKey ? -1 : 1); next = Math.max(0, Math.min(manageRows.length * manageColumns.length - 1, next)); r = Math.floor(next / manageColumns.length); c = next % manageColumns.length; }
			selectCell(r, c, event.shiftKey && event.key !== 'Tab'); return;
		}
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault(); const changes = []; for (let r = range.top; r <= range.bottom; r++) for (let c = range.left; c <= range.right; c++) changes.push([r, c, '']); changeCells(changes); return;
		}
		if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); editCell(row, col); return; }
		if (!modified && !event.altKey && event.key.length === 1) { event.preventDefault(); editCell(row, col, event.key); }
	}
	function normalizeDraft(key, value, options) {
		if (key === 'tags') return value.split(',').map(tag => tag.trim()).filter(Boolean);
		if (key === 'is_downloadable') {
			if (['true', 'yes', '1'].includes(value.toLowerCase())) return true;
			if (['false', 'no', '0'].includes(value.toLowerCase())) return false;
			throw new Error('Downloadable must be true or false.');
		}
		if (key === 'category' || key === 'license') {
			const choices = key === 'category' ? options.categories : options.licenses;
			const found = choices.find(option => option.id === value || option.name.toLowerCase() === value.toLowerCase());
			if (!found) throw new Error('Choose a valid ' + key + ' from the listed options.'); return found.id;
		}
		return key === 'description' ? value : value.trim();
	}
	async function loadManagePage() {
		const generation = manageGeneration; const accountId = user.id;
		const result = await api('/library/audio?' + new URLSearchParams({ source: 'all', page: managePage + 1, 'per-page': 50 }));
		if (generation !== manageGeneration || user?.id !== accountId) return;
		for (const item of result.items) if (!manageRows.some(row => row.id === item.id)) manageRows.push(item);
		managePage++; manageHasNext = managePage < result.pagination.pages;
	}
	async function refreshManageRows() {
		const generation = manageGeneration; const accountId = user.id;
		const result = await api('/library/audio?source=all&page=1&per-page=50');
		if (generation !== manageGeneration || user?.id !== accountId) return;
		for (const item of result.items) { const index = manageRows.findIndex(row => row.id === item.id); if (index >= 0) manageRows[index] = item; else manageRows.push(item); }
		manageHasNext = managePage < result.pagination.pages;
	}
	async function manageFiles(refresh = true) {
		requireSession(); const accountId = user.id; const view = ++viewGeneration; const options = await libraryOptions(); if (!managePage) await loadManagePage(); else if (refresh) await refreshManageRows();
		if (view !== viewGeneration || user?.id !== accountId) return;
		begin('Manage files');
		workspace.append(node('p', 'Edit audio metadata in a table. Shared files show read-only fields unless you have permission to edit them. Project revisions remain in Library → Projects.'));
		const instructions = node('p', 'Click a cell, Shift-click or Shift+arrow to select a range. Arrow keys and Tab move. Enter/F2 or typing edits; Ctrl+Enter fills the selection. Shift+Enter inserts a line in descriptions. Copy/paste spreadsheet cells with Ctrl+C / Ctrl+V. Delete clears; Ctrl+D fills down, Ctrl+R fills right, Ctrl+Z undoes. Save changes applies every edited file together.'); instructions.id = 'grid-help'; instructions.className = 'hint'; workspace.append(instructions);
		const status = node('p'); status.id = 'manage-changes'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); workspace.append(status);
		const toolbar = node('div'); toolbar.className = 'toolbar'; const save = node('button', 'Save changes'); save.id = 'manage-save';
		const cancel = node('button', 'Discard changes'); cancel.id = 'manage-cancel'; toolbar.append(save, cancel, link('Back to library', '/library?tab=audio')); workspace.append(toolbar);
		on(cancel, 'click', () => { manageDrafts.clear(); manageUndo = []; manageRedo = []; refreshGrid(); tell('Unsaved table changes discarded.'); });
		on(save, 'click', async () => {
			const items = Array.from(manageDrafts, ([id, fields]) => { const item = { id }; for (const [key, value] of Object.entries(fields)) item[key] = normalizeDraft(key, value, options); return item; });
			manageSaving = true; refreshGrid();
			try {
				const result = await api('/library/audio/batch', 'PATCH', { items });
				for (const updated of result.items) { const index = manageRows.findIndex(row => row.id === updated.id); if (index >= 0) manageRows[index] = updated; }
				manageDrafts.clear(); manageUndo = []; manageRedo = []; refreshGrid(); tell(items.length + ' file(s) updated.');
			} finally { manageSaving = false; refreshGrid(); }
		});
		if (!manageRows.length) workspace.append(node('p', 'No audio files yet. Use + Upload to add some.'));
		else {
			const wrap = node('div'); wrap.className = 'table-wrap';
			const grid = node('table'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', 'Audio metadata'); grid.setAttribute('aria-describedby', 'grid-help'); grid.setAttribute('aria-multiselectable', 'true'); grid.setAttribute('aria-rowcount', String(manageRows.length + 1)); grid.setAttribute('aria-colcount', String(manageColumns.length + 1));
			const head = node('thead'); const headers = node('tr'); headers.append(node('th', 'File')); for (const [, title] of manageColumns) headers.append(node('th', title)); head.append(headers); grid.append(head);
			const body = node('tbody');
			for (let row = 0; row < manageRows.length; row++) {
				const item = manageRows[row]; const tr = node('tr'); tr.classList.toggle('readonly', !editable(item));
				const heading = node('th', item.name); heading.scope = 'row'; heading.className = 'row-heading'; heading.append(node('small', editable(item) ? item.origin === 'shared-folder' ? 'Shared folder · metadata editable' : 'Your upload' : 'Read only · shared')); tr.append(heading);
				for (let col = 0; col < manageColumns.length; col++) {
					const key = manageColumns[col][0]; const cell = node('td', cellValue(row, col) || ' '); cell.setAttribute('role', 'gridcell'); cell.dataset.row = row; cell.dataset.col = col; cell.dataset.key = key; cell.setAttribute('aria-label', manageColumns[col][1] + ' for ' + item.title); cell.setAttribute('aria-readonly', String(!cellEditable(row, col))); if (!cellEditable(row, col)) cell.title = 'Read only';
					on(cell, 'click', event => { if (!event.target.closest('input,textarea')) selectCell(row, col, event.shiftKey); });
					on(cell, 'dblclick', () => editCell(row, col)); tr.append(cell);
				}
				body.append(tr);
			}
			grid.append(body); wrap.append(grid); workspace.append(wrap);
			on(grid, 'keydown', gridKey);
			on(grid, 'copy', event => { if (event.target.closest('input,textarea')) return; event.preventDefault(); event.clipboardData.setData('text/plain', currentSelectionTsv()); });
			on(grid, 'paste', event => { if (event.target.closest('input,textarea')) return; event.preventDefault(); pasteCells(event.clipboardData.getData('text/plain')); });
			const max = manageRows.length - 1; manageSelection.anchor[0] = Math.min(max, manageSelection.anchor[0]); manageSelection.focus[0] = Math.min(max, manageSelection.focus[0]);
		}
		for (const [key, choices] of [['category', optionPairs(options.categories)], ['license', optionPairs(options.licenses)], ['visibility', visibilityOptions], ['is_downloadable', [['true', 'True'], ['false', 'False']]]]) {
			const list = node('datalist'); list.id = 'grid-options-' + key;
			for (const [id, name] of choices) { const option = node('option', name); option.value = id; list.append(option); } workspace.append(list);
		}
		if (manageHasNext) { const more = node('button', 'Load more files'); on(more, 'click', async () => { const view = viewGeneration; more.disabled = true; try { await loadManagePage(); if (view === viewGeneration && more.isConnected) await manageFiles(false); } finally { more.disabled = false; } }); workspace.append(more); }
		refreshGrid();
	}
	async function manageCategories() {
		requireSession(); if (!user.admin) throw new Error('Administrator access is required.');
		const accountId = user.id; const view = ++viewGeneration; optionsPromise = undefined; const options = await libraryOptions();
		if (view !== viewGeneration || user?.id !== accountId) return;
		begin('Categories');
		workspace.append(node('p', 'Categories are shared by all users. IDs are stable labels used by Audacity and spreadsheet imports. Categories in use must be reassigned before they can be deleted.'));
		const wrap = node('div'); wrap.className = 'table-wrap'; const table = node('table'); table.className = 'category-table'; const head = node('thead'); const headers = node('tr'); for (const text of ['ID', 'Name', 'Actions']) headers.append(node('th', text)); head.append(headers); table.append(head); const body = node('tbody');
		for (const entry of options.categories) {
			const row = node('tr'); row.append(node('td', entry.id)); const label = node('td'); const input = node('input'); input.value = entry.name; input.required = true; input.maxLength = 100; input.setAttribute('aria-label', 'Name for ' + entry.id); label.append(input); row.append(label);
			const actions = node('td'); const save = node('button', 'Save'); save.setAttribute('aria-label', 'Save ' + entry.id);
			on(save, 'click', async () => { await api('/admin/categories/' + encodeURIComponent(entry.id), 'PATCH', { name: input.value.trim() }); optionsPromise = undefined; tell('Category updated.'); });
			const remove = node('button', 'Delete'); remove.disabled = entry.id === 'other'; remove.setAttribute('aria-label', 'Delete ' + entry.id);
			on(remove, 'click', async () => { await api('/admin/categories/' + encodeURIComponent(entry.id), 'DELETE'); invalidateManage(); await manageCategories(); tell('Category deleted.'); }); actions.append(save, remove); row.append(actions); body.append(row);
		}
		table.append(body); wrap.append(table); workspace.append(wrap, node('h2', 'Add category'));
		const form = node('form'); const id = field(form, 'Category ID'); id.required = true; id.maxLength = 64; id.pattern = '[a-z0-9]+(-[a-z0-9]+)*'; const name = field(form, 'Category name'); name.required = true; name.maxLength = 100;
		submit(form, 'Add category', async () => { await api('/admin/categories', 'POST', { id: id.value.trim(), name: name.value.trim() }); await manageCategories(); tell('Category added.'); }); workspace.append(form);
	}
`;
