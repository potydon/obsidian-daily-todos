import { Notice, Plugin, PluginSettingTab, TFolder, TFile, normalizePath, debounce } from 'obsidian';
import {
	HEADING_REGEX_GLOBAL,
	OBLIGATION_REGEX,
	HABIT_TAG_REGEX,
	structurize,
	destructure,
	merge_structure,
	filter_structure,
	should_trigger_obligation,
	strip_frontmatter,
	split_lines,
	task_text,
	is_unfinished_line,
	drop_todos,
	collect_unfinished_task_texts,
	replace_section
} from "./note_utils"

import {
	register_habit_streaks,
	clear_streak_cache,
	refresh_live_preview_streaks
} from "./streaks"

import {
	register_due_pills,
	refresh_due_pills
} from "./due_pills"

import {
	sort_structure_by_due,
	pin_aliases_in_structure
} from "./due"

import {
	register_completion_annotations
} from "./completion"

const DEFAULT_SETTINGS = {
	initial: "",
	terminal: "",
	date_format: "YYYY-MM-DD",
	template_path: "",
	note_path: "",
	archive: false,
	archive_path: "",
	archive_date_format: "YYYY/MM-MMMM/YYYY-MM-DD",
	delete_empty_headings: true,
	keep_template_headings: true,
	run_on_startup: false,
	keep_until_parent_complete: false,
	move_todos: true,
	dont_rollover_template: false,
	dont_rollover_only_habit: false,
	rearrange_by_due: true,
	due_date_text_type: "due",
	due_date_text: "relative",
	due_date_format: "MMM D, YYYY",
	append_completion_date: true,
	append_completion_time: false
}

export default class Obligator extends Plugin {
	async onload() {
		await this.loadSettings();

		const run_obligator = async () => {

			// ----------------------------------------------------------------
			// Basic logical overview
			// ----------------------------------------------------------------
			// 1. Check that all of the settings are correctly set, and
			//    initialize some basic values we'll need later.
			// 2. Switch to today's note if it already exists.
			// 3. Process the last note, if there is one.
			// 4. Process the template file.
			// 5. Merge the contents of the last note into the template.
			//    Do the last_note templates, archiving, and open the new file.
			// ----------------------------------------------------------------
			// Step 1
			// ----------------------------------------------------------------

			// Make sure the note path is set, if not, error.
			if (["", null].includes(this.settings.note_path)) {
				new Notice(`You must specify a note path in the settings.`);
				return;
			}

			// Make sure the note folder exists
			const NOTE_FOLDER = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.note_path));
			if (NOTE_FOLDER == undefined) {
				new Notice(`The note path "${this.settings.note_path}" specified in the settings does not exist, aborting...`);
				return;
			}

			// Make sure that the template file exists. The declarative file
			// control stores the full path including the extension, while older
			// settings stored the path without it, so accept both.
			const template_path = this.settings.template_path;
			const TEMPLATE_FILE = template_path
				? this.app.vault.getAbstractFileByPath(template_path)
					|| this.app.vault.getAbstractFileByPath(`${template_path}.md`)
				: null;
			if (TEMPLATE_FILE == null) {
				if (!template_path) {
					new Notice(`You must specify a template file in the settings.`);
				} else {
					new Notice(`The template file "${template_path}" specified in the settings does not exist.`);
				}
				return;
			}
			if (!(TEMPLATE_FILE instanceof TFile)) {
				new Notice(`${template_path} is not a regular file! Aborting.`);
				return;
			}

			// Read the template contents here for checking. It will primarily
			// be used in step 4, though.
			let template_contents = await this.app.vault.read(TEMPLATE_FILE);

			// Make sure the initial / terminal settings are valid.
			if (this.settings.initial === null || this.settings.initial === undefined) {
				this.settings.initial = "";
			}
			if (this.settings.terminal === null || this.settings.terminal === undefined) {
				this.settings.terminal = "";
			}
			await this.saveSettings();
			if (this.settings.terminal != "" && this.settings.initial != "") {
				const check_template_lines = template_contents.split('\n');
				const initial_index = check_template_lines.indexOf(this.settings.initial);
				const terminal_index = check_template_lines.indexOf(this.settings.terminal);
				if (terminal_index <= initial_index) {
					new Notice("The initial heading must preceed the terminal heading. Aborting.");
					return;
				}
			}


