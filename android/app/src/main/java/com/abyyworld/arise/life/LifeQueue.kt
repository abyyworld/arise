package com.abyyworld.arise.life

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// What the Player turned on in Settings, Your life, Android, for the parts that run while the app
// is closed (the notification recorder, location, connections). The app sets it (LifePlugin).
object LifePrefs {
    private const val NAME = "arise-life"
    private const val NOTIFICATIONS = "notifications"
    private const val TEXT = "notificationText"
    private const val LOCATION_MODE = "locationMode"
    private const val LOCATION_EVERY = "locationEvery"
    private const val LOCATION_EXACT = "locationExact"
    private const val LOCATION_NEVER = "locationNever"
    private const val PAUSED_UNTIL = "pausedUntil"
    private const val SKIP_APPS = "skipApps"
    private const val SKIP_WORDS = "skipWords"
    const val LAST_POINT = "lastPoint"
    const val SEQ = "seq"

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun notificationsOn(ctx: Context): Boolean = prefs(ctx).getBoolean(NOTIFICATIONS, false)

    // With the text of each notification, or only who and when (the default).
    fun notificationText(ctx: Context): Boolean = prefs(ctx).getBoolean(TEXT, false)

    fun setNotifications(ctx: Context, on: Boolean, text: Boolean) {
        prefs(ctx).edit().putBoolean(NOTIFICATIONS, on).putBoolean(TEXT, on && text).apply()
    }

    // ---------- location (LocationReader)

    // "off", "places" (a point every 15 minutes, made into stays by the app) or "interval".
    fun locationMode(ctx: Context): String = prefs(ctx).getString(LOCATION_MODE, "off") ?: "off"

    // Minutes between points, for "interval".
    fun locationEvery(ctx: Context): Int = prefs(ctx).getInt(LOCATION_EVERY, 30).coerceIn(1, 720)

    // Exact, or rounded to about 1 km before it's kept.
    fun locationExact(ctx: Context): Boolean = prefs(ctx).getBoolean(LOCATION_EXACT, true)

    // Places never to note: each [latitude, longitude, radius in meters].
    fun never(ctx: Context): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        try {
            val list = JSONArray(prefs(ctx).getString(LOCATION_NEVER, "[]") ?: "[]")
            for (i in 0 until list.length()) {
                val o = list.optJSONObject(i) ?: continue
                out.add(doubleArrayOf(o.optDouble("lat"), o.optDouble("lon"), o.optDouble("radius", 250.0)))
            }
        } catch (_: Exception) {
        }
        return out.filter { a -> a.all { !it.isNaN() } }
    }

    fun setLocation(ctx: Context, mode: String, every: Int, exact: Boolean, never: JSONArray) {
        prefs(ctx).edit()
            .putString(LOCATION_MODE, mode)
            .putInt(LOCATION_EVERY, every.coerceIn(1, 720))
            .putBoolean(LOCATION_EXACT, exact)
            .putString(LOCATION_NEVER, never.toString())
            .apply()
    }

    // ---------- Pause everything (src/life/pause.ts): nothing is noted until this time.

    fun pausedUntil(ctx: Context): Long = prefs(ctx).getLong(PAUSED_UNTIL, 0L)

    fun paused(ctx: Context, now: Long = System.currentTimeMillis()): Boolean = pausedUntil(ctx) > now

    fun setPausedUntil(ctx: Context, until: Long) {
        prefs(ctx).edit().putLong(PAUSED_UNTIL, maxOf(0L, until)).apply()
    }

    // ---------- apps never read (src/life/app-skip.ts): their package names (with everything
    // under them) and words in a package name or an app's name.

    fun setSkip(ctx: Context, apps: Set<String>, words: Set<String>) {
        prefs(ctx).edit().putStringSet(SKIP_APPS, apps).putStringSet(SKIP_WORDS, words).apply()
    }

    fun skips(ctx: Context, pkg: String, label: String = ""): Boolean {
        val p = prefs(ctx)
        val id = pkg.lowercase()
        val apps = p.getStringSet(SKIP_APPS, emptySet()) ?: emptySet()
        if (apps.any { val a = it.lowercase(); id == a || id.startsWith("$a.") }) return true
        val words = p.getStringSet(SKIP_WORDS, emptySet()) ?: emptySet()
        if (words.isEmpty()) return false
        val parts = id.split('.').filter { it.length > 2 }
        val name = label.lowercase().replace(Regex("[^a-z0-9]+"), "")
        return words.any { w -> parts.any { it.contains(w) } || (name.isNotEmpty() && name.contains(w)) }
    }
}

