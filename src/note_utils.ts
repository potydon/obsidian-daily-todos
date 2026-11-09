import type { Moment } from "moment";
import type { Structure, StructureChild } from "./types";

export const HEADING_REGEX = /^#{1,7} +\S.*/m;
export const HEADING_REGEX_GLOBAL = /^#{1,7} +\S.*/gm;

// https://regex101.com/r/e7avuk/1
export const CHECKBOX_REGEX = /^(\s*)-\s+\[(.)\].*$/m;
export const CHECKEDBOX_REGEX = /^\s*-\s+\[[xX]\].*$/m;

// Support obligate and every
export const OBLIGATION_REGEX = /^\s*{{\s*(obligate|every)(?:\s+([^}]+?))?\s*}}\s*$/;

// Habit streak support: any checkbox line containing the !STREAK tag.
// The look-behind keeps the tag out of words and away from other exclamation
// marks, matching how due tokens are parsed.
export const HABIT_TAG_REGEX = /(?<![\w!])!streak\b/i;
export const HABIT_TAG_REGEX_GLOBAL = /(?<![\w!])!streak\b/gi;

// Task lines in any of the bullet styles Obsidian accepts. Group 1 is the
// "- [", "  * [" style prefix and group 2 is the state character.
export const TASK_LINE_REGEX = /^(\s*[-*+]\s+)\[(.)\]/;

// Returns true when the checkbox line is checked (cancelled "-" is not checked).
export function is_checked_line(line: string): boolean {
	const match = TASK_LINE_REGEX.exec(line);
	return !!match && (match[2] === "x" || match[2] === "X");
}