			// Make sure that the archive path is set if the archive option is on.
			if (this.settings.archive) {
				if (["", null].includes(this.settings.archive_path)) {
					new Notice("The archive path must be specified when the archive option is turned on, aborting.");
					return;
				}
			}

			// Make sure the default value is applied if it's left blank
			const NOW = window.moment();
			const DATE_FORMAT = this.settings.date_format || DEFAULT_SETTINGS.date_format;
			const ARCHIVE_DATE_FORMAT = this.settings.archive_date_format || DEFAULT_SETTINGS.archive_date_format;
			const NOTE_NAME = NOW.format(DATE_FORMAT);
			const ACTIVE_LEAF = this.app.workspace.getLeaf();

			// ----------------------------------------------------------------
			// Step 2
			// Context: settings are valid
			// ----------------------------------------------------------------
			const NEW_NOTE_PATH = `${this.settings.note_path}/${NOTE_NAME}.md`
			let output_file = this.app.vault.getAbstractFileByPath(NEW_NOTE_PATH);
			if (output_file != undefined && output_file instanceof TFile) {
				await ACTIVE_LEAF.openFile(output_file);
				return;
			}

			// ----------------------------------------------------------------
			// Step 3
			// Context: settings are valid, new note doesn't exist.
			// ----------------------------------------------------------------
			// Get a list of all the files in the daily notes directory
			const find_all_notes = (path) => {
				const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
				let notes = [];
				if (abstract instanceof TFile && abstract.extension === "md") {
					notes.push(abstract);
				} else if (abstract instanceof TFolder) {
					for (let child of abstract.children) {
						notes = notes.concat(find_all_notes(`${path}/${child.name}`));
					}
				}
				return notes;
			}
			const notes = find_all_notes(this.settings.note_path);
			notes.sort((a, b) => {
				const a_name = a.path.slice(this.settings.note_path.length + 1);
				const b_name = b.path.slice(this.settings.note_path.length + 1);
				return window.moment(b_name, this.settings.date_format).valueOf()
					 - window.moment(a_name, this.settings.date_format).valueOf();
			});

			// Get the last note that's not today's.
			let last_note = null;
			let last_note_moment = null;
			for (let i=0; i < notes.length; i++) {
				// Remove the ".md" extension
				const sub_path = notes[i].path.slice(this.settings.note_path.length + 1).slice(0, -3);
				// The final boolean makes the moment parse in strict mode
				const note_moment = window.moment(sub_path, this.settings.date_format, true);
				if (note_moment.isValid() && note_moment.isBefore(NOW, 'day')) {
					last_note = notes[i];
					last_note_moment = note_moment;
					break;
				}
			}

			let last_note_structure = null;
			let last_note_section_lines = null;
			let last_note_remaining_lines = null;

			if (last_note) {
				const last_note_content = await this.app.vault.read(last_note);
				const {lines: last_note_all_lines} = split_lines(last_note_content);
				const last_note_lines = strip_frontmatter(last_note_all_lines);
				let last_note_initial_index = last_note_lines.indexOf(this.settings.initial);
				if (this.settings.initial === "") {
					last_note_initial_index = 0;
				} else if (last_note_initial_index === -1) {
					new Notice(`${last_note.basename} does not contain the specified initial heading... aborting.`);
					return;
				}
				let last_note_terminal_index = last_note_lines.indexOf(this.settings.terminal, last_note_initial_index);
				if (this.settings.terminal === "") {
					last_note_terminal_index = last_note_lines.length;
				} else if (last_note_terminal_index === -1) {
					new Notice(`${last_note.basename} does not contain the specified terminal heading... aborting.`);
					return;
				}
				last_note_section_lines = last_note_lines.slice(last_note_initial_index, last_note_terminal_index);
				last_note_structure = structurize(last_note_section_lines)

				// The lines which should stay behind are worked out in step 5,
				// once the template tells us which to-dos are excluded from
				// rollover.
			}

			// ----------------------------------------------------------------
			// Step 4
			// Context: settings are valid, new note doesn't exist,
			//          last note has been processed
			// ----------------------------------------------------------------

