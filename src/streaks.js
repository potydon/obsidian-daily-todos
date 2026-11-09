import { TFile, normalizePath, editorInfoField, editorLivePreviewField, setIcon, setTooltip } from 'obsidian';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';

import {
	HABIT_TAG_REGEX,
	HABIT_TAG_REGEX_GLOBAL,
	TASK_LINE_REGEX,
	habit_name,
	find_habit_state,
	is_checked_line
} from './note_utils';

// The cached value is the streak of the days *before* the note being rendered,
// keyed by "<note path>|<habit name>". The note's own checkbox is applied on
// top of it, so toggling today's box never needs a vault read: the value is
// recomputed from the checkbox state the moment it changes.
//
// When the vault changes, entries are marked stale instead of deleted. Live
// preview keeps rendering the old value while a fresh one is computed in the
// background, so the pill never disappears or flickers.
const PAST_CACHE = new Map();
const PENDING = new Set();

// Live preview widgets can only be drawn once a value exists, so remember the
// editor views that need a repaint when a background computation finishes.
const ACTIVE_VIEWS = new Set();
const REFRESH_EFFECT = StateEffect.define();

export function clear_streak_cache() {
	for (const entry of PAST_CACHE.values()) {
		entry.stale = true;
	}
}

export function refresh_live_preview_streaks() {
	for (const view of ACTIVE_VIEWS) {
		view.dispatch({effects: REFRESH_EFFECT.of(null)});
	}
}

function cache_key(file, name) {
	return `${file.path}|${name}`;
}

// Parses the date of a daily note from its path.
function get_note_moment(plugin, file) {
	const note_path = plugin.settings.note_path || "";
	let relative = file.path;
	if (note_path && file.path.startsWith(note_path)) {
		relative = file.path.slice(note_path.length + 1);
	}
	relative = relative.replace(/\.md$/, "");
	const parsed = window.moment(relative, plugin.settings.date_format, true);
	return parsed.isValid() ? parsed : null;
}

// Counts consecutive completed days strictly before the note's own date. The
// walk stops as soon as a note is missing, does not contain the habit, or
// contains it unchecked.
async function compute_past_uncached(plugin, file, name) {
	const note_date = get_note_moment(plugin, file);
	if (!note_date) return 0;

	const note_path = plugin.settings.note_path;
	if (!note_path) return 0;

	let streak = 0;
	let cursor = note_date.clone().startOf('day').subtract(1, 'day');
	const visited = new Set();
	// 10 years is a generous upper bound and guarantees termination.
	for (let guard = 0; guard < 3660; guard++) {
		const relative = cursor.format(plugin.settings.date_format);
		const path = normalizePath(`${note_path}/${relative}.md`);
		// If the date format does not include the day, several days map to the
		// same note; stop instead of counting it more than once.
		if (visited.has(path)) break;
		visited.add(path);

		const abstract = plugin.app.vault.getAbstractFileByPath(path);
		if (!(abstract instanceof TFile)) break;

		const content = await plugin.app.vault.cachedRead(abstract);
		const state = find_habit_state(content, name);
		if (!state.found || !state.checked) break;

		streak += 1;
		cursor = cursor.subtract(1, 'day');
	}

	return streak;
}

async function get_past(plugin, file, name) {
	const key = cache_key(file, name);
	const entry = PAST_CACHE.get(key);
	if (entry && !entry.stale) return entry.value;

	const value = await compute_past_uncached(plugin, file, name);
	PAST_CACHE.set(key, {value, stale: false});
	return value;
}

// Returns the cached past streak immediately, scheduling a background refresh
// when the entry is missing or stale.
function get_past_or_schedule(plugin, file, name) {
	const key = cache_key(file, name);
	const entry = PAST_CACHE.get(key);
	if (!entry) {
		schedule_past(plugin, file, name);
		return null;
	}
	if (entry.stale) {
		schedule_past(plugin, file, name);
	}
	return entry.value;
}

function schedule_past(plugin, file, name) {
	const key = cache_key(file, name);
	if (PENDING.has(key)) return;
	PENDING.add(key);
	get_past(plugin, file, name)
		.then(() => refresh_live_preview_streaks())
		.finally(() => PENDING.delete(key));
}

