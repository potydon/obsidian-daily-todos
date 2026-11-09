import { CHECKBOX_REGEX, TASK_LINE_REGEX } from './note_utils';
import type {
	CompletionOptions,
	DateParts,
	DueTextStyle,
	DueTextType,
	DueToken,
	DueTokenKind,
	PillTier,
	ResolvedLine,
	Structure,
	TimeParts,
	TokenPill
} from './types';

// Due date and due time tokens: "!2026-10-10", "!10-12-2026", "!10/12/26",
// "!today", "!tomorrow", "!yesterday", "!upcoming", "!15:30" and "!10:15:30".
// Ranges are supported: "!10:10-11:00".
//
// A completed to-do carries its completion day as an "@" suffix on the due
// date, and its completion time on a due time: "!10/12/2026@12/12/26",
// "!10:00@10:30" and "!12:00-15:00@14:00". To-dos without any due token get
// the completion date twice ("!12/12/26@12/12/26").
//
// The look-behind/look-ahead keep the token out of words and away from other
// exclamation marks, so "wow!today" and "!15:30:00" are handled predictably.
const DATE_SOURCE = '(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}'
	+ '|\\d{1,2}[-/]\\d{1,2}[-/]\\d{4}'
	+ '|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2})';
const TIME_SOURCE = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:-\\d{1,2}:\\d{2}(?::\\d{2})?)?';
const COMPLETION_SOURCE = `(?:@${DATE_SOURCE})?`;
const TIME_COMPLETION_SOURCE = '(?:@\\d{1,2}:\\d{2}(?::\\d{2})?)?';
const ALIAS_SOURCE = '(?:upcoming|today|tomorrow|yesterday)';

const TOKEN_SOURCE =
	'(?<![\\w!])!((?:' + ALIAS_SOURCE + COMPLETION_SOURCE
	+ '|' + DATE_SOURCE + COMPLETION_SOURCE
	+ '|@' + DATE_SOURCE
	+ '|@' + TIME_SOURCE
	+ '|' + TIME_SOURCE + TIME_COMPLETION_SOURCE
	+ '))(?![\\w:])';

const ALIASES = new Set(['upcoming', 'today', 'tomorrow', 'yesterday']);

type MutableDueToken = Omit<DueToken, 'kind'> & { kind: DueTokenKind | null };

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

