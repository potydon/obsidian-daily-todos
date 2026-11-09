import { TFile } from 'obsidian';

import {
	TASK_LINE_REGEX,
	split_lines,
	task_text
} from './note_utils';
import {
	mark_completed,
	unmark_completed
} from './due';

// The checkbox state character of a task line, lowercased, or null when the
// line is not a task.
function checkbox_state(line) {
	const match = TASK_LINE_REGEX.exec(line);
	return match ? match[2].toLowerCase() : null;
}

function is_completed(state) {
	return state === 'x';
}

// Rewrites only the lines which just changed between checked and unchecked.
//
// Lines are compared by their task text as well as their position, so a line
// that merely shifted (because something above it was added or removed) is not
// mistaken for a completed one.
function annotate_changes(old_lines, new_lines, completed_at, options) {
	let changed = false;
	const result = new_lines.slice();
	const count = Math.min(old_lines.length, new_lines.length);

	for (let i = 0; i < count; i++) {
		const before = old_lines[i];
		const after = new_lines[i];
		if (typeof before !== 'string' || typeof after !== 'string') continue;

		const identity = task_text(before);
		if (identity === null || identity !== task_text(after)) continue;

		const was_completed = is_completed(checkbox_state(before));
		const now_completed = is_completed(checkbox_state(after));
		if (!was_completed && now_completed) {
			const marked = mark_completed(after, completed_at, options);
			if (marked !== after) {
				result[i] = marked;
				changed = true;
			}
		} else if (was_completed && !now_completed) {
			const unmarked = unmark_completed(after);
			if (unmarked !== after) {
				result[i] = unmarked;
				changed = true;
			}
		}
	}

	return changed ? result : null;
}

// The smallest text change needed to turn `before` into `after`. Only the
// completion marker is touched, which keeps the cursor where the user left it
// instead of jumping to the end of the line.
function line_patch(before, after) {
	let start = 0;
	while (start < before.length
		&& start < after.length
		&& before[start] === after[start]) {
		start += 1;
	}
	let end = 0;
	while (end < before.length - start
		&& end < after.length - start
		&& before[before.length - 1 - end] === after[after.length - 1 - end]) {
		end += 1;
	}
	return {
		from: start,
		to: before.length - end,
		text: after.slice(start, after.length - end)
	};
}

// Watches to-dos being completed or reopened and writes the completion day to
// the line. Editor changes are handled immediately; changes that happen outside
// an editor (reading view checkboxes, external edits) are picked up through the
// vault's modify event.
export function register_completion_annotations(plugin) {
	const snapshots = new Map();

	const seed = async (file) => {
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		try {
			const content = await plugin.app.vault.read(file);
			snapshots.set(file.path, split_lines(content).lines);
		} catch (e) {
			// The file may have been removed while we were reading it.
		}
	};

	const apply_update = (file, editor, previous, current, options) => {
		const updated = annotate_changes(previous, current, new Date(), options);
		// Remember the result before touching the editor: applying it fires
		// another editor-change, which must not stamp the same line twice.
		snapshots.set(file.path, updated || current);
		if (!updated) return;

		if (editor) {
			const changes = [];
			for (let i = 0; i < updated.length; i++) {
				if (updated[i] === current[i]) continue;
				const patch = line_patch(current[i], updated[i]);
				changes.push({
					from: {line: i, ch: patch.from},
					to: {line: i, ch: patch.to},
					text: patch.text
				});
			}
			if (changes.length > 0) {
				editor.transaction({changes});
			}
			return;
		}

		// Outside an editor the changes need to be written back to the vault.
		// The caller will perform the vault.modify.
		return updated;
	};

	const handle_editor_change = (editor, info) => {
		const file = info && info.file;
		if (!(file instanceof TFile) || file.extension !== 'md') return;

		const {lines: current} = split_lines(editor.getValue());
		const previous = snapshots.get(file.path);
		if (!previous) {
			snapshots.set(file.path, current);
			return;
		}

		apply_update(file, editor, previous, current, plugin.settings);
	};

	const handle_modify = async (file) => {
		if (!(file instanceof TFile) || file.extension !== 'md') return;

		const previous = snapshots.get(file.path);
		if (!previous) {
			await seed(file);
			return;
		}

		// In source / live-preview mode the editor-change handler already
		// applied the stamp and updated the snapshot, so avoid re-reading and
		// writing there to prevent races. Reading view checkboxes also have an
		// editor attached to their leaf, but never fire editor-change, so they
		// must keep flowing through this vault.modify path. When the same file
		// is open in both modes, the preview leaf wins so clicks there still
		// get stamped.
		const leaves = plugin.app.workspace.getLeavesOfType('markdown')
			.filter((l) => l.view && l.view.file && l.view.file.path === file.path);
		if (leaves.length > 0 && leaves.every((l) => l.view.getMode?.() === 'source')) {
			return;
		}

		let content;
		try {
			content = await plugin.app.vault.read(file);
		} catch (e) {
			return;
		}

		const {lines, eol} = split_lines(content);
		const updated = annotate_changes(previous, lines, new Date(), plugin.settings);
		snapshots.set(file.path, updated || lines);
		if (!updated) return;

		// The write fires another modify event; the snapshot is already up to
		// date, so that pass sees nothing to do.
		await plugin.app.vault.modify(file, updated.join(eol));
	};

	plugin.registerEvent(plugin.app.workspace.on('editor-change', handle_editor_change));
	plugin.registerEvent(plugin.app.workspace.on('file-open', (file) => seed(file)));
	plugin.registerEvent(plugin.app.vault.on('modify', handle_modify));
	plugin.registerEvent(plugin.app.vault.on('create', (file) => seed(file)));
	plugin.registerEvent(plugin.app.vault.on('delete', (file) => {
		if (file && file.path) snapshots.delete(file.path);
	}));
	plugin.registerEvent(plugin.app.vault.on('rename', (file, old_path) => {
		const snapshot = snapshots.get(old_path);
		snapshots.delete(old_path);
		if (snapshot) snapshots.set(file.path, snapshot);
	}));

	// Files which were already open when the plugin loaded never fire
	// file-open, so take their initial snapshot here.
	plugin.app.workspace.onLayoutReady(() => {
		for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
			const file = leaf.view && leaf.view.file;
			if (file instanceof TFile) seed(file);
		}
	});
}
