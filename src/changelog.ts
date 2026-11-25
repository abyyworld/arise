// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '1.36.0',
    notes: [
      'Loose ends: when your notes say "I\'ll email Eyal" or "need to book the dentist", Arise asks a day later whether it happened, and makes it a to-do if you like.',
      'Getting to know you: on a quiet day, one short question about you. Your answer stays in your notes, so your coach learns it.',
      'Your coach now keeps separate chats: start a new one, go back to an old one, rename or delete it, or forget every chat. New: Ask how I\'m doing.',
      'Arise can read your new notes and files for you: a one-line description, a tidy copy of your note and a few tags, with the private AI. Turn it on in Settings, Your life log. Search finds them by these too.',
      'Your links, on Days: every link in your notes, with search. Keep a copy of a page to read later, even if the site goes away.',
      'With the Arise browser extension: save the page you are on in one press or a right click, and get your reminders in the browser even with Arise closed.',
      'AI apps on the web turn off by themselves after 60 days without use.',
    ],
  },
  {
    version: '1.35.2',
    notes: [
      'A simpler tab bar: Coach and Goals are now under Me, in More of Arise. Want them back on the bar? Settings, Tabs.',
    ],
  },
  {
    version: '1.35.1',
    notes: [
      'Google is here: link your Google Calendar, Gmail (who wrote, the subject and a short preview, never the whole email) and Drive files you pick, in Setup and connections. Google shows a warning first because it has not checked Arise yet: tap Advanced, then Go to Arise.',
    ],
  },
  {
    version: '1.35.0',
    notes: [
      'See where your time goes on a map: tap a place for its visits and time, and give it a name like Home or Lab. The map is drawn on your device; the street map underneath is optional.',
      'Your world, on Me: your goals, people and places as a constellation, a turning globe, or a simple list.',
      'Look back: see any day, month or year, and what Arise knew about you then.',
      'Not quite right? Fix any record, or tell Arise what is true, and it stays fixed.',
      'Photos and files is now a file manager: folders, project folders on your goals, search, sorting, a grid or a list, and moving or deleting several at once. Deleted files wait in the trash for 30 days, and Arise finds exact copies so you keep just one.',
      'A quick one: short questions from your coach on Today, like the 3 things that matter this week, or whether a late to-do still matters. Your answer does the thing straight away.',
      'Morning brief: your day in a few lines, on Today and as a notification at the time you pick (Settings, Your plan and next steps).',
      'Invite people to an event: add who is coming, then send an invite they can accept in their own calendar.',
      'Sign in with a passkey: your face, fingerprint or screen lock instead of your password. Where your device can, the passkey unlocks your data too. Add or remove them in Settings, Account, More, Passkeys.',
      'Rules for each AI app: what it may just do, what it must ask you first, and what it may never do, plus house rules in your own words.',
      'System health, in Setup and connections: one check that says whether sync, the AI, reminders, AI apps, calendars and your storage are working.',
    ],
  },
  {
    version: '1.34.0',
    notes: [
      'One box on Today: write anything. Arise works out if it is a to-do (with its day and time), groceries, money owed, a question for your coach or a note, and shows you before saving. Pick another kind if it guessed wrong. You can add a file too.',
      'Who owes whom: keep track of money you lent or borrowed, per person, with a day to pay back. Write "Sam owes me 10 for lunch" in the box, or add it on Today.',
      'Groceries: a shopping list on Today. Write "buy milk and eggs" in the box, tick things off as you buy them.',
      'What matters, and when: the next 14 days in four boxes, from Do now to Can wait. Tap What matters on your plan. Mark a to-do as Matters a lot to move it up.',
      'Write it my way: on Coach, turn rough notes into a message, email, post or comment that sounds like you. Only those words go to the AI.',
      'Bring in notes from Obsidian, Notion, Apple Notes and Google Keep, plus Word files, PDFs and Fitbit, in Your history.',
      'Take your whole life log out as notes for Obsidian, one file for each day.',
    ],
  },
  {
    version: '1.33.0',
    notes: [
      'Your own storage: keep photos and files in your own free Cloudflare storage, up to 10 GB and 200 MB a file, instead of 250 MB. They are still encrypted on your device first, so Cloudflare cannot open them. In Photos and files.',
    ],
  },
  {
    version: '1.32.0',
    notes: [
      'Sign in with Google on the web, if you like. You still make an Arise password: it locks your data, so Google can\'t read it. Marked less private, because Google learns you use Arise. Already have an account? Turn it on in Settings, Account, More.',
    ],
  },
  {
    version: '1.31.0',
    notes: [
      'Your plan: Today now plans the rest of your day around your calendar, with hard work in the hours you think best. When your day changes, the plan changes too and says what moved. Tap This week to see the days ahead.',
      'Heads up: early warnings when a deadline is close with nothing done, your sleep is sliding, or someone you talk to most weeks has gone quiet.',
      'Help me decide: on Coach, ask about a choice. Arise lays out the options with what each costs you, says which it would pick and why, and asks later how it went.',
      'Next-step messages: a few at the right moment, from your plan. Choose how many a day and when Arise stays quiet, in Settings.',
      'Bring in your chats with Claude, ChatGPT and Gemini. Pick the ones you want, and delete any of them later.',
      'Import a calendar file now brings in its to-dos too, with their day and time, on your to-do list.',
    ],
  },
  {
    version: '1.30.0',
    notes: [
      'Calendar: a new tab with month, week, day and list views. Add your own events with times, repeats and reminders, and see your to-dos and other calendars in the same place. Bring events in from a calendar file, or save yours as one. Your events are locked on your device before they sync, and their reminders come from your device only.',
      'Photos and files: keep them with your days, locked on your device before they sync. Add one to a note, to a day on Days, or in Setup and connections, Photos and files.',
      'Search by meaning: download a small model once (about 36 MB) and search your days by what you mean, not only the words. It runs on your device. In Days, search.',
      'Sign out of all devices, from Account, More. Each device signs out the next time it is online.',
      'GitHub backup (optional): keep your daily backup in a private GitHub repository too, locked with a backup password. GitHub only sees scrambled data.',
      'Calendars by link: add any calendar by its private link (ICS or webcal), and its events show on your Calendar and in Days.',
      'Google Drive: pick Drive files and Arise reads their text, like your GitHub notes. Marked less private.',
      'Add to your day from Today too, with a title and a file or photo. A text file\'s words go into the note.',
    ],
  },
  {
    version: '1.29.0',
    notes: [
      'Bring in your chats from Telegram, Instagram, Messenger, X, TikTok, Snapchat, Discord and LinkedIn. Download your data from the app, then add the file in Setup and connections. It is read on your device.',
      'Location on a timer: on your phone, choose Places only or a point every 5, 15, 30 or 60 minutes (or any number you like). You can round it to about 1 km and add places that are never noted. Your places show on Days, where you can delete any of them.',
      'Pause everything: stop Arise reading anything, on every device, for an hour, a day or until you turn it back on.',
      'Apps Arise never reads: banking, health and password apps are left out from the start, and you can add any app you like, on Android and on the Mac.',
      'More from Android, each off until you turn it on: text messages, photos taken (when and where, never the photo), Bluetooth and Wi-Fi connections, and phone unlocks. On iPhone: photos taken, and three ready-made Shortcuts automations.',
      'Update Arise on all your devices: until each one has this version, it waits before syncing. The iPhone app needs the new Arise.ipa installed once by hand.',
    ],
  },
  {
    version: '1.28.0',
    notes: [
      'Link GitHub: pick the repositories Arise may read, with a read-only key you make for just those. Your commits go into your days, and the notes and goals you keep there (like README or goals files) into what Arise knows. In Setup and connections, Connections, Accounts.',
      'The key stays on your device, and what Arise reads stays private: only the private AI or the AI on your device reads it, unless you allow the less private ones.',
    ],
  },
  {
    version: '1.27.0',
    notes: [
      'Arise has a shorter address: abyyworld.github.io/arise. Your data, your account and your settings stay as they are, and old links and home-screen icons still open Arise.',
      'Added the browser extension by hand (Load unpacked)? Get it again from Setup and connections, unzip it over the same folder, and press Reload on its card in your browser\'s extensions page. It stays linked.',
    ],
  },
  {
    version: '1.26.1',
    notes: [
      'Adding the browser extension: Arise pages already open refresh by themselves once it\'s added, and if Arise still can\'t see it, a Reload this page button is right there. The extension now points to Setup and connections.',
    ],
  },
  {
    version: '1.26.0',
    notes: [
      'Your files: on a computer, give Arise your Filen folder (or iCloud Drive, Dropbox, OneDrive) once, and it keeps a backup there every day, the newest 7. That folder\'s own app puts it on your other devices. Arise never signs in to any of them. In Setup and connections, Connections.',
      'Put the browser extension in that folder too, ready for your other computers. Adding the extension is clearer: download it, then three short steps.',
      'On a phone, Save backup lets you pick Filen or another app straight away.',
    ],
  },
  {
    version: '1.25.0',
    notes: [
      'Your most-visited sites on Today, one tap away. Counted from the sites you visit (with the browser extension, a Chrome history import or the Mac helper), on this device only.',
    ],
  },
  {
    version: '1.24.0',
    notes: [
      'A new Today: a big hello for the time of day, and your day at a glance (what is on your calendar, your to-dos and the quests left). Tap any of them to go there.',
      'Atmospheres: a live night sky with shooting stars, a slow sunrise, an aurora, or calm colour washes. Pick one with Atmosphere at the top of Today. Cards turn to frosted glass over it. Less motion keeps it still.',
      'Setting up is now four clear steps: your account, your AI coach, your connections, and a review of everything. Each has a short guide, step by step, and the switches that do it.',
    ],
  },
  {
    version: '1.23.0',
    notes: [
      'Search your days by meaning: "exercise" also finds your runs, workouts and gym visits, "food" your lunches and restaurants. Related things show under the matches. All of it on your device, with no AI.',
    ],
  },
  {
    version: '1.22.0',
    notes: [
      'Backgrounds: pick a calm colour wash for Arise (Dawn, Sea, Forest or Dusk) in Settings, Look. It drifts very slowly.',
      'Less motion: turn off moving backgrounds and animations in Settings, Look. Your device\'s own "reduce motion" always counts too.',
    ],
  },
  {
    version: '1.21.0',
    notes: [
      'A calendar: open it from your to-dos. Each day with to-dos or calendar events has a dot; pick a day to see them and add a to-do for it.',
      'To-dos can have a time, and Arise reminds you then. Tap a to-do to change its words, day or time.',
    ],
  },
  {
    version: '1.20.0',
    notes: [
      'To-dos on Today: add anything you want to get done, with a day if it has one, and tick it off. Overdue ones stay at the top, and what\'s coming up shows below.',
      'Your coach sees your to-do list, and it syncs with the rest, end-to-end encrypted.',
      'Apps you let add notes on the web can add to-dos too ("remind me to call mum on Friday"), marked with their name.',
    ],
  },
  {
    version: '1.19.0',
    notes: [
      'Setup and connections: one screen shows every part of Arise worth setting up, where each stands, and how far along you are. Open it from Days.',
      'It says what to do next, and each part takes you straight to where it\'s set up. Less private choices are marked.',
    ],
  },
  {
    version: '1.18.0',
    notes: [
      'Claude, ChatGPT and Gemini on the web can now know you: in What Arise knows, Connected apps, open an app and tap "Use it on the web". Copy the address into the app, and it reads only what you picked for it.',
      'It\'s marked Less private and stays off until you turn it on, for each app on its own. Arise explains what that means first. Pick an end date (a week, a month or none) and turn it off any time.',
      'If you allow it, the app can add notes to your days when you ask ("log that I ran 5 km"). They show up marked with its name.',
      'See what each app did and when, under What it did.',
    ],
  },
  {
    version: '1.17.2',
    notes: [
      'A new icon: a calm sun rising on the horizon. (On iPhone and Android it changes the next time you install the app.)',
      'Adding an AI key is clearer: tap "Add my Gemini key" (or another) and its card opens with where to get a key and a box to paste it in. One button saves it and tests it straight away. Already have a key? The box to paste it is at the top.',
    ],
  },
  {
    version: '1.17.1',
    notes: [
      'Better numbers from your days: sleep worked out from your devices is more careful, emails from the same person count once, automatic emails and text codes no longer count as people, and football counts as exercise.',
      'Data brought in twice (from Apple Health live and from its export) is counted once.',
      'More private: patterns only go to an AI that may read them, and lock-screen reminders never use them.',
      'The Reflect button works again after the first time, and Manage subscription always opens.',
    ],
  },
  {
    version: '1.17.0',
    notes: [
      'Study: add a study link and Arise turns your course into short rounds of questions. About five minutes each, with the answer explained and where it comes from.',
      'Cards you miss come back sooner and the ones you know space out, so your time goes where it counts. Your tests coming up are on Today, with a countdown.',
      'Each round earns XP, counts for your streak and raises INT. Your progress syncs to your other devices, and your coach can see how your studying is going.',
    ],
  },
  {
    version: '1.16.0',
    notes: [
      "Nothing to fill in. Arise works out your days by itself from what your phone, watch and computer already record: how you slept, how much you moved, your focused time, the people you talked to, your screens and late nights.",
      'How your life is going is now worked out for you too, compared with your own usual week, and What Arise noticed finds what goes with your best days. All of it on your device: nobody else can see it.',
      'Your coach works from what Arise saw and never asks you to rate things or keep a diary. A one-tap "How do you feel?" is there if you want it.',
      'Arise Private: the private AI all day for $5 a month, with 5 private questions a day free for everyone.',
      "Your computer's AI: run a free, fully private AI on your own Mac with Ollama (optional, Settings, AI coach).",
    ],
  },
  {
    version: '1.15.0',
    notes: [
      'Arise is now about you. The You tab is Me: what Arise knows about you, how your life and your week are going, what it noticed and your weeks looking back.',
      'Training has its own page, under your fitness goal (Goals, Training). Your workout history, charts, body and the week of sessions are all there.',
      "Today shows your workout as one small card with Start, and the exercises one tap away. Football is a switch on that card.",
    ],
  },
  {
    version: '1.14.1',
    notes: [
      'The Mac helper can now read your other browsers (Chrome, Edge, Brave, Arc, Vivaldi, Opera and Firefox), Apple Mail (who emailed you, from every account in it) and the Calendar app. No sign-ins: it reads them on your Mac, and each one stays off until you turn it on.',
      'Have the Mac helper? Run its install command again (Days, Connect apps and devices, Mac) to get the new switches.',
    ],
  },
  {
    version: '1.14.0',
    notes: [
      'Connect: one screen for everything Arise can read, from your phone, this computer, your accounts and your past history. Find it at the top of Days.',
      'A calendar in Days: see each month at a glance, with how full each day was and how you felt. Tap a day to see what happened.',
    ],
  },
  {
    version: '1.13.0',
    notes: [
      'Arise now starts with your whole life, not one goal: a one-minute check-in on sleep, health, mood, people, work, money, fun and purpose. A goal is optional.',
      'Today opens with your day, written for you, and a quick check-in: how you slept, your energy and your mood.',
      'Your coach looks at everything before it speaks, including the last few days from your life log when that AI may read it. If a goal is costing you sleep, health or people you care about, it says so once, kindly, and then backs your call.',
      'Progress is now You: how your life is going, what Arise noticed about your good days (worked out on your device, with no AI), and your weeks and months looking back.',
      'Workouts, the plan, streaks and XP work just as before.',
    ],
  },
  {
    version: '1.12.1',
    notes: [
      'Arise keeps updating itself everywhere. Now, when a rare update needs a new iPhone app or a newer Mac helper, it tells you straight away and shows how.',
    ],
  },
  {
    version: '1.12.0',
    notes: [
      'The Mac helper is now one signed program. macOS gives it Full Disk Access, and takes it away if anything changes the program.',
      'Already have the Mac helper? Run its install command again (Settings, Your life, Mac), then follow its steps to move Full Disk Access from "node" to "arise-helper".',
    ],
  },
  {
    version: '1.11.0',
    notes: [
      'Your journal: each day written hour by hour from your log, and as a real diary by the AI when it may read the whole day. Edit it, copy it, share it. It opens first in Days.',
      'A morning "Yesterday" and an evening "How was today?" notification. Your lock screen only shows plain words unless you turn on Show details.',
      'Only strong AI models now write what Arise remembers about you, so a small model\'s mistake can\'t spread. Smaller ones can still chat. Settings, Your AI keys can trust a model you know is good.',
    ],
  },
  {
    version: '1.10.0',
    notes: [
      'Your life log now syncs between your devices, end-to-end encrypted: Your days, your notes, what you brought in and what Arise learned. Sign in on each device to have it everywhere.',
      'Deleting something, a whole source, or everything, deletes it on all your devices.',
    ],
  },
  {
    version: '1.9.0',
    notes: [
      'About me: Arise turns what it knows into a short text about you to paste into ChatGPT, Claude or any app\'s "about you". You see and edit every word first. What Arise knows, About me.',
      'Connect your other apps: give an app its own private link to what you choose (your goals, everyday facts, your last days). It updates itself, and you can turn it off any time. What Arise knows, Connected apps.',
      'For AI assistants like Claude Desktop, a small connector reads such a link so they know you too.',
    ],
  },
  {
    version: '1.8.0',
    notes: [
      'There is now an Android app (optional; the web app still works everywhere). It updates itself like the iPhone app.',
      'On Android, Arise can note the notifications from your apps, your calls including missed ones, how long you use each app, Health Connect and your calendar. Each one is off until you turn it on, in Settings, Your life, Android.',
    ],
  },
  {
    version: '1.7.0',
    notes: [
      'A browser extension for Chrome, Edge, Brave and Firefox notes the sites you visit, your searches and your time on each site, including the last 90 days. It locks everything for Arise and can never read it back. Settings, Your life, Browser.',
      'A Mac helper: missed and answered calls (from your iPhone too), the notifications your Mac shows, Messages, Safari and the apps you use. Install it with one Terminal command from Settings, Your life, Mac. Everything is off until you turn it on.',
    ],
  },
  {
    version: '1.6.0',
    notes: [
      'The iPhone app can now fill in your days by itself: Apple Health (with your watch), walks, runs and drives, your calendar, and the places you go. Each one is off until you turn it on, in Settings, Your life.',
      'Log to Arise for Shortcuts: automations like "when I open an app", "when I arrive home" or "when a message comes in" can note things down without opening Arise. Settings, Your life, iPhone automations.',
      'This needs the new iPhone app once: install the latest Arise.ipa the same way as before. Your data stays.',
    ],
  },
  {
    version: '1.5.0',
    notes: [
      'A new look: calm, light or dark, in plain words. Prefer the Solo Leveling look? Settings, Look, System.',
      'Days: a timeline of each day, and a search that answers "What did I do…?" (last Tuesday, in March, this morning).',
      'Arise now learns you: it sums up each day, notices routines and what matters to you, and your coach uses it. See, edit or delete all of it in What Arise knows.',
      'A Yesterday card on Today, and Add to your day for a quick note and your mood.',
      'Bring in your history: Google searches, YouTube, Chrome and Maps, Spotify, Netflix, Apple Health, WhatsApp chats and bank statements. Settings, Your history. Files are read on your device and never uploaded.',
      'In the iPhone app, link Steam and PlayStation to see what you played and for how long. Settings, Your life, Accounts.',
      'Only the private AI and the AI on your device read your life log, unless you say otherwise.',
    ],
  },
  {
    version: '1.4.0',
    notes: [
      'Link as many free AI keys as you like: Gemini, Groq, OpenRouter, Cerebras, Mistral, GitHub Models and more. Settings, AI coach, Your AI keys.',
      'When one hits its limit, the next one answers straight away. The first one rests until its limit starts again, and Settings shows when.',
      "Each service shows how to get a free key, its limits, and what it does with what you send. They're less private: those companies can read it.",
    ],
  },
  {
    version: '1.3.0',
    notes: [
      "Share a goal's progress with a friend. On the Goals tab, tap Share progress on a goal to make a link. It needs an account.",
      'Your friend sees a page with that goal: your streak, its quests and their streaks, its last 28 days, your measures and the milestones you reached. It keeps itself up to date. Never your journal, your chats, your other goals or your weigh-ins.',
      "It's end-to-end encrypted. The key is in the link, so only people with the link can see the page. Not even the people who run Arise can.",
      'Your first name only shows if you turn on Show my name. You can stop sharing, or make a new link, any time.',
    ],
  },
  {
    version: '1.2.0',
    notes: [
      'App lock: Arise can ask for a passcode, or Face ID or Touch ID, when it opens and after time away. It\'s off unless you turn it on, in Settings, App lock. It\'s for this device only.',
      'In the iPhone app the lock uses a passcode. Face ID or Touch ID works in the web app.',
      "In the iPhone app, while the lock is on, the copy of your data is kept inside the app. The Files app doesn't show it.",
      'Forgot the passcode? You can erase Arise on this device and sign in again to get your data back.',
    ],
  },
  {
    version: '1.1.0',
    notes: [
      'Free AI: a free coach for anyone who minds privacy less. Settings, AI coach. Tap Learn more to see what each option can see.',
      'Pick the AI model for the private AI and the free AI.',
      'New accounts can choose Email reset instead of a recovery code, so a forgotten password can be reset by email. It\'s less private; Learn more explains.',
    ],
  },
  {
    version: '1.0.0',
    notes: [
      'Arise 1.0: the first full release, so the version numbers start again here.',
      'Notifications in the web app: a reminder every morning at the time you pick, and an evening check on days that aren\'t done yet. Turn them on in Settings, Reminders, on each device. On iPhone and iPad, open Arise from your Home Screen first.',
      'The private AI coach now works on every phone and computer once you\'re signed in, with nothing to set up.',
      'Deleting your account and making it again with the same email keeps everything on your devices, and asks before adding a device\'s data to it.',
    ],
  },
];