// Returns the normalized (lowercase, whitespace-collapsed) habit name for a
// line. Works for both raw markdown lines ("- [ ] Wake early !STREAK") and
// rendered text ("Wake early !STREAK"), and the tag may appear anywhere.
// Due/time tokens (!...) and other tags (#...) are ignored so changing
// times/dates doesn't affect streak identification.
export function habit_name(line: string): string {
	return line
		.replace(/^\s*[-*+]\s+\[.\]\s*/, "")
		.replace(HABIT_TAG_REGEX_GLOBAL, " ")
		.replace(/![^\s]+/g, " ")
		.replace(/#[^\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

// Looks through note content for a habit by name. Returns whether the habit is
// present at all and whether at least one matching checkbox is checked.
export function find_habit_state(content: string, name: string): { found: boolean; checked: boolean } {
	let found = false;
	let checked = false;
	for (const line of content.split(/\r?\n/)) {
		if (!HABIT_TAG_REGEX.test(line)) continue;
		if (!TASK_LINE_REGEX.test(line)) continue;
		if (habit_name(line) !== name) continue;
		found = true;
		if (is_checked_line(line)) {
			checked = true;
		}
	}
	return { found, checked };
}

export function get_heading_level(heading: string | null): number {
	if (heading && HEADING_REGEX.test(heading)) {
		return heading.replace(/[^#]/g, "").length;
	}
	return 0;
}

export function get_checkbox_level(checkbox: string | null): number {
	if (checkbox && CHECKBOX_REGEX.test(checkbox)) {
		// This is offset by 1 so that the logic matches the heading logic
		return checkbox.replace(CHECKBOX_REGEX, "$1").length + 1;
	}
	return 0;
}

// Structurize takes a set of lines from a note file and structures them
// hierarchically based on fold scope.
export function structurize(lines: string[], text: string | null = null): Structure {
	const parent_heading_level = get_heading_level(text);
	const parent_checkbox_level = get_checkbox_level(text);
	let total = 0;
	const children: Array<StructureChild | undefined> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const is_heading = HEADING_REGEX.test(line);
		const is_checkbox = CHECKBOX_REGEX.test(line);

		// A heading cannot be the child of a checkbox. text is checked here
		// because it can be null when invoked
		if (is_heading && text && CHECKBOX_REGEX.test(text)) {
			break;
		}

		// A lower level means a greater scope. If this new heading has a
		// lesser or equal level, then there are no more children, we can
		// stop processing.
		if (is_heading && get_heading_level(line) <= parent_heading_level) {
			break;
		}
		if (is_checkbox && get_checkbox_level(line) <= parent_checkbox_level) {
			break;
		}

		// If this is a foldable, then we do the recursive step, otherwise we
		// can simply add the child to the list of children
		if (is_heading || is_checkbox) {
			const child = structurize(lines.slice(i + 1), line);
			children.push(child);
			i += child.total;
			total += child.total;
		} else {
			// Since we increment the iterator above, this will always
			// be children on the same level, so they can be added.
			children.push(line);
		}
		total += 1;
	}
	return { text, children, total };
}

// Flattens the heirarchy represented by the output of a call to structurize
export function destructure(structure: Structure): string[] {
	const lines: string[] = [];
	if (structure.text) {
		lines.push(structure.text);
	}
	for (let i = 0; i < structure.children.length; i++) {
		const child = structure.children[i];
		if (child instanceof Object) {
			lines.push(...destructure(child));
		} else if (child !== undefined) {
			lines.push(child);
		}
	}
	return lines;
}

// Merges second into first
// Limitation: Parent paths have to be unique within the structure.
export function merge_structure(first: Structure, second: Structure): Structure | void {
	// If we receive structures which don't have the same heading, the only
	// thing we can do is merge them under a new parent
	if (first.text !== second.text) {
		return {
			text: null,
			children: [first, second],
			total: first.total + second.total + 2
		};
	}

	// Go through each child in second, and check if it's in first
	second.children.forEach((child) => {
		if (child instanceof Object) {
			const first_child = first.children.find((c) => c instanceof Object && c.text === child.text);
			if (first_child && first_child instanceof Object) {
				const old_total = first_child.total;
				merge_structure(first_child, child);
				first.total += first_child.total - old_total;
			} else {
				if (child.text && CHECKBOX_REGEX.test(child.text)) {
					const heading_index = first.children.findIndex((c) => c instanceof Object && c.text && HEADING_REGEX.test(c.text));
					if (heading_index > -1) {
						first.children.splice(heading_index, 0, child);
					} else {
						first.children.push(child);
					}
				} else {
					first.children.push(child);
					first.total += child.total + 1;
				}
			}
		} else {
			// Add missing children
			// `contains` is not a standard Array method; keep the original
			// call site so the refactor does not change behaviour.
			const list = first.children as unknown as { contains(value: StructureChild | undefined): boolean };
			if (!list.contains(child)) {
				const heading_index = first.children.findIndex((c) => c instanceof Object && c.text && HEADING_REGEX.test(c.text));
				if (heading_index > -1) {
					first.children.splice(heading_index, 0, child);
				} else {
					first.children.push(child);
				}
				// Text children must come before any headings or else they'll
				// get wrapped into other fold scopes when heading children
				// are added.
				first.total += 1;
			}
		}
	});
}

export function filter_structure(
	structure: Structure,
	delete_headings: boolean,
	keep_until_parent_complete: boolean,
	keep_unfinished_subtrees = false
): void {
	for (let i = 0; i < structure.children.length; i++) {
		const child = structure.children[i];
		if (typeof child === "object" && child !== undefined) {

			// child.text is checked here because it can be null when invoked.
			if (child.text) {
				if (CHECKBOX_REGEX.test(child.text)
					&& !CHECKEDBOX_REGEX.test(child.text)
					&& (keep_until_parent_complete || keep_unfinished_subtrees)) {
					// Keep the whole unfinished subtree. This is used when
					// unfinished to-dos are moved to the new note, so that no
					// nested content is lost when the subtree is removed from
					// the previous note.
					continue;
				}
				filter_structure(
					child,
					delete_headings,
					keep_until_parent_complete,
					keep_unfinished_subtrees
				);
				if (HEADING_REGEX.test(child.text)) {
					if (delete_headings) {
						const non_empty = child.children.filter((element) => {
							if (typeof element === "object") {
								return true;
							}
							// `undefined` slots left by an earlier delete are
							// coerced to the string "undefined" by RegExp.test,
							// which counts them as non-empty, exactly like the
							// original implementation did.
							if (!/^\s*$/m.test(element as string)) {
								return true;
							}
							return false;
						});
						if (non_empty.length === 0) {
							delete structure.children[i];
							structure.total = structure.total - child.children.length;
						}
					}
				}
				// Only delete checkedboxes if they have no unchecked children
				if (CHECKEDBOX_REGEX.test(child.text)) {
					// Count the number of unchecked children
					if (child.children.filter((element) => {
						if (typeof element === "object" && element.text !== null) {
							return CHECKBOX_REGEX.test(element.text) && !CHECKEDBOX_REGEX.test(element.text);
						}
						return false;
					}).length === 0) {
						delete structure.children[i];
						structure.total = structure.total - (1 + child.children.length);
					}
				}
			}
		}
	}
	structure.children = structure.children.filter((element) => element !== undefined);
}

export function cron_segment_to_list(segment: string, field: number): number[] {
	let output: number[] = [];
	const RANGE_REGEX = /^(\d+)-(\d+)$/;
	const STEP_RANGE_REGEX = /^(\d+)-(\d+)\/(\d+)$/;
	const STEP_WILDCARD_REGEX = /^\*\/(\d+)$/;
	const STEP_START_REGEX = /^(\d+)\/(\d+)$/;

	// Define ranges for each field
	// field 0: day of month (1-31), field 1: month (1-12), field 2: day of week (0-6, Sun=0)
	const ranges = [
		{ min: 1, max: 31 }, // day of month
		{ min: 1, max: 12 }, // month
		{ min: 0, max: 6 }   // day of week (moment: Sun=0)
	];

	const range = ranges[field] !== undefined ? ranges[field] : { min: 1, max: 31 };

	for (const r of segment.split(',')) {
		if (RANGE_REGEX.test(r) && !r.includes('/')) {
			const match = r.match(RANGE_REGEX)!;
			const start = parseInt(match[1]);
			const end = parseInt(match[2]);
			const expanded_range = Array.from({ length: 1 + end - start }, (_, i) => start + i);
			output = output.concat(expanded_range);
		} else if (STEP_RANGE_REGEX.test(r)) {
			const match = r.match(STEP_RANGE_REGEX)!;
			const start = parseInt(match[1]);
			const end = parseInt(match[2]);
			const step = parseInt(match[3]);
			for (let i = start; i <= end; i += step) {
				output.push(i);
			}
		} else if (STEP_WILDCARD_REGEX.test(r)) {
			const match = r.match(STEP_WILDCARD_REGEX)!;
			const step = parseInt(match[1]);
			if (field === 2) {
				// Day of week - handle wrap around for weekly cycle
				for (let i = 0; i < 7; i += step) {
					output.push((range.min + i) % 7);
				}
			} else {
				for (let i = range.min; i <= range.max; i += step) {
					output.push(i);
				}
			}
		} else if (STEP_START_REGEX.test(r)) {
			const match = r.match(STEP_START_REGEX)!;
			const start = parseInt(match[1]);
			const step = parseInt(match[2]);
			if (field === 2) {
				// Day of week - handle wrap around (Mon=1, Tue=2, ..., Sun=0 in moment)
				for (let i = 0; i < 7; i++) {
					const val = start + i * step;
					if (val > 7) break;
					if (val === 7) {
						output.push(0);
					} else if (val >= 1 && val <= 6) {
						output.push(val);
					} else if (val % 7 === 0) {
						output.push(0);
					} else {
						output.push(val % 7);
					}
				}
			} else {
				for (let i = start; i <= range.max; i += step) {
					output.push(i);
				}
			}
		} else if (r === '*') {
			output.push(NaN);
		} else {
			output.push(parseInt(r));
		}
	}
	return output.sort((a, b) => {
		if (isNaN(a)) return -1;
		if (isNaN(b)) return 1;
		return a - b;
	});
}

const DAY_MAP: Record<string, number> = {
	'sunday': 0, 'sun': 0,
	'monday': 1, 'mon': 1,
	'tuesday': 2, 'tue': 2,
	'wednesday': 3, 'wed': 3,
	'thursday': 4, 'thu': 4,
	'friday': 5, 'fri': 5,
	'saturday': 6, 'sat': 6
};

const MONTH_MAP: Record<string, number> = {
	'january': 1, 'jan': 1,
	'february': 2, 'feb': 2,
	'march': 3, 'mar': 3,
	'april': 4, 'apr': 4,
	'may': 5,
	'june': 6, 'jun': 6,
	'july': 7, 'jul': 7,
	'august': 8, 'aug': 8,
	'september': 9, 'sep': 9, 'sept': 9,
	'october': 10, 'oct': 10,
	'november': 11, 'nov': 11,
	'december': 12, 'dec': 12
};

export function should_trigger_obligation(obligation_string: string, test_date: Moment): boolean {
	const match = obligation_string.match(OBLIGATION_REGEX);
	if (!match) return false;

	const type = match[1];
	const args = match[2] ? match[2].trim() : '';

	let day_months: number[] = [NaN];
	let month_years: number[] = [NaN];
	let day_weeks: number[] = [NaN];

	if (type === 'obligate') {
		// Split by whitespace - old style
		const parts = args.split(/\s+/);
		if (parts.length === 3) {
			day_months = cron_segment_to_list(parts[0], 0);
			month_years = cron_segment_to_list(parts[1], 1);
			day_weeks = cron_segment_to_list(parts[2], 2);
		}
	} else if (type === 'every') {
		if (args === '' || args === '*') {
			// every day by default
			day_months = [NaN];
			month_years = [NaN];
			day_weeks = [NaN];
		} else {
			const parts = args.split(/\s+/);
			// Check if it's a day name
			const lowerArgs = args.toLowerCase();
			if (DAY_MAP.hasOwnProperty(lowerArgs)) {
				day_weeks = [DAY_MAP[lowerArgs]];
				day_months = [NaN];
				month_years = [NaN];
			} else if (MONTH_MAP.hasOwnProperty(lowerArgs)) {
				day_months = [1];
				month_years = [MONTH_MAP[lowerArgs]];
				day_weeks = [NaN];
			} else if (parts.length === 1) {
				// Could be "day", "week", "month", "year", or specific values
				const p = parts[0].toLowerCase();
				if (p === 'day') {
					day_months = [NaN];
					month_years = [NaN];
					day_weeks = [NaN];
				} else if (p === 'week') {
					day_weeks = [1]; // Monday
					day_months = [NaN];
					month_years = [NaN];
				} else if (p === 'month') {
					day_months = [1];
					month_years = [NaN];
					day_weeks = [NaN];
				} else if (p === 'year') {
					day_months = [1];
					month_years = [1];
					day_weeks = [NaN];
				} else if (/^\d{4}$/.test(p)) {
					// year
					const test_year = parseInt(test_date.format('YYYY'));
					if (parseInt(p) !== test_year) return false;
					day_months = [1];
					month_years = [1];
					day_weeks = [NaN];
				}
			} else if (parts.length === 2) {
				const p1 = parts[0].toLowerCase();
				const p2 = parts[1].toLowerCase();
				if (p2 === 'day') {
					if (p1.includes('/')) {
						// every 1/3 day
						const [start, step] = p1.split('/');
						day_months = [];
						const s = parseInt(start);
						const st = parseInt(step);
						for (let i = s; i <= 31; i += st) day_months.push(i);
						month_years = [NaN];
						day_weeks = [NaN];
					} else if (p1 === '2') {
						// every 2nd day of month
						day_months = [];
						for (let i = 2; i <= 31; i += 2) day_months.push(i);
						month_years = [NaN];
						day_weeks = [NaN];
					} else if (p1 === '1') {
						// every 1st day of month
						day_months = [1];
						month_years = [NaN];
						day_weeks = [NaN];
					} else if (p1.includes(',')) {
						day_months = p1.split(',').map(x => parseInt(x));
						month_years = [NaN];
						day_weeks = [NaN];
					} else if (p1.includes('-')) {
						const [s, e] = p1.split('-').map(x => parseInt(x));
						day_months = [];
						for (let i = s; i <= e; i++) day_months.push(i);
						month_years = [NaN];
						day_weeks = [NaN];
					} else {
						day_months = [parseInt(p1)];
						month_years = [NaN];
						day_weeks = [NaN];
					}
				} else if (p2 === 'week') {
					if (p1.includes('/')) {
						// every 2/2 week
						const [start, step] = p1.split('/');
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					} else if (p1 === '2') {
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					} else if (p1 === '1') {
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					} else if (p1.includes(',')) {
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					} else if (p1.includes('-')) {
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					} else {
						day_weeks = [1];
						day_months = [NaN];
						month_years = [NaN];
					}
				} else if (p2 === 'month') {
					if (p1.includes('/')) {
						const [start, step] = p1.split('/');
						const s = parseInt(start);
						const st = parseInt(step);
						month_years = [];
						for (let i = s; i <= 12; i += st) month_years.push(i);
						day_months = [1];
						day_weeks = [NaN];
					} else if (p1 === '3') {
						month_years = [];
						for (let i = 3; i <= 12; i += 3) month_years.push(i);
						day_months = [1];
						day_weeks = [NaN];
					} else if (p1.includes(',')) {
						month_years = p1.split(',').map(x => parseInt(x));
						day_months = [1];
						day_weeks = [NaN];
					} else if (p1.includes('-')) {
						const [s, e] = p1.split('-').map(x => parseInt(x));
						month_years = [];
						for (let i = s; i <= e; i++) month_years.push(i);
						day_months = [1];
						day_weeks = [NaN];
					} else {
						month_years = [parseInt(p1)];
						day_months = [1];
						day_weeks = [NaN];
					}
				} else if (p2 === 'year') {
					const test_year = parseInt(test_date.format('YYYY'));
					if (p1.includes('/')) {
						const [start, step] = p1.split('/');
						const s = parseInt(start);
						const st = parseInt(step);
						let matched = false;
						for (let y = s; y <= test_year; y += st) {
							if (y === test_year) matched = true;
						}
						if (!matched) return false;
						day_months = [1];
						month_years = [1];
						day_weeks = [NaN];
					} else if (p1.includes(',')) {
						const years = p1.split(',').map(x => parseInt(x));
						if (!years.includes(test_year)) return false;
						day_months = [1];
						month_years = [1];
						day_weeks = [NaN];
					} else if (p1.includes('-')) {
						const [s, e] = p1.split('-').map(x => parseInt(x));
						if (test_year < s || test_year > e) return false;
						day_months = [1];
						month_years = [1];
						day_weeks = [NaN];
					} else {
						if (parseInt(p1) !== test_year) return false;
						day_months = [1];
						month_years = [1];
						day_weeks = [NaN];
					}
				}
			} else if (parts.length === 3) {
				// Could be "every 1/3 day" style with different ordering? Or "every week 1,3" means first day of week 1,3
				const p1 = parts[0].toLowerCase();
				const p2 = parts[1].toLowerCase();
				if (p2 === 'week') {
					day_weeks = [1];
					day_months = [NaN];
					month_years = [NaN];
				} else if (p2 === 'day') {
					if (p1.includes('/')) {
						const [start, step] = p1.split('/');
						day_months = [];
						const s = parseInt(start);
						const st = parseInt(step);
						for (let i = s; i <= 31; i += st) day_months.push(i);
						month_years = [NaN];
						day_weeks = [NaN];
					}
				}
			}
		}
	}

	const test_day_month = parseInt(test_date.format('D'));
	const test_month_year = parseInt(test_date.format('M'));
	const test_day_week = test_date.day();

	const matched_day_month = (day_months.includes(NaN) || (day_months.includes(test_day_month)));
	const matched_month_year = (month_years.includes(NaN) || (month_years.includes(test_month_year)));
	const matched_day_week = (day_weeks.includes(NaN) || (day_weeks.includes(test_day_week)));

	if (matched_day_month && matched_month_year && matched_day_week) {
		return true;
	}
	return false;
}

export function strip_frontmatter(lines: string[]): string[] {
	if (lines.length == 0) {
		return lines;
	}

	if (lines[0] === "---") {
		const end_index = lines.slice(1).indexOf("---");
		if (end_index !== -1) {
			// +1 for the first slice above,
			// +1 to get above the index of the terminal
			return lines.slice(end_index + 2);
		} else {
			return lines;
		}

	}

	return lines;
}

// Splits content into lines while preserving the file's line ending style.
export function split_lines(content: string): { lines: string[]; eol: string } {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	return { lines: content.split(eol), eol };
}

// Returns the text of a to-do with its bullet, checkbox state, indentation and
// surrounding whitespace stripped, so the same task can be recognised across
// notes. Returns null for lines which are not to-dos.
export function task_text(line: string): string | null {
	const match = TASK_LINE_REGEX.exec(line);
	if (!match) return null;
	const text = line.slice(match[0].length).replace(/\s+/g, " ").trim();
	return text || null;
}

// True when the line is a to-do which has not been checked off yet.
// Empty checkboxes remain unfinished; checked ([x]) and cancelled ([-])
// are treated as finished and stay behind.
export function is_unfinished_line(line: string): boolean {
	const match = TASK_LINE_REGEX.exec(line);
	if (!match) return false;
	const state = match[2].toLowerCase();
	return state === " " || state === "/";
}

// Returns a copy of the structure with every to-do subtree for which
// should_drop(line) is true removed. Headings, plain text and to-dos which
// don't match are left untouched. When should_keep_subtree(line) is true the
// to-do and everything nested under it are kept as-is, without applying the
// filters to its children.
export function drop_todos(
	structure: Structure,
	should_drop: (line: string) => boolean,
	should_keep_subtree: ((line: string) => boolean) | null = null
): Structure {
	const kept: Structure = {
		text: structure.text,
		children: [],
		total: 0
	};
	for (const child of structure.children) {
		if (typeof child === "object" && child !== undefined) {
			const text = child.text;
			if (text !== null && CHECKBOX_REGEX.test(text)) {
				if (should_drop(text)) {
					// This to-do and everything nested under it is dropped.
					continue;
				}
				if (should_keep_subtree && should_keep_subtree(text)) {
					// This to-do is staying behind, so its nested to-dos stay
					// with it instead of being moved on their own.
					kept.children.push(child);
					kept.total += child.total + 1;
					continue;
				}
			}
			const kept_child = drop_todos(child, should_drop, should_keep_subtree);
			kept.children.push(kept_child);
			kept.total += kept_child.total + 1;
		} else {
			kept.children.push(child);
			kept.total += 1;
		}
	}
	return kept;
}

// Adds the normalized text of every unfinished to-do in the structure to
// `into`. Used to recognise to-dos which the template already provides.
export function collect_unfinished_task_texts(structure: Structure, into: Set<string>): Set<string> {
	if (structure.text && is_unfinished_line(structure.text)) {
		const text = task_text(structure.text);
		if (text !== null) into.add(text);
	}
	for (const child of structure.children) {
		if (typeof child === "object" && child !== undefined) {
			collect_unfinished_task_texts(child, into);
		}
	}
	return into;
}

// Replaces the section between the initial and terminal headings, keeping the
// frontmatter and everything outside that section intact.
export function replace_section(content: string, initial: string, terminal: string, section_lines: string[]): string {
	const { lines, eol } = split_lines(content);
	const body = strip_frontmatter(lines);
	const body_start = lines.length - body.length;

	let initial_index = body.indexOf(initial);
	if (initial === "") {
		initial_index = 0;
	} else if (initial_index === -1) {
		return content;
	}

	let terminal_index = body.indexOf(terminal, initial_index);
	if (terminal === "") {
		terminal_index = body.length;
	} else if (terminal_index === -1) {
		return content;
	}

	if (terminal_index <= initial_index) {
		return content;
	}

	lines.splice(body_start + initial_index,
		terminal_index - initial_index,
		...section_lines);
	return lines.join(eol);
}