			// ------------------------------------------------------------
			// {{ date }} macro
			// ------------------------------------------------------------
			template_contents = template_contents.replace(/{{\s*date:?(.*?)\s*}}/g, (_, format) => {
				if (format) {
					return NOW.format(format)
				} else {
					// default format
					return NOW.format("YYYY-MM-DD")
				}
			});

			// ------------------------------------------------------------
			// {{ time }} macro
			// ------------------------------------------------------------
			template_contents = template_contents.replace(/{{\s*time:?(.*?)\s*}}/g, (_, format) => {
				if (format) {
					return NOW.format(format)
				} else {
					// default format
					return NOW.format("HH:mm")
				}
			});

			// ------------------------------------------------------------
			// {{ title }} macro
			// ------------------------------------------------------------
			template_contents = template_contents.replace(/{{\s*title\s*}}/g, NOTE_NAME);

			// ------------------------------------------------------------
			// {{ previous_note }} and {{ previous_note_path }} macros
			// ------------------------------------------------------------
			if (last_note === null) {
				template_contents = template_contents.replace(/{{\s*previous_note\s*}}/g, "");
				template_contents = template_contents.replace(/{{\s*previous_note_path\s*}}/g, "");
			} else {
				template_contents = template_contents.replace(/{{\s*previous_note\s*}}/g, last_note.basename);
				template_contents = template_contents.replace(/{{\s*previous_note_path\s*}}/g, last_note.path);
			}

			// ------------------------------------------------------------
			// {{ obligate }} macro
			// ------------------------------------------------------------
			const template_lines = template_contents.split('\n')
			let processed_lines = [];
			for (let i = 0; i < template_lines.length; i++) {
				const line = template_lines[i];
				// If this is an obligator line, then go ahead and run the
				// logic which deterimnes if we should now obligate
				if (OBLIGATION_REGEX.test(line)) {
					// Increment the iterator so we skip over the next line
					i++;
					let should_trigger = should_trigger_obligation(line, NOW);
					// If there is no source note, then we would only
					// trigger above.
					if (!should_trigger && last_note) {
						// Walk forward from the source note date (+1) and
						// check every skipped date.
						const sub_path = last_note.path.slice(this.settings.note_path.length + 1);
						let skipped_moment = window.moment(sub_path, this.settings.date_format);
						while (skipped_moment.add(1, 'd').isBefore(NOW) && !should_trigger) {
							should_trigger = should_trigger_obligation(line, skipped_moment);
						}
					}
					if (should_trigger) {
						// This is the NEXT line, since we incremented the
						// iterator above. Reading past the end of an array
						// returns undefined rather than throwing, so this has
						// to be checked explicitly.
						if (i >= template_lines.length) {
							new Notice(`Template malformed, "${line}" must be followed by another line`);
							return;
						}
						processed_lines.push(template_lines[i]);
					}
				// Not an obligator line, so just add it.
				} else {
					processed_lines.push(line);
				}
			}

			let processed_initial_index = processed_lines.indexOf(this.settings.initial);
			if (this.settings.initial === "") {
				processed_initial_index = 0;
			} else if (processed_initial_index === -1) {
				new Notice(`${TEMPLATE_FILE.basename} does not contain the specified initial heading... aborting.`);
				return;
			}
			let processed_terminal_index = processed_lines.indexOf(this.settings.terminal);
			if (this.settings.terminal === "") {
				processed_terminal_index = processed_lines.length;
			} else if (processed_terminal_index === -1) {
				new Notice(`${TEMPLATE_FILE.basename} does not contain the specified terminal heading... aborting.`);
				return;
			}
			let template_structure = structurize(processed_lines.slice(processed_initial_index, processed_terminal_index));
			const OUTPUT_INITIAL_LINES = processed_lines.slice(0, processed_initial_index)
			const OUTPUT_TERMINAL_LINES = processed_lines.slice(processed_terminal_index)

			// To-dos which the template already provides are not rolled over
			// from the previous note; the template's own copy is used instead.
			// With "Only !STREAK tagged Todos" on, that applies to habit lines
			// only and every other to-do rolls over as usual. Matching is done
			// on the task text with the bullet, checkbox state and indentation
			// stripped, so yesterday's "- [x] Wake early !STREAK" still matches
			// the template's "- [ ] Wake early !STREAK".
			const template_task_texts = this.settings.dont_rollover_template
				? collect_unfinished_task_texts(template_structure, new Set())
				: new Set();