export function start_of_day(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function end_of_day(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function add_days(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function is_same_month(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// Calendar-day difference, ignoring the time of day. Rounded because DST can
// make a day 23 or 25 hours long.
function day_diff(date: Date, now: Date): number {
	return Math.round((start_of_day(date).getTime() - start_of_day(now).getTime()) / 86400000);
}

function is_this_week(date: Date, now: Date): boolean {
	const today = start_of_day(now);
	const monday_offset = (today.getDay() + 6) % 7;
	const week_start = add_days(today, -monday_offset);
	const week_end = add_days(week_start, 6);
	const day = start_of_day(date);
	return day >= week_start && day <= week_end;
}

function is_next_week(date: Date, now: Date): boolean {
	const today = start_of_day(now);
	const monday_offset = (today.getDay() + 6) % 7;
	const week_start = add_days(today, -monday_offset + 7);
	const week_end = add_days(week_start, 6);
	const day = start_of_day(date);
	return day >= week_start && day <= week_end;
}

function month_index(date: Date): number {
	return date.getFullYear() * 12 + date.getMonth();
}

function is_next_month(date: Date, now: Date): boolean {
	return month_index(date) === month_index(now) + 1;
}

function is_same_year(date: Date, now: Date): boolean {
	return date.getFullYear() === now.getFullYear();
}

function is_next_year(date: Date, now: Date): boolean {
	return date.getFullYear() === now.getFullYear() + 1;
}

// "2026-10-10" / "2026/10/10" (YYYY-MM-DD), "10-12-2026" / "10/12/2026"
// (DD-MM-YYYY) and "10-12-26" / "10/12/26" (DD-MM-YY, two-digit years are 20xx).
export function parse_date_value(value: string): DateParts | null {
	const parts = value.split(/[-/]/).map(Number);
	if (parts.length !== 3) return null;
	let year: number;
	let month: number;
	let day: number;
	if (parts[0] >= 1000) {
		[year, month, day] = parts;
	} else {
		// Anything else is day-month-year, with two- or four-digit years.
		[day, month, year] = parts;
		if (year < 100) year += 2000;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const probe = new Date(year, month - 1, day);
	if (probe.getFullYear() !== year
		|| probe.getMonth() !== month - 1
		|| probe.getDate() !== day) {
		return null;
	}
	return { year, month, day };
}

// "15:30" or "10:15:30".
export function parse_time_value(value: string): TimeParts | null {
	const parts = value.split(':').map(Number);
	if (parts.length !== 2 && parts.length !== 3) return null;
	const [hours, minutes, seconds = null] = parts;
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	if (seconds !== null && (seconds < 0 || seconds > 59)) return null;
	return { hours, minutes, seconds };
}

// Returns every due token in the text, in order. `from`/`to` are offsets into
// the text so the tokens can be replaced with pills. A token may carry a
// completion date (`!date@completed`) or completion time (`!time@completed`),
// which are exposed as `token.completed` and `token.completed_time`.
export function find_due_tokens(text: string): DueToken[] {
	const tokens: DueToken[] = [];
	const pattern = new RegExp(TOKEN_SOURCE, 'gi');
	for (const match of text.matchAll(pattern)) {
		const raw = match[0];
		const value = match[1];
		const index = match.index!;
		const at = value.indexOf('@');
		const head = at === -1 ? value : value.slice(0, at);
		const completed_value = at === -1 ? null : value.slice(at + 1);
		const lower = head.toLowerCase();
		const token: MutableDueToken = {
			from: index,
			to: index + raw.length,
			raw,
			kind: null,
			date: null,
			time: null,
			completed: null,
			completed_time: null
		};
		if (completed_value !== null) {
			if (completed_value.includes(':')) {
				const completed_time = parse_time_value(completed_value);
				if (!completed_time) continue;
				token.completed_time = completed_time;
			} else {
				const completed = parse_date_value(completed_value);
				if (!completed) continue;
				token.completed = completed;
			}
		}
		if (head === '') {
			if (!token.completed && !token.completed_time) continue;
			token.kind = 'completed-only';
		} else if (ALIASES.has(lower)) {
			token.kind = lower as DueTokenKind;
		} else if (head.includes(':')) {
			if (head.includes('-')) {
				const parts = head.split('-');
				const time = parse_time_value(parts[0]);
				const time2 = parse_time_value(parts[1]);
				if (!time || !time2) continue;
				token.kind = 'time-range';
				token.time = time;
				token.timeEnd = time2;
			} else {
				const time = parse_time_value(head);
				if (!time) continue;
				token.kind = 'time';
				token.time = time;
			}
		} else {
			const date = parse_date_value(head);
			if (!date) continue;
			token.kind = 'date';
			token.date = date;
		}
		tokens.push(token as DueToken);
	}
	return tokens;
}

function alias_date(kind: DueTokenKind, now: Date): Date | null {
	if (kind === 'today') return start_of_day(now);
	if (kind === 'tomorrow') return add_days(start_of_day(now), 1);
	if (kind === 'yesterday') return add_days(start_of_day(now), -1);
	return null;
}

function token_date(token: DueToken, now: Date): Date | null {
	if (token.kind === 'date' && token.date) {
		return new Date(token.date.year, token.date.month - 1, token.date.day);
	}
	return alias_date(token.kind, now);
}

function combine(date: Date | null, time: TimeParts | null): Date | null {
	if (!date) return null;
	if (!time) return end_of_day(date);
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		time.hours,
		time.minutes,
		time.seconds === null ? 0 : time.seconds
	);
}

// Resolves a whole line: the first date-ish token decides the day and the first
// time token the time of day. Used both for the pills and for rollover sorting.
// A completed to-do also exposes the completion day of its marker.
export function resolve_line(text: string, now: Date): ResolvedLine | null {
	const tokens = find_due_tokens(text);
	if (tokens.length === 0) return null;

	let date: Date | null = null;
	let time: TimeParts | null = null;
	let completed_at: DateParts | TimeParts | null = null;
	for (const token of tokens) {
		if ((token.completed || token.completed_time) && !completed_at) {
			completed_at = token.completed || token.completed_time;
		}
		if (token.kind === 'time') {
			if (!time) time = token.time;
			continue;
		}
		if (token.kind === 'completed-only') continue;
		const candidate = token_date(token, now);
		if (candidate && !date) date = candidate;
	}
	return { tokens, date, time, completed_at };
}

export function format_time(time: TimeParts): string {
	const base = `${pad(time.hours)}:${pad(time.minutes)}`;
	return time.seconds === null ? base : `${base}:${pad(time.seconds)}`;
}

// The compact day-first form used by completion markers: 12/10/26.
export function format_short_date(parts: DateParts): string {
	return `${pad(parts.day)}/${pad(parts.month)}/${pad(parts.year % 100)}`;
}

function parts_from_date(date: Date): DateParts {
	return {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate()
	};
}

// A calendar-aware breakdown between two dates (from <= to), used by the
// relative-countdown wording.
function span_parts(from: Date, to: Date): { years: number; months: number; days: number } {
	const start = start_of_day(from);
	const end = start_of_day(to);
	let years = end.getFullYear() - start.getFullYear();
	let months = end.getMonth() - start.getMonth();
	let days = end.getDate() - start.getDate();
	if (days < 0) {
		months -= 1;
		days += new Date(end.getFullYear(), end.getMonth(), 0).getDate();
	}
	if (months < 0) {
		years -= 1;
		months += 12;
	}
	return { years, months, days };
}

function unit_label(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// Exact date wording. Obsidian exposes moment on window; the native fallback
// keeps this module usable outside the app (for example in tests).
export function exact_label(date: Date, format?: string, type: DueTextType = 'due'): string {
	const pattern = format || 'MMM D, YYYY';
	const moment = typeof window !== 'undefined' && typeof window.moment === 'function'
		? window.moment
		: null;
	const text = moment
		? moment(date).format(pattern)
		: new Intl.DateTimeFormat('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		}).format(date);
	return type === 'remaining' ? text : `Due ${text}`;
}

// The named wording: Due Today, Due This Week, ... Overdue.
export function named_label(date: Date, now: Date, type: DueTextType = 'due'): string {
	const remaining = type === 'remaining';
	const difference = day_diff(date, now);
	if (difference < 0) return 'Overdue';
	if (difference === 0) return remaining ? 'Today' : 'Due Today';
	if (difference === 1) return remaining ? 'Tomorrow' : 'Due Tomorrow';
	if (is_this_week(date, now)) return remaining ? 'This Week' : 'Due This Week';
	if (is_next_week(date, now)) return remaining ? 'Next Week' : 'Due Next Week';
	if (is_same_month(date, now)) return remaining ? 'This Month' : 'Due This Month';
	if (is_next_month(date, now)) return remaining ? 'Next Month' : 'Due Next Month';
	if (is_same_year(date, now)) return remaining ? 'This Year' : 'Due This Year';
	if (is_next_year(date, now)) return remaining ? 'Next Year' : 'Due Next Year';
	return remaining ? 'Later' : 'Due Later';
}

function day_count_label(days: number): string {
	return unit_label(days, 'Day');
}

// The day-count wording: Due in 67 Days / 67 Days left / Overdue by 3 Days.
export function days_label(date: Date, now: Date, type: DueTextType = 'due'): string {
	const remaining = type === 'remaining';
	const difference = day_diff(date, now);
	if (difference === 0) return remaining ? 'Today' : 'Due Today';
	const count = day_count_label(Math.abs(difference));
	if (difference > 0) return remaining ? `${count} left` : `Due in ${count}`;
	return remaining ? `${count} passed` : `Overdue by ${count}`;
}

// The largest calendar unit for the relative-countdown wording:
// 2 Years, 2 Months, 3 Weeks, 10 Days.
function countdown_unit(date: Date, now: Date): string {
	const future = day_diff(date, now) >= 0;
	const { years, months, days } = future ? span_parts(now, date) : span_parts(date, now);
	if (years > 0) return unit_label(years, 'Year');
	if (months > 0) return unit_label(months, 'Month');
	if (days >= 14) return unit_label(Math.floor(days / 7), 'Week');
	return unit_label(days, 'Day');
}

// The relative-countdown wording:
// Due in 2 Years / 2 Years left / Overdue by 3 Days / 3 Days passed.
export function countdown_label(date: Date, now: Date, type: DueTextType = 'due'): string {
	const remaining = type === 'remaining';
	const difference = day_diff(date, now);
	if (difference === 0) return remaining ? 'Today' : 'Due Today';
	const count = countdown_unit(date, now);
	if (difference > 0) return remaining ? `${count} left` : `Due in ${count}`;
	return remaining ? `${count} passed` : `Overdue by ${count}`;
}

// The label for a due date token based on the configured wording.
export function date_label(date: Date, now: Date, style?: DueTextStyle): string {
	style = style || {};
	const text = style.text || 'relative';
	const type: DueTextType = style.type === 'remaining' ? 'remaining' : 'due';
	if (text === 'exact') return exact_label(date, style.format, type);
	if (text === 'days') return days_label(date, now, type);
	if (text === 'countdown') return countdown_label(date, now, type);
	return named_label(date, now, type);
}

// Urgency tier used for the pill colour.
export function due_tier(datetime: Date, now: Date): PillTier {
	if (datetime.getTime() < now.getTime()) return 'overdue';
	const difference = day_diff(datetime, now);
	if (difference === 0) return 'today';
	if (difference === 1) return 'tomorrow';
	if (is_this_week(datetime, now)) return 'week';
	if (is_same_month(datetime, now)) return 'month';
	return 'later';
}

// The label, tier and icon for a single token, taking the rest of the line into
// account: a `!15:30` on a line that also has `!tomorrow` belongs to tomorrow.
// Dates get a calendar-clock icon, times a plain clock. Once a to-do is
// completed every pill turns green and the date pill shows the completion day.
export function token_pill(token: DueToken, resolved: ResolvedLine, now: Date, style?: DueTextStyle): TokenPill {
	if (token.completed) {
		return {
			label: format_short_date(token.completed),
			tier: 'completed',
			icon: 'calendar-clock'
		};
	}
	if (token.completed_time) {
		return {
			label: format_time(token.completed_time),
			tier: 'completed',
			icon: 'clock'
		};
	}
	if (token.kind === 'completed-only') {
		if (token.completed) {
			return {
				label: format_short_date(token.completed),
				tier: 'completed',
				icon: 'calendar-clock'
			};
		}
	}
	if (token.kind === 'upcoming') {
		return {
			label: 'Upcoming',
			tier: resolved.completed_at ? 'completed' : 'upcoming',
			icon: 'calendar-clock'
		};
	}
	if (token.kind === 'time') {
		const date = resolved.date || start_of_day(now);
		if (!resolved.date) {
			return {
				label: format_time(token.time!),
				tier: 'time-scheduled',
				icon: 'clock'
			};
		}
		return {
			label: format_time(token.time!),
			tier: resolved.completed_at
				? 'completed'
				: due_tier(combine(date, token.time)!, now),
			icon: 'clock'
		};
	}
	if (token.kind === 'time-range') {
		const label = `${format_time(token.time!)}-${format_time(token.timeEnd!)}`;
		const date = resolved.date || start_of_day(now);
		if (!resolved.date) {
			return {
				label,
				tier: 'time-scheduled',
				icon: 'clock'
			};
		}
		return {
			label,
			tier: resolved.completed_at
				? 'completed'
				: due_tier(combine(date, token.time)!, now),
			icon: 'clock'
		};
	}
	const date = token_date(token, now)!;
	const tier: PillTier = resolved.completed_at
		? 'completed'
		: due_tier(combine(date, resolved.time)!, now);
	const label = date_label(date, now, style);
	return { label, tier, icon: 'calendar-clock' };
}

function replace_span(line: string, from: number, to: number, replacement: string): string {
	if (replacement) {
		return line.slice(0, from) + replacement + line.slice(to);
	}
	// Removing a marker should not leave a double space behind. A marker added
	// to a to-do without a due date is preceded by a space, which goes with it.
	let start = from;
	let end = to;
	if (start > 0 && /\s/.test(line[start - 1])) {
		start -= 1;
	} else if (end < line.length && /\s/.test(line[end])) {
		end += 1;
	}
	return line.slice(0, start) + line.slice(end);
}

// Appends the completion day to the to-do line (and the completion time to a
// due time token):
//   "- [x] File taxes !10/12/2026"      -> "- [x] File taxes !10/12/2026@12/12/26"
//   "- [x] Standup !10:00"             -> "- [x] Standup !10:00@10:30"
//   "- [x] Meeting !12:00-15:00"       -> "- [x] Meeting !12:00-15:00@14:00"
//   "- [x] File taxes"                 -> "- [x] File taxes !@12/12/26"
// The due part is left exactly as written, so unchecking can restore it.
//
// To-dos without a due date or due time are the only ones affected by the
// `append_completion_date` / `append_completion_time` options. A to-do that
// already carries a due token is always stamped the same way, regardless of
// those options.
export function mark_completed(line: string, completed_at: Date, options: CompletionOptions = {}): string {
	if (!TASK_LINE_REGEX.test(line)) return line;
	const tokens = find_due_tokens(line);
	if (tokens.some((token) => token.completed || token.completed_time)) return line;

	const short = format_short_date(parts_from_date(completed_at));
	const append_date = options.append_completion_date !== false;
	const append_time = options.append_completion_time === true;
	const completion_time = format_time({
		hours: completed_at.getHours(),
		minutes: completed_at.getMinutes(),
		seconds: null
	});
	const dated = tokens.find((token) => token.kind !== 'time'
		&& token.kind !== 'time-range'
		&& token.kind !== 'upcoming');
	const date_target = dated || tokens.find((token) => token.kind === 'upcoming');
	const time_target = tokens.find((token) => token.kind === 'time'
		|| token.kind === 'time-range');

	if (!date_target && !time_target) {
		const standalone = [];
		if (append_date) standalone.push(`!@${short}`);
		if (append_time) standalone.push(`!@${completion_time}`);
		if (standalone.length === 0) return line;
		return `${line}${/\s$/.test(line) ? '' : ' '}${standalone.join(' ')}`;
	}

	const marks: Array<{ to: number; text: string }> = [];
	if (date_target) {
		marks.push({ to: date_target.to, text: `@${short}` });
	}
	if (time_target) {
		const with_seconds = time_target.kind === 'time-range'
			? time_target.time!.seconds !== null || time_target.timeEnd!.seconds !== null
			: time_target.time!.seconds !== null;
		const time_text = format_time({
			hours: completed_at.getHours(),
			minutes: completed_at.getMinutes(),
			seconds: with_seconds ? completed_at.getSeconds() : null
		});
		marks.push({ to: time_target.to, text: `@${time_text}` });
	}

	// Apply from the end so an earlier insertion cannot shift a later offset.
	marks.sort((a, b) => b.to - a.to);
	let out = line;
	for (const mark of marks) {
		out = out.slice(0, mark.to) + mark.text + out.slice(mark.to);
	}
	return out;
}

// Removes the completion day/time again, restoring the due token exactly as it
// was. A marker without a due token (`!@comp`) is removed entirely.
export function unmark_completed(line: string): string {
	const tokens = find_due_tokens(line);
	if (!tokens.some((token) => token.completed || token.completed_time)) return line;

	let out = line;
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i];
		if (!token.completed && !token.completed_time) continue;
		const head = token.raw.slice(0, token.raw.indexOf('@'));
		const no_due = head === '' || head === '!';
		out = replace_span(out, token.from, token.to, no_due ? '' : head);
	}
	return out;
}

// Rewrites the relative date aliases in a line so they keep pointing at the
// same calendar day once the line is placed in a note for `target`. The alias
// matching the target note is preferred (!today, !tomorrow, !yesterday);
// anything further away is pinned to an absolute !YYYY-MM-DD. Absolute dates,
// times and !upcoming are left alone.
export function pin_relative_aliases(line: string, source: Date, target: Date): string {
	const tokens = find_due_tokens(line);
	if (tokens.length === 0) return line;

	let out = '';
	let cursor = 0;
	for (const token of tokens) {
		if (token.kind !== 'today'
			&& token.kind !== 'tomorrow'
			&& token.kind !== 'yesterday') {
			continue;
		}
		const day = alias_date(token.kind, source)!;
		const difference = day_diff(day, target);
		let replacement;
		if (difference === 0) {
			replacement = '!today';
		} else if (difference === 1) {
			replacement = '!tomorrow';
		} else if (difference === -1) {
			replacement = '!yesterday';
		} else {
			replacement = `!${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
		}
		if (token.completed) {
			replacement += `@${format_short_date(token.completed)}`;
		}
		out += line.slice(cursor, token.from) + replacement;
		cursor = token.to;
	}
	return out + line.slice(cursor);
}

// Applies pin_relative_aliases to every checkbox line in the structure, so
// to-dos moved into a new daily note keep their original due day.
export function pin_aliases_in_structure(structure: Structure, source: Date, target: Date): Structure {
	if (structure.text && CHECKBOX_REGEX.test(structure.text)) {
		structure.text = pin_relative_aliases(structure.text, source, target);
	}
	for (let i = 0; i < structure.children.length; i++) {
		const child = structure.children[i];
		if (typeof child === 'object' && child !== null && child !== undefined) {
			pin_aliases_in_structure(child, source, target);
		} else if (typeof child === 'string' && CHECKBOX_REGEX.test(child)) {
			structure.children[i] = pin_relative_aliases(child, source, target);
		}
	}
	return structure;
}

// Timestamp used to order to-dos by due date. Lines with no token, or only with
// `!upcoming`, return null and sort after the dated ones.
export function due_sort_key(text: string, now: Date): number | null {
	const resolved = resolve_line(text, now);
	if (!resolved) return null;
	if (!resolved.date && !resolved.time) return null;
	const date = resolved.date || start_of_day(now);
	const datetime = resolved.time ? combine(date, resolved.time)! : end_of_day(date);
	return datetime.getTime();
}

// Sorts the direct to-do children of every node by due date, closest first,
// leaving to-dos without a due date in their original order after the dated
// ones. Non-to-do children (headings, text) keep their positions, so the note's
// structure is untouched.
export function sort_structure_by_due(structure: Structure, now: Date): Structure {
	const slots: number[] = [];
	structure.children.forEach((child, index) => {
		if (typeof child === 'object'
			&& child !== undefined
			&& child.text
			&& CHECKBOX_REGEX.test(child.text)) {
			slots.push(index);
		}
	});

	if (slots.length > 1) {
		const todos = slots.map((index) => structure.children[index] as Structure);
		todos.sort((a, b) => {
			const a_key = due_sort_key(a.text as string, now);
			const b_key = due_sort_key(b.text as string, now);
			if (a_key === null && b_key === null) return 0;
			if (a_key === null) return 1;
			if (b_key === null) return -1;
			return a_key - b_key;
		});
		slots.forEach((slot, index) => {
			structure.children[slot] = todos[index];
		});
	}

	for (const child of structure.children) {
		if (typeof child === 'object' && child !== undefined) sort_structure_by_due(child, now);
	}
	return structure;
}
