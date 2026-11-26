# Your own database

Arise can keep a copy of your data in a database you own, as plain tables you can query with SQL.
Turn it on in Settings or in Setup and connections, under **Your own database**.

This is **less private**. Your synced copy stays end-to-end encrypted, but this copy is plain text:
anyone with the database's token can read it, and so can the company that runs the database.

## How it works

- For now the database is [Turso](https://turso.tech) (libSQL, which is SQLite). The free plan is enough.
- You paste the database URL (`libsql://...`) and a token with read and write. The token stays on
  the device you pasted it on. It is never synced and never in a backup.
- Arise copies from that device, a few seconds after each change, in small batches. If Turso is
  busy or you're offline, it tries again later.
- **What goes in**: each section can be on or off. Notes from your days start off. Turning a section
  off deletes its rows from your database.
- **Check** writes a test row and reads it back.
- **Copy everything now** empties the tables and copies everything again.
- **Stop and forget the connection** removes the URL and token from the device. Your database and
  what's in it stay yours. Delete them in Turso if you want them gone.
- Each device copies on its own. Connect on another device too if you want it to copy from there.

## The tables

Every table has `id TEXT PRIMARY KEY`. Times are milliseconds since 1 January 1970 (UTC). Days are
`YYYY-MM-DD`. Yes or no is `1` or `0`. Anything not set is `NULL`. Deleted things are deleted here too.

### Goals and quests

| Table | Columns |
| --- | --- |
| `goals` | `title`, `category`, `why`, `by_when` (as you wrote it), `status` (active, paused, done), `created_day`, `changed_at` |
| `quests` | `goal_id`, `title`, `how`, `schedule` (`daily`, `Mon Wed Fri`, or `3 a week`), `target`, `unit`, `created_day`, `archived_day` |
| `ticks` | one per quest per day: `day`, `quest_id`, `done`, `amount`, `changed_at`. The id is `day:quest_id`. |
| `milestones` | `goal_id`, `title`, `due_day`, `done_day` |
| `measures` | `goal_id`, `name`, `unit`, `start`, `target`, `better` (up or down) |
| `measure_values` | `measure_id`, `day`, `value`, `changed_at`. The id is `measure_id:day`. |

### Everything else

| Table | Section | Columns |
| --- | --- | --- |
| `todos` | To-dos | `title`, `day`, `at_time` (HH:MM), `done_at`, `big`, `added_by` (an AI app, if one added it), `created_at`, `changed_at` |
| `events` | Calendar events | `title`, `starts`, `ends` (`YYYY-MM-DD` for a whole day, else `YYYY-MM-DDTHH:MM`), `all_day`, `time_zone`, `location`, `notes`, `repeats` (JSON, like `{"freq":"weekly","days":[1]}`), `guests`, `added_by`, `created_at`, `changed_at` |
| `checkins` | Check-ins | one per day, the id is the day: `day`, `sleep`, `energy`, `mood` (1 to 5), `words` (what you wrote), `journal` (the journal Arise wrote), `changed_at` |
| `money_owed` | Money owed | `who`, `amount`, `currency`, `direction` (`they owe you` or `you owe them`), `what`, `due_day`, `settled_at`, `created_at`, `changed_at` |
| `groceries` | Groceries | `name`, `qty`, `got_at`, `created_at`, `changed_at` |
| `people` | People | `name`, `keep_in_touch` (week, 2weeks, month), `last_in_touch`, `dates` (like `Birthday 03-14`), `hidden`, `changed_at` |
| `workouts` | Workouts and weigh-ins | `day`, `workout`, `name`, `started_at`, `finished_at`, `easy`, `exercises` (JSON: each exercise with its reps) |
| `weigh_ins` | Workouts and weigh-ins | one per day: `day`, `weight`, `waist`, `shoulders`, `changed_at` |
| `notes` | Notes from your days | the newest 5,000: `at`, `title`, `detail`, `source` (`manual` for ones you added, `other` for ones you brought in), `app` (like `obsidian`) |

`arise_info` has `key` and `value`: `schema` (the shape of the tables, now `1`), `copied_at` and
`check`. Arise only writes to these tables. Add your own tables next to them if you like.

## Examples

```sql
-- To-dos still open, soonest first
SELECT title, day, at_time FROM todos WHERE done_at IS NULL ORDER BY day IS NULL, day, at_time;

-- Mood by week
SELECT strftime('%Y-%W', day) AS week, round(avg(mood), 1) AS mood FROM checkins GROUP BY week ORDER BY week;

-- How often each quest got done in the last 30 days
SELECT q.title, sum(t.done) AS done FROM ticks t JOIN quests q ON q.id = t.quest_id
WHERE t.day >= date('now', '-30 days') GROUP BY q.id ORDER BY done DESC;

-- Who owes you, in total
SELECT who, currency, sum(amount) FROM money_owed
WHERE direction = 'they owe you' AND settled_at IS NULL GROUP BY who, currency;
```

Open them in the Turso dashboard (the database's Edit data or Shell), with the `turso db shell`
command, or with any libSQL or SQLite tool.

## Not yet

- **MongoDB Atlas and Azure DocumentDB.** A browser can't talk to them directly, so this needs a
  small helper on a server (`worker/mirror`) that takes the connection string on each call. That
  helper would see the connection string and the data as they pass through. It isn't built yet.
- Linked calendars, imported history (other than notes), photos and files, and the coach's chats
  aren't copied.