			const skip_rollover = (line) => {
				if (template_task_texts.size === 0) return false;
				if (this.settings.dont_rollover_only_habit
					&& !HABIT_TAG_REGEX.test(line)) {
					return false;
				}
				const text = task_text(line);
				return text !== null && template_task_texts.has(text);
			};

			// ----------------------------------------------------------------
			// Step 5
			// Context: settings are valid, new note doesn't exist,
			//          last note has been processed,
			//          template has been processed
			// ----------------------------------------------------------------
			// Work out what the previous note keeps. To-dos which really move
			// are removed from it; the ones excluded from rollover stay behind
			// with everything nested under them.
			if (this.settings.move_todos && last_note_section_lines !== null) {
				last_note_remaining_lines = destructure(
					drop_todos(
						structurize(last_note_section_lines),
						(line) => is_unfinished_line(line) && !skip_rollover(line),
						(line) => is_unfinished_line(line) && skip_rollover(line)
					)
				);
			}

			// Keep the excluded to-dos out of the merge, so they don't appear
			// twice in the new note.
			if (last_note_structure) {
				last_note_structure = drop_todos(
					last_note_structure,
					(line) => is_unfinished_line(line) && skip_rollover(line)
				);
			}

			// Delete from last_note_structure only if this setting is true
			if (last_note_structure) {
				if (this.settings.keep_template_headings) {
					filter_structure(last_note_structure,
									 this.settings.delete_empty_headings,
									 this.settings.keep_until_parent_complete,
									 this.settings.move_todos);
				}
				merge_structure(
					template_structure,
					last_note_structure
				);
			}

			// Freeze relative aliases (!today, !tomorrow, ...) coming from the
			// previous note to the calendar day they meant there, so a to-do
			// due today doesn't drift to "tomorrow" again in the new note.
			// This runs after the merge: to-dos copied verbatim are still the
			// same objects here, while to-dos the template already provides
			// keep the template's relative wording on purpose.
			if (last_note_structure && last_note_moment) {
				pin_aliases_in_structure(
					last_note_structure,
					last_note_moment.toDate(),
					NOW.toDate()
				);
			}

			// Delete from the merged structure is false
			if (!this.settings.keep_template_headings) {
				filter_structure(template_structure,
								 this.settings.delete_empty_headings,
								 this.settings.keep_until_parent_complete,
								 this.settings.move_todos);
			}

			// Bring the closest due dates to the top of each heading.
			if (this.settings.rearrange_by_due) {
				sort_structure_by_due(template_structure, NOW.toDate());
			}

			let new_note_lines = OUTPUT_INITIAL_LINES.concat(destructure(template_structure)).concat(OUTPUT_TERMINAL_LINES);

			const directories = NEW_NOTE_PATH.split('/').slice(0,-1);
			for (let i = 1; i <= directories.length; i++) {
				const sub_path = directories.slice(0,i).join('/');
				const abstract = this.app.vault.getAbstractFileByPath(normalizePath(sub_path));
				if (abstract === null) {
					this.app.vault.createFolder(sub_path);
				}
			}

			output_file = await this.app.vault.create(NEW_NOTE_PATH, new_note_lines.join('\n'));

			// Open up the new file
			if (output_file != undefined && output_file instanceof TFile) {
				await ACTIVE_LEAF.openFile(output_file);
			}

			// Apply the next_note and next_note_path macros to the old file
			if (last_note instanceof TFile) {
				await this.app.vault.process(last_note, (data) => {
					let updated = data;
					if (this.settings.move_todos && last_note_remaining_lines !== null) {
						updated = replace_section(
							updated,
							this.settings.initial,
							this.settings.terminal,
							last_note_remaining_lines
						);
					}
					if (output_file instanceof TFile) {
						updated = updated.replace(/{{\s*next_note\s*}}/g, output_file.basename);
						updated = updated.replace(/{{\s*next_note_path\s*}}/g, output_file.path);
					}
					return updated;
				});
			}