const FLAME_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;

function render_flame_icon(container) {
	if (typeof setIcon === 'function') {
		try {
			setIcon(container, 'flame');
		} catch (e) {
			// fallback below
		}
	}
	if (!container.querySelector('svg')) {
		container.innerHTML = FLAME_ICON_SVG;
	}
}

function badge_label(streak) {
	return `${streak} day${streak === 1 ? '' : 's'} streak`;
}

// Colour tiers, keyed by the lowest streak that reaches them. 0-29 stays in
// the muted gray tier, then 30 yellow, 90 orange, 365 red and 1000 purple.
function streak_tier(streak) {
	if (streak >= 1000) return '1000';
	if (streak >= 365) return '365';
	if (streak >= 90) return '90';
	if (streak >= 30) return '30';
	return '0';
}

function apply_badge(badge, streak, checked) {
	let icon = badge.querySelector('.habit-streak-icon');
	if (!icon) {
		icon = document.createElement('span');
		icon.className = 'habit-streak-icon';
		icon.setAttribute('aria-hidden', 'true');
		render_flame_icon(icon);
		badge.appendChild(icon);
	}
	let count = badge.querySelector('.habit-streak-count');
	if (!count) {
		count = document.createElement('span');
		count.className = 'habit-streak-count';
		badge.appendChild(count);
	}
	count.textContent = String(streak);

	const label = badge_label(streak);
	setTooltip(badge, label, {placement: 'top'});
	badge.setAttribute('data-streak', String(streak));
	badge.setAttribute('data-tier', streak_tier(streak));
	// Unticked today: the pill stays a darker grey whatever the tier, so a
	// pending habit is visually distinct from one that is already done.
	badge.setAttribute('data-state', checked ? 'checked' : 'open');
	badge.classList.toggle('is-zero', streak === 0);
}

function make_badge(streak, checked) {
	const badge = document.createElement('span');
	badge.className = 'habit-streak';
	apply_badge(badge, streak, checked);
	return badge;
}

function update_badge(badge, streak, checked) {
	apply_badge(badge, streak, checked);
}

// Extracts the text of a rendered task item without the checkbox, the badge, or
// any nested list content.
function extract_inline_text(li) {
	const clone = li.cloneNode(true);
	clone.querySelectorAll('input, ul, ol, .habit-streak').forEach((node) => node.remove());
	return clone.textContent || "";
}

// Finds the rendered `!STREAK` text that belongs to this list item itself
// (nested list items and previously rendered pills are ignored). Reading view
// leaves the tag as plain text, so this walks the item's own text nodes.
function own_streak_occurrences(li) {
	const occurrences = [];
	const walk = (node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.ELEMENT_NODE) {
				if (child.tagName === "UL" || child.tagName === "OL") continue;
				if (child.classList && child.classList.contains("habit-streak")) continue;
				walk(child);
			} else if (child.nodeType === Node.TEXT_NODE) {
				const text = child.nodeValue || "";
				HABIT_TAG_REGEX_GLOBAL.lastIndex = 0;
				let match;
				while ((match = HABIT_TAG_REGEX_GLOBAL.exec(text)) !== null) {
					occurrences.push({
						node: child,
						index: match.index,
						length: match[0].length
					});
				}
			}
		}
	};
	walk(li);
	return occurrences;
}

// Splits a text node around an occurrence and inserts `replacement` there.
// When `replacement` is null the matched text is simply removed.
function replace_occurrence(occurrence, replacement) {
	const {node, index, length} = occurrence;
	const text = node.nodeValue || "";
	const after = text.slice(index + length);
	node.nodeValue = text.slice(0, index);
	const parent = node.parentNode;
	if (!parent) return;
	const after_node = after ? document.createTextNode(after) : null;
	if (after_node) parent.insertBefore(after_node, node.nextSibling);
	if (replacement) {
		parent.insertBefore(replacement, after_node || node.nextSibling);
	}
}

