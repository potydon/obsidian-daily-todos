import type * as Moment from "moment";

declare global {
	interface Window {
		/** Obsidian exposes Moment.js on `window.moment`. */
		moment: typeof Moment;
	}
}

export interface DateParts {
	year: number;
	month: number;
	day: number;
}

export interface TimeParts {
	hours: number;
	minutes: number;
	seconds: number | null;
}

export type DueTokenKind =
	| "date"
	| "time"
	| "time-range"
	| "upcoming"
	| "today"
	| "tomorrow"
	| "yesterday"
	| "completed-only";

export interface DueToken {
	from: number;
	to: number;
	raw: string;
	kind: DueTokenKind;
	date: DateParts | null;
	time: TimeParts | null;
	timeEnd?: TimeParts;
	completed: DateParts | null;
	completed_time: TimeParts | null;
}

export interface ResolvedLine {
	tokens: DueToken[];
	date: Date | null;
	time: TimeParts | null;
	completed_at: DateParts | TimeParts | null;
}

export type DueTextStyleName = "exact" | "relative" | "days" | "countdown";
export type DueTextType = "due" | "remaining";

export interface DueTextStyle {
	text?: DueTextStyleName;
	type?: DueTextType;
	format?: string;
}

export type PillTier =
	| "completed"
	| "upcoming"
	| "overdue"
	| "today"
	| "tomorrow"
	| "week"
	| "month"
	| "later"
	| "time-scheduled";

export type PillIcon = "clock" | "calendar-clock";

export interface TokenPill {
	label: string;
	tier: PillTier;
	icon: PillIcon;
}

export interface CompletionOptions {
	append_completion_date?: boolean;
	append_completion_time?: boolean;
}

/**
 * A node in the note hierarchy produced by `structurize`. `text` is the raw
 * line for headings, to-dos and plain text, or null for the synthetic root.
 */
export type StructureChild = Structure | string;

export interface Structure {
	text: string | null;
	// `filter_structure` deletes entries in place before compacting the array,
	// so the element type has to admit undefined.
	children: Array<StructureChild | undefined>;
	total: number;
}

export interface ObligatorSettings {
	initial: string;
	terminal: string;
	date_format: string;
	template_path: string;
	note_path: string;
	archive: boolean;
	archive_path: string;
	archive_date_format: string;
	delete_empty_headings: boolean;
	keep_template_headings: boolean;
	run_on_startup: boolean;
	keep_until_parent_complete: boolean;
	move_todos: boolean;
	dont_rollover_template: boolean;
	dont_rollover_only_habit: boolean;
	rearrange_by_due: boolean;
	due_date_text_type: DueTextType;
	due_date_text: DueTextStyleName;
	due_date_format: string;
	append_completion_date: boolean;
	append_completion_time: boolean;
	/** Legacy setting migrated to `due_date_text` + `due_date_text_type`. */
	due_pill_format?: string;
}
