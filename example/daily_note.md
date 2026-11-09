# {{date:YYYY-MM-DD-dddd}}

## Habits
- [ ] Morning routine !STREAK
- [ ] Exercise !STREAK
- [ ] Read !STREAK
- [-] Skipped habit example !STREAK

## Tasks

## Meetings

## Notes

## Recurring Examples

### Using {{ obligate }} (cron-style)
{{ obligate 1,15 * * }}
- [ ] Pay bills (1st and 15th of every month)

{{ obligate * * 1 }}
- [ ] Team standup (every Monday)

{{ obligate * * 3 }}
- [ ] Review progress (every Wednesday)

{{ obligate * * 5 }}
- [ ] Weekly wrap-up (every Friday)

{{ obligate * * * }}
- [ ] Daily check-in (every day)

{{ obligate 1 1 * }}
- [ ] New Year goals review (1st of January)

{{ obligate * 1-6 1,3,5 }}
- [ ] Morning workout (Mon/Wed/Fri for first half of year)

{{ obligate 1 1,4,7,10 * }}
- [ ] Quarterly review (1st of each quarter)

{{ obligate 1/3 * * }}
- [ ] Task every 3rd day of month starting from 1st

{{ obligate * 1/3 * }}
- [ ] Task every 3rd month starting from January

{{ obligate * * 1/3 }}
- [ ] Task every 3rd day of week starting from Monday

### Using {{ every }} (readable syntax)
{{ every day }}
- [ ] Review tasks for today

{{ every day 1,15 }}
- [ ] Check budget (1st and 15th)

{{ every day 1-7 }}
- [ ] Early week check-in

{{ every 2 day }}
- [ ] Water plants every 2nd day

{{ every 1/3 day }}
- [ ] Every 3rd day of month starting from 1st

{{ every monday }}
- [ ] Monday meeting prep

{{ every friday }}
- [ ] End of week review

{{ every january }}
- [ ] Annual review prep (1st of January)

{{ every week }}
- [ ] Weekly planning (every Monday)

{{ every week 1,2 }}
- [ ] Biweekly sync

{{ every 2 week }}
- [ ] Every 2nd week of month

{{ every month }}
- [ ] First of month checklist

{{ every month 1,6,12 }}
- [ ] Quarterly-ish reviews (Jan, Jun, Dec)

{{ every 3 month }}
- [ ] Every 3rd month

{{ every year }}
- [ ] Yearly goals review

{{ every year 2026,2027,2028 }}
- [ ] Multi-year project check-in

{{ every 2026/2 year }}
- [ ] Every 2 years starting from 2026

---

Created on {{date}} {{time}}
Previous note: [[{{previous_note_path}}|{{previous_note}}]]
Next note: [[{{next_note_path}}|{{next_note}}]]