// Replaces the first `!STREAK` on the item with the pill and hides any extras,
// matching the live preview behaviour. Returns false when the rendered text
// does not contain the tag (so the caller can fall back to appending).
function place_badge_on_tag(li, badge) {
	const occurrences = own_streak_occurrences(li);
	if (occurrences.length === 0) return false;

	// Work backwards so earlier offsets in a shared text node stay valid.
	for (let i = occurrences.length - 1; i >= 1; i--) {
		replace_occurrence(occurrences[i], null);
	}
	replace_occurrence(occurrences[0], badge);
	return true;
}

function append_badge(li, badge) {
	const children = Array.from(li.children);
	const nested = children.find((child) => child.tagName === "UL" || child.tagName === "OL");
	const paragraph = children.find((child) => child.tagName === "P" || child.tagName === "DIV");
	if (paragraph) {
		paragraph.appendChild(badge);
	} else if (nested) {
		li.insertBefore(badge, nested);
	} else {
		li.appendChild(badge);
	}
}

// Removes badges added by earlier post-processor runs from this item only, so
// nested child tasks keep their own pills.
function remove_own_badges(li) {
	for (const child of Array.from(li.children)) {
		if (child.classList.contains("habit-streak")) child.remove();
	}
	for (const child of Array.from(li.children)) {
		if (child.tagName !== "UL" && child.tagName !== "OL") {
			for (const badge of Array.from(child.querySelectorAll(".habit-streak"))) {
				badge.remove();
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Reading view
// ---------------------------------------------------------------------------
function register_reading_view_streaks(plugin) {
	// Keeps a single observer/listener set per rendered item, even if the
	// post-processor runs again over the same DOM.
	const cleanup_by_item = new WeakMap();

	plugin.registerMarkdownPostProcessor(async (el, ctx) => {
		if (!plugin.settings.note_path) return;

		const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		const tasks = Array.from(el.querySelectorAll('li.task-list-item'))
			.filter((li) => li.querySelector('input[type="checkbox"]'));

		const rendered = [];
		const names = new Set();
		for (const li of tasks) {
			const text = extract_inline_text(li);
			if (!HABIT_TAG_REGEX.test(text)) continue;
			const name = habit_name(text);
			if (!name) continue;

			const input = li.querySelector('input[type="checkbox"]');
			rendered.push({li, name, input});
			names.add(name);
		}
		if (rendered.length === 0) return;

		const past = new Map();
		await Promise.all(Array.from(names).map(async (name) => {
			past.set(name, await get_past(plugin, file, name).catch(() => 0));
		}));

		for (const {li, name, input} of rendered) {
			// Reading view rewrites `data-task` when the box changes. Prefer it
			// over `input.checked`, which still holds the pre-click value until
			// Obsidian's own timeout runs. Depending on the renderer the
			// attribute sits on the list item or on the paragraph wrapping it.
			const task_el = (input && input.closest && input.closest('[data-task]')) || li;
			const checked = () => {
				const task = task_el.getAttribute('data-task');
				if (task !== null && task !== '') {
					return task.toLowerCase() === 'x';
				}
				return !!(input && input.checked);
			};
			const streak = () => past.get(name) + (checked() ? 1 : 0);

			remove_own_badges(li);

			const badge = make_badge(streak(), checked());
			if (!place_badge_on_tag(li, badge)) {
				append_badge(li, badge);
			}

			// Update as soon as the checkbox is toggled, without waiting for the
			// note to be saved and re-rendered. The observer fires once Obsidian
			// has written the new state back to the item; the timer is a fallback
			// for platforms that only touch the input itself.
			const refresh = () => update_badge(badge, streak(), checked());
			const schedule = () => setTimeout(refresh, 0);
			let observer = null;
			if (typeof MutationObserver === 'function') {
				observer = new MutationObserver(refresh);
				observer.observe(task_el, {attributes: true, attributeFilter: ['data-task']});
			}
			if (input) {
				input.addEventListener('click', schedule);
				input.addEventListener('change', schedule);
			}

			const previous_cleanup = cleanup_by_item.get(li);
			if (previous_cleanup) previous_cleanup();
			cleanup_by_item.set(li, () => {
				if (observer) observer.disconnect();
				if (input) {
					input.removeEventListener('click', schedule);
					input.removeEventListener('change', schedule);
				}
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------
class StreakWidget extends WidgetType {
	constructor(streak, checked) {
		super();
		this.streak = streak;
		this.checked = checked;
	}

	eq(other) {
		return other.streak === this.streak && other.checked === this.checked;
	}

	toDOM() {
		return make_badge(this.streak, this.checked);
	}

	// Let clicks on the pill move the caret like normal text would.
	ignoreEvent() {
		return false;
	}
}

function editor_file(view) {
	const info = view.state.field(editorInfoField, false);
	return info && info.file instanceof TFile ? info.file : null;
}

// The raw tag is revealed while the selection sits on the tag itself, the same
// way live preview reveals a task's `- [ ]` marker. The tag's own boundaries
// count as inside (a caret on the `#` reveals it), but the space before or
// after it does not. The rest of the time the pill replaces the tag.
function selection_reveals_tag(state, from, to) {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function register_live_preview_streaks(plugin) {
	class HabitStreakViewPlugin {
		constructor(view) {
			this.view = view;
			this.decorations = Decoration.none;
			ACTIVE_VIEWS.add(view);
			this.rebuild();
		}

		destroy() {
			ACTIVE_VIEWS.delete(this.view);
		}

		update(update) {
			const forced = update.transactions.some((tr) =>
				tr.effects.some((effect) => effect.is(REFRESH_EFFECT)));
			const mode_changed = update.startState.field(editorLivePreviewField, false)
				!== update.state.field(editorLivePreviewField, false);
			// selectionSet matters because the raw tag is revealed while the
			// selection touches it; without it, typing !STREAK and then moving
			// the caret would never repaint the pill.
			if (update.docChanged || update.selectionSet || update.viewportChanged
				|| forced || mode_changed) {
				this.rebuild();
			}
		}

		rebuild() {
			const view = this.view;
			const file = editor_file(view);
			const live_preview = view.state.field(editorLivePreviewField, false);
			if (!plugin.settings.note_path || !file || !live_preview) {
				this.decorations = Decoration.none;
				return;
			}

			const builder = new RangeSetBuilder();
			for (const range of view.visibleRanges) {
				let pos = range.from;
				while (pos <= range.to) {
					const line = view.state.doc.lineAt(pos);
					this.decorate_line(builder, file, line);
					pos = line.to + 1;
				}
			}
			this.decorations = builder.finish();
		}

		decorate_line(builder, file, line) {
			const text = line.text;
			if (!HABIT_TAG_REGEX.test(text) || !TASK_LINE_REGEX.test(text)) return;

			const name = habit_name(text);
			if (!name) return;

			// The note's own checkbox is read straight from the editor, so the
			// pill changes the instant the box is toggled.
			const streak_base = is_checked_line(text) ? 1 : 0;
			const past = get_past_or_schedule(plugin, file, name);
			if (past === null) return;

			const streak = streak_base + past;

			HABIT_TAG_REGEX_GLOBAL.lastIndex = 0;
			let first = true;
			let match;
			while ((match = HABIT_TAG_REGEX_GLOBAL.exec(text)) !== null) {
				const from = line.from + match.index;
				const to = from + match[0].length;
				// Keep the tag visible while the selection is on it so it can be
				// edited; otherwise the pill takes its place.
				if (selection_reveals_tag(this.view.state, from, to)) continue;

				if (first) {
					// A replace decoration keeps the caret outside the pill, so a
					// caret at the end of the line is drawn after it.
					builder.add(from, to, Decoration.replace({
						widget: new StreakWidget(streak, streak_base === 1)
					}));
					first = false;
				} else {
					// Any further !STREAK tags on the line are hidden silently.
					builder.add(from, to, Decoration.replace({}));
				}
			}
		}
	}

	plugin.registerEditorExtension(ViewPlugin.fromClass(HabitStreakViewPlugin, {
		decorations: (value) => value.decorations
	}));
}

export function register_habit_streaks(plugin) {
	register_reading_view_streaks(plugin);
	register_live_preview_streaks(plugin);
}