// What's noted while the app is closed (notifications, location points, connections), kept in a
// file per queue in the app's own storage (no other app can read it) until the app takes them into
// the life log. One JSON object per line, each with a number (`seq`) that only goes up. The app
// reads them, adds them to the life log, then says which it has (ack), so none is lost if the app
// is closed halfway.
object LifeQueue {
    const val NOTIFICATIONS = "notifications"
    const val PLACES = "places"
    const val CONNECTIONS = "connections"
    val NAMES = setOf(NOTIFICATIONS, PLACES, CONNECTIONS)

    // At most this many wait for the app. If it isn't opened for a long time, the oldest go first.
    private const val MAX = 5000

    private fun file(ctx: Context, queue: String) = File(ctx.filesDir, "life/$queue.jsonl")

    // (The notifications' number keeps the name it always had.)
    private fun seqKey(queue: String) = if (queue == NOTIFICATIONS) LifePrefs.SEQ else "${LifePrefs.SEQ}.$queue"

    private fun lines(ctx: Context, queue: String): List<String> {
        val f = file(ctx, queue)
        if (!f.exists()) return emptyList()
        return f.readLines().filter { it.isNotBlank() }
    }

    private fun write(ctx: Context, keep: List<String>, queue: String) {
        val f = file(ctx, queue)
        if (keep.isEmpty()) {
            f.delete()
            return
        }
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeText(keep.joinToString("\n", postfix = "\n"))
        if (!tmp.renameTo(f)) {
            f.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun seqOf(line: String): Long = try {
        JSONObject(line).optLong("seq", 0L)
    } catch (_: Exception) {
        0L
    }

    @Synchronized
    fun add(ctx: Context, item: JSONObject, queue: String = NOTIFICATIONS) {
        val prefs = LifePrefs.prefs(ctx)
        val seq = prefs.getLong(seqKey(queue), 0L) + 1
        prefs.edit().putLong(seqKey(queue), seq).apply()
        item.put("seq", seq)
        val f = file(ctx, queue)
        f.parentFile?.mkdirs()
        f.appendText(item.toString() + "\n")
        if (seq % 200L == 0L) {
            val all = lines(ctx, queue)
            if (all.size > MAX) write(ctx, all.takeLast(MAX), queue)
        }
    }

    // The oldest `max` waiting, and the number of the last one.
    @Synchronized
    fun read(ctx: Context, max: Int, queue: String = NOTIFICATIONS): Pair<List<JSONObject>, Long> {
        val out = ArrayList<JSONObject>()
        var last = 0L
        for (line in lines(ctx, queue)) {
            if (out.size >= max) break
            try {
                val o = JSONObject(line)
                out.add(o)
                last = maxOf(last, o.optLong("seq", 0L))
            } catch (_: Exception) {
                // A line cut short (the phone switched off while writing): skipped.
            }
        }
        return Pair(out, last)
    }

    // The app has everything up to `upTo`: those go.
    @Synchronized
    fun ack(ctx: Context, upTo: Long, queue: String = NOTIFICATIONS) {
        write(ctx, lines(ctx, queue).filter { seqOf(it) > upTo }, queue)
    }

    @Synchronized
    fun count(ctx: Context, queue: String = NOTIFICATIONS): Int = lines(ctx, queue).size

    @Synchronized
    fun clear(ctx: Context, queue: String = NOTIFICATIONS) {
        file(ctx, queue).delete()
    }
}
