import { TFile, editorInfoField, editorLivePreviewField, setIcon, setTooltip } from 'obsidian';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';

import { TASK_LINE_REGEX } from './note_utils';
import { resolve_line, token_pill, start_of_day, format_time } from './due';

// Live preview widgets can only be drawn inside a running editor, so remember
// the views that need repainting when the pill format setting changes.
const ACTIVE_VIEWS = new Set();
const REFRESH_EFFECT = StateEffect.define();

// Lucide icons, used when Obsidian's setIcon is unavailable. The date pill gets
// a calendar-clock, the time pill a plain clock.
const ICON_SVG = {
	'clock': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-clock"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
	'calendar-clock': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-calendar-clock"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.25V14"/><circle cx="16" cy="16" r="6"/></svg>'
};

function render_pill_icon(container, name) {
	if (typeof setIcon === 'function') {
		try {
			setIcon(container, name);
		} catch (e) {
			// fallback below
		}
	}
	if (!container.querySelector('svg')) {
		container.innerHTML = ICON_SVG[name] || '';
	}
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'];

function format_pretty_date(date) {
	return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function alias_date_local(kind, now) {
	if (kind === 'today') return start_of_day(now);
	if (kind === 'tomorrow') {
		const d = start_of_day(now);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
	}
	if (kind === 'yesterday') {
		const d = start_of_day(now);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
	}
	return null;
}

function combine_local(date, time) {
	if (!date) return null;
	if (!time) return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		time.hours,
		time.minutes,
		time.seconds === null ? 0 : time.seconds
	);
}

function get_tooltip(token, resolved, now) {
	if (token.kind === 'completed-only') {
		if (token.completed) {
			const d = new Date(token.completed.year, token.completed.month - 1, token.completed.day);
			return `complete: ${format_pretty_date(d)}`;
		}
	}
	if (token.completed_time) {
		const complete = `complete: ${format_time(token.completed_time)}`;
		if (token.kind === 'time') {
			return `Scheduled time: ${format_time(token.time)}\n${complete}`;
		}
		if (token.kind === 'time-range') {
			return `Scheduled time: ${format_time(token.time)} - ${format_time(token.timeEnd)}\n${complete}`;
		}
		return complete;
	}
	if (token.completed && resolved.date) {
		const due_d = new Date(resolved.date.getFullYear(), resolved.date.getMonth(), resolved.date.getDate());
		const comp_d = new Date(token.completed.year, token.completed.month - 1, token.completed.day);
		return `due date: ${format_pretty_date(due_d)}\ncomplete: ${format_pretty_date(comp_d)}`;
	}
	if (token.completed && !resolved.date && token.kind === 'date') {
		const due_d = new Date(token.date.year, token.date.month - 1, token.date.day);
		const comp_d = new Date(token.completed.year, token.completed.month - 1, token.completed.day);
		return `due date: ${format_pretty_date(due_d)}\ncomplete: ${format_pretty_date(comp_d)}`;
	}
	if (token.completed) {
		const d = new Date(token.completed.year, token.completed.month - 1, token.completed.day);
		return `complete: ${format_pretty_date(d)}`;
	}
	if (token.kind === 'time') {
		const date = resolved.date || start_of_day(now);
		const dt = combine_local(date, token.time);
		const hh = String(dt.getHours()).padStart(2, '0');
		const mm = String(dt.getMinutes()).padStart(2, '0');
		const ss = token.time.seconds !== null ? ':' + String(dt.getSeconds()).padStart(2, '0') : '';
		return `Scheduled time: ${hh}:${mm}${ss}`;
	}
	if (token.kind === 'time-range') {
		const date = resolved.date || start_of_day(now);
		const dt1 = combine_local(date, token.time);
		const dt2 = combine_local(date, token.timeEnd);
		const hh1 = String(dt1.getHours()).padStart(2, '0');
		const mm1 = String(dt1.getMinutes()).padStart(2, '0');
		const ss1 = token.time.seconds !== null ? ':' + String(dt1.getSeconds()).padStart(2, '0') : '';
		const hh2 = String(dt2.getHours()).padStart(2, '0');
		const mm2 = String(dt2.getMinutes()).padStart(2, '0');
		const ss2 = token.timeEnd.seconds !== null ? ':' + String(dt2.getSeconds()).padStart(2, '0') : '';
		return `Scheduled time: ${hh1}:${mm1}${ss1} - ${hh2}:${mm2}${ss2}`;
	}
	if (token.kind === 'upcoming') {
		return 'Upcoming';
	}
	let date = null;
	if (token.kind === 'date') {
		date = new Date(token.date.year, token.date.month - 1, token.date.day);
	} else if (token.kind === 'today' || token.kind === 'tomorrow' || token.kind === 'yesterday') {
		date = alias_date_local(token.kind, now);
	}
	if (date) {
		if (resolved.completed_at && token.completed) {
			const comp_d = new Date(token.completed.year, token.completed.month - 1, token.completed.day);
			return `due date: ${format_pretty_date(date)}\ncomplete: ${format_pretty_date(comp_d)}`;
		}
		return `due date: ${format_pretty_date(date)}`;
	}
	return null;
}

// Aliases (!today, !tomorrow, !yesterday) are relative to the daily note they
// are written in, not to the moment the note happens to be viewed. That keeps
// them stable when a to-do rolls into the next note. Notes outside the daily
// note folder fall back to the real current date.
function note_date(plugin, path) {
	const note_path = plugin.settings.note_path || '';
	if (!note_path || !path || !path.startsWith(note_path + '/')) return null;
	let relative = path.slice(note_path.length + 1).replace(/\.md$/, '');
	const parsed = window.moment(relative, plugin.settings.date_format, true);
	return parsed && parsed.isValid() ? parsed.toDate() : null;
}

function reference_date(plugin, path) {
	return note_date(plugin, path) || new Date();
}

function editor_reference_date(plugin, view) {
	const info = view.state.field(editorInfoField, false);
	const file = info && info.file instanceof TFile ? info.file : null;
	return file ? reference_date(plugin, file.path) : new Date();
}

export function refresh_due_pills() {
	for (const view of ACTIVE_VIEWS) {
		view.dispatch({effects: REFRESH_EFFECT.of(null)});
	}
}

function pill_style(plugin) {
	return {
		text: plugin.settings.due_date_text || 'relative',
		type: plugin.settings.due_date_text_type === 'remaining' ? 'remaining' : 'due',
		format: plugin.settings.due_date_format || 'MMM D, YYYY'
	};
}

function make_due_pill(label, tier, title, icon) {
	const pill = document.createElement('span');
	pill.className = 'due-pill';
	pill.setAttribute('data-tier', tier);
	pill.setAttribute('data-icon', icon);

	const icon_el = document.createElement('span');
	icon_el.className = 'due-pill-icon';
	icon_el.setAttribute('aria-hidden', 'true');
	render_pill_icon(icon_el, icon);
	pill.appendChild(icon_el);

	const text = document.createElement('span');
	text.className = 'due-pill-label';
	text.setText(label);
	pill.appendChild(text);

	if (title) {
		setTooltip(pill, title, {placement: 'top'});
	}
	return pill;
}

// ---------------------------------------------------------------------------
// Reading view
// ---------------------------------------------------------------------------
function is_skipped(element) {
	if (!element || element.nodeType !== 1) return false;
	if (element.tagName === 'CODE' || element.tagName === 'PRE') return true;
	const classes = element.classList;
	return classes && (classes.contains('due-pill') || classes.contains('habit-streak'));
}

function replace_text_node(node, now, style) {
	const text = node.nodeValue || '';
	const resolved = resolve_line(text, now);
	if (!resolved) return;

	const fragment = document.createDocumentFragment();
	let cursor = 0;
	for (const token of resolved.tokens) {
		if (token.from > cursor) {
			fragment.appendChild(document.createTextNode(text.slice(cursor, token.from)));
		}
		const {label, tier, icon} = token_pill(token, resolved, now, style);
		fragment.appendChild(make_due_pill(label, tier, get_tooltip(token, resolved, now), icon));
		cursor = token.to;
	}
	if (cursor < text.length) {
		fragment.appendChild(document.createTextNode(text.slice(cursor)));
	}
	node.parentNode.replaceChild(fragment, node);
}

function render_node(node, now, style) {
	if (node.nodeType === 3) {
		replace_text_node(node, now, style);
		return;
	}
	if (node.nodeType !== 1 || is_skipped(node)) return;
	for (const child of Array.from(node.childNodes)) {
		render_node(child, now, style);
	}
}

// Only the task's own inline text is touched; nested list items render their
// own pills when their turn comes.
function render_task(li, now, style) {
	for (const child of Array.from(li.childNodes)) {
		if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
			continue;
		}
		render_node(child, now, style);
	}
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------
class DuePillWidget extends WidgetType {
	constructor(label, tier, title, icon) {
		super();
		this.label = label;
		this.tier = tier;
		this.title = title;
		this.icon = icon;
	}

	eq(other) {
		return other.label === this.label
			&& other.tier === this.tier
			&& other.title === this.title
			&& other.icon === this.icon;
	}

	toDOM() {
		return make_due_pill(this.label, this.tier, this.title, this.icon);
	}

	ignoreEvent() {
		return true;
	}
}

// The raw token is revealed while the selection touches it, so it stays
// editable; otherwise the pill replaces it.
function selection_reveals(state, from, to) {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

export function register_due_pills(plugin) {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const now = reference_date(plugin, ctx && ctx.sourcePath);
		const style = pill_style(plugin);
		for (const li of Array.from(el.querySelectorAll('li.task-list-item'))) {
			render_task(li, now, style);
		}
	});

	class DuePillViewPlugin {
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
			if (update.docChanged || update.selectionSet || update.viewportChanged
				|| forced || mode_changed) {
				this.rebuild();
			}
		}

		rebuild() {
			const view = this.view;
			if (!view.state.field(editorLivePreviewField, false)) {
				this.decorations = Decoration.none;
				return;
			}

			const now = editor_reference_date(plugin, view);
			const style = pill_style(plugin);
			const builder = new RangeSetBuilder();
			for (const range of view.visibleRanges) {
				let pos = range.from;
				while (pos <= range.to) {
					const line = view.state.doc.lineAt(pos);
					this.decorate_line(builder, line, now, style);
					pos = line.to + 1;
				}
			}
			this.decorations = builder.finish();
		}

		decorate_line(builder, line, now, style) {
			const text = line.text;
			// Due pills belong to to-dos, so leave prose, headings and code
			// blocks alone.
			if (!TASK_LINE_REGEX.test(text)) return;

			const resolved = resolve_line(text, now);
			if (!resolved) return;

			for (const token of resolved.tokens) {
				const from = line.from + token.from;
				const to = line.from + token.to;
				if (selection_reveals(this.view.state, from, to)) continue;
				const {label, tier, icon} = token_pill(token, resolved, now, style);
				builder.add(from, to, Decoration.replace({
					widget: new DuePillWidget(label, tier, get_tooltip(token, resolved, now), icon)
				}));
			}
		}
	}

	plugin.registerEditorExtension(ViewPlugin.fromClass(DuePillViewPlugin, {
		decorations: (value) => value.decorations
	}));
}