			if (this.settings.archive && last_note) {

				const last_note_name = last_note.path.slice(this.settings.note_path.length + 1);
				const last_note_moment = window.moment(last_note_name, this.settings.date_format);
				const archive_note_name = last_note_moment.format(ARCHIVE_DATE_FORMAT);
				const archive_note_path = `${this.settings.archive_path}/${archive_note_name}.md`;
				try {
					const archive_directories = archive_note_path.split('/').slice(0,-1);
					for (let i = 1; i <= archive_directories.length; i++) {
						const sub_path = archive_directories.slice(0,i).join('/');
						const abstract = this.app.vault.getAbstractFileByPath(normalizePath(sub_path));
						if (abstract === null) {
							await this.app.vault.createFolder(sub_path);
						}
					}
					await this.app.fileManager.renameFile(last_note, archive_note_path);
				} catch (error) {
					new Notice(`A file called ${archive_note_path} already exists, archival skipped.`);
				}
			}

		};

		// This creates an icon in the left ribbon.
		// This function is called when the user clicks the icon.
		this.addRibbonIcon('carrot', `Open today's Daily Todos`, run_obligator);

		// Add the command to open today's Obligator note
		this.addCommand({
			id: "obligator-run",
			name: "Open today's note",
			callback: run_obligator
		});

		this.app.workspace.onLayoutReady(async () => {
			// Run obligator if the user has enabled the startup setting.
			if (this.settings.run_on_startup) {
				run_obligator();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ObligatorSettingTab(this.app, this));

		// Reading-view pills are drawn by markdown post-processors, which only
		// run when the note is rendered. Re-render open reading views when a
		// setting changes, debounced so typing a moment format does not
		// re-render every open note on each keystroke.
		this.refresh_reading_views = debounce(() => {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (view && view.getMode?.() === "preview") {
					view.previewMode?.rerender(true);
				}
			}
		}, 150, true);

		// Habit streaks: render a pill next to !STREAK to-dos in reading view and
		// in live preview.
		register_habit_streaks(this);

		// Due date and due time pills: !2026-10-10, !today, !15:30 and friends
		// become coloured pills in reading view and live preview.
		register_due_pills(this);

		// Completion stamps: when a to-do is checked, append !duedate@compdate
		// (or !compdate@compdate if there is no due date). Unchecking removes
		// the marker again.
		register_completion_annotations(this);

		const invalidate_streaks = () => {
			clear_streak_cache();
			refresh_live_preview_streaks();
		};
		this.registerEvent(this.app.vault.on('modify', invalidate_streaks));
		this.registerEvent(this.app.vault.on('create', invalidate_streaks));
		this.registerEvent(this.app.vault.on('delete', invalidate_streaks));
		this.registerEvent(this.app.vault.on('rename', invalidate_streaks));

	}

	onunload() {
		this.refresh_reading_views?.cancel();
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Migrate the old two-option "Due pill text" setting to the new
		// wording/type pair so existing vaults keep roughly the same pills.
		if (data && data.due_date_text === undefined && data.due_pill_format !== undefined) {
			const named = data.due_pill_format === 'named';
			this.settings.due_date_text = named ? 'relative' : 'countdown';
			this.settings.due_date_text_type = named ? 'due' : 'remaining';
		}
		delete this.settings.due_pill_format;
	}

	async saveSettings(changed_key) {
		// Streak resolution only depends on where notes live and how their dates
		// are formatted. Cosmetic settings should not throw away the cache and
		// recompute streaks across the vault.
		const streak_keys = [
			"note_path",
			"date_format",
			"archive",
			"archive_path",
			"archive_date_format"
		];
		if (changed_key === undefined || streak_keys.includes(changed_key)) {
			clear_streak_cache();
			refresh_live_preview_streaks();
		}
		refresh_due_pills();

		// Reading-view pills are drawn by markdown post-processors, so the notes
		// have to be re-rendered for changed settings to apply immediately.
		this.refresh_reading_views?.();

		await this.saveData(this.settings);
	}
}

class ObligatorSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this._headingOptions = { "": "(none)" };
		void this.refreshHeadings();
	}

	async getHeadings(file_path) {
		if (!file_path) return [];
		let file = this.app.vault.getAbstractFileByPath(file_path);
		if (file === null) {
			file = this.app.vault.getAbstractFileByPath(`${file_path}.md`);
		}
		if (file === null || !(file instanceof TFile)) return [];
		const content = await this.app.vault.read(file);
		return Array.from(content.matchAll(HEADING_REGEX_GLOBAL), (match) => match[0]);
	}

	headingOptions() {
		const options = { "": "(none)", ...this._headingOptions };
		for (const key of ["initial", "terminal"]) {
			const value = this.plugin.settings[key];
			if (value && !options[value]) options[value] = value;
		}
		return options;
	}

	async refreshHeadings() {
		try {
			const headings = await this.getHeadings(this.plugin.settings.template_path);
			this._headingOptions = {};
			for (const heading of headings) {
				this._headingOptions[heading] = heading;
			}
		} catch (e) {
			this._headingOptions = {};
		}
		if (typeof this.update === "function") this.update();
	}

	async setControlValue(key, value) {
		if (key === "initial" || key === "terminal") {
			this.plugin.settings[key] = value || "";
		} else {
			this.plugin.settings[key] = value;
		}
		await this.plugin.saveSettings(key);
		if (key === "template_path") {
			void this.refreshHeadings();
		}
	}

	renderMomentFormat(setting, key, defaultFormat, sampleLabel) {
		setting.controlEl.empty();
		let formatter;
		setting.addMomentFormat((format) => {
			formatter = format
				.setDefaultFormat(defaultFormat)
				.setPlaceholder(defaultFormat)
				.setValue(this.plugin.settings[key] || defaultFormat)
				.onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings(key);
				});
		});
		const sampleEl = setting.descEl.createEl("b", { cls: "u-pop" });
		formatter.setSampleEl(sampleEl);
		setting.descEl.append(
			"For syntax information, refer to the ",
			setting.descEl.createEl("a", {
				href: "https://momentjs.com/docs/#/displaying/format/",
				text: "moment documentation"
			}),
			setting.descEl.createEl("br"),
			sampleLabel,
			sampleEl
		);
	}

	getSettingDefinitions() {
		const headings = this.headingOptions();
		// Every setting gets its own card. A parent setting and the settings that
		// depend on it share one card, so the relationship is obvious without
		// having to read every description.
		const card = (definition) => ({
			type: "group",
			cls: "obligator-setting-card",
			items: [definition],
		});
		const paired = (...definitions) => ({
			type: "group",
			cls: "obligator-setting-card obligator-paired-setting",
			items: definitions,
		});
		const section = (heading) => ({
			type: "group",
			cls: "obligator-setting-section",
			heading,
		});

		return [
			card({
				name: "New file directory",
				desc: "New daily notes will be placed here.",
				control: { type: "folder", key: "note_path" },
			}),
			card({
				name: "Template file",
				desc: "New daily notes will use the template file specified. It must be a Markdown file.",
				control: {
					type: "file",
					key: "template_path",
					filter: (file) => file.extension === "md",
				},
			}),
			card({
				name: "Date format",
				render: (setting) => this.renderMomentFormat(
					setting,
					"date_format",
					DEFAULT_SETTINGS.date_format,
					"Today's note would look like this: "
				),
			}),
			card({
				name: "Initial heading",
				desc: "The heading from the template which begins what Daily Todos will copy. Everything before this heading is ignored. If left blank, copying starts at the beginning of the file.",
				control: {
					type: "dropdown",
					key: "initial",
					options: headings,
					defaultValue: "",
				},
			}),
			card({
				name: "Terminal heading",
				desc: "The heading from the template which ends what Daily Todos will copy. Everything after this heading is ignored. If left blank, copying continues to the end of the file.",
				control: {
					type: "dropdown",
					key: "terminal",
					options: headings,
					defaultValue: "",
				},
			}),
			card({
				name: "Open daily note on startup",
				desc: "Open your daily note automatically when you open this vault.",
				control: { type: "toggle", key: "run_on_startup" },
			}),
			section("Archive"),
			paired(
				{
					name: "Enable archival of old notes",
					desc: "Move the previous daily note into the archive directory when a new note is created. The note is renamed using the archive date format.",
					control: { type: "toggle", key: "archive" },
				},
				{
					name: "Archive directory",
					desc: "Archived notes will be moved here.",
					control: {
						type: "folder",
						key: "archive_path",
						disabled: () => !this.plugin.settings.archive,
					},
				},
				{
					name: "Archive date format",
					disabled: () => !this.plugin.settings.archive,
					render: (setting) => this.renderMomentFormat(
						setting,
						"archive_date_format",
						DEFAULT_SETTINGS.archive_date_format,
						"The archival path for today's note would look like this: "
					),
				}
			),
			section("Completion"),
			card({
				name: "Append completion date",
				desc: "Add the completion date (!@DD/MM/YY) to to-dos that have no due date or due time. To-dos that already have a due date or due time are always stamped with their completion date.",
				control: { type: "toggle", key: "append_completion_date" },
			}),
			card({
				name: "Append completion time",
				desc: "Add the completion time (!@HH:MM) to to-dos that have no due date or due time. To-dos that already have a due date or due time are always stamped with their completion time.",
				control: { type: "toggle", key: "append_completion_time" },
			}),
			section("Advanced"),
			paired(
				{
					name: "Delete empty headings",
					desc: "Delete headings that have no non-whitespace children when you create a new daily note. Turning this off leaves all headings untouched.",
					control: { type: "toggle", key: "delete_empty_headings" },
				},
				{
					name: "Don't delete headings from template",
					desc: "Prevent the setting above from deleting headings that are present in the template.",
					control: {
						type: "toggle",
						key: "keep_template_headings",
						disabled: () => !this.plugin.settings.delete_empty_headings,
					},
				}
			),
			card({
				name: "Only delete to-dos when parent is complete",
				desc: "Keep child to-dos until their parent and all of its children are checked.",
				control: { type: "toggle", key: "keep_until_parent_complete" },
			}),
			card({
				name: "Move to-dos to the new note",
				desc: "Remove rolled-over to-dos from the previous note once they have been added to the new note. When disabled, the previous note keeps its unfinished to-dos.",
				control: { type: "toggle", key: "move_todos" },
			}),
			paired(
				{
					name: "Don't rollover todos from template",
					desc: "If an unfinished to-do in the previous note has the same text as an unfinished to-do in the template, don't roll it over; the new note uses the template's copy instead.",
					control: { type: "toggle", key: "dont_rollover_template" },
				},
				{
					name: "Only !STREAK tagged todos",
					desc: "Apply the setting above to !STREAK tagged to-dos only. Every other to-do rolls over even when the template also contains it.",
					control: {
						type: "toggle",
						key: "dont_rollover_only_habit",
						disabled: () => !this.plugin.settings.dont_rollover_template,
					},
				}
			),
			card({
				name: "Re-arrange rolled-over todos by due date",
				desc: "Order to-dos by their due date within each heading in the new note, closest first. To-dos without a due date keep their original order after the dated ones.",
				control: { type: "toggle", key: "rearrange_by_due" },
			}),
			card({
				name: "Due date text type",
				desc: "Choose whether date pills read \"Due ...\" or describe the time remaining (\"... left\", \"... passed\"). Exact dates drop the \"Due\" prefix when set to Remaining.",
				control: {
					type: "dropdown",
					key: "due_date_text_type",
					defaultValue: "due",
					options: {
						due: "Due",
						remaining: "Remaining",
					},
				},
			}),
			paired(
				{
					name: "Due date text",
					desc: "Choose how due date pills are worded: an exact date, a relative name, a day count, or a relative countdown. Due time pills always show the time.",
					control: {
						type: "dropdown",
						key: "due_date_text",
						defaultValue: "relative",
						options: {
							exact: "Exact date (Due Jan 1, 2026)",
							relative: "Relative (Due Today, Due This Week, ...)",
							days: "Days countdown (Due in 67 Days)",
							countdown: "Relative countdown (Due in 2 Years, Overdue by 3 Days)",
						},
					},
				},
				{
					name: "Exact date format",
					desc: "Moment format used by exact date pills. The default is MMM D, YYYY.",
					disabled: () => this.plugin.settings.due_date_text !== "exact",
					render: (setting) => this.renderMomentFormat(
						setting,
						"due_date_format",
						DEFAULT_SETTINGS.due_date_format,
						"An exact date pill would look like this: "
					),
				}
			),
		];
	}
}
