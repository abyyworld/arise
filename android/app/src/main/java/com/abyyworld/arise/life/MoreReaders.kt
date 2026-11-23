package com.abyyworld.arise.life

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.ExifInterface
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// More from the phone for the life log (src/life/android-more.ts): text messages, photos taken,
// Bluetooth and Wi-Fi connections, and phone unlocks. Each is off until the Player turns it on, and
// each read hands rows straight back to the app: nothing is sent anywhere from here.

// Text messages from a time on, oldest first: who, when, which way, and the words only when the
// app asks for them (the same switch as notifications' text).
object SmsReader {
    fun read(ctx: Context, since: Long, max: Int, withText: Boolean, withContacts: Boolean): JSONArray {
        val out = JSONArray()
        val names = HashMap<String, String>()
        val projection = arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.BODY)
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            projection,
            "${Telephony.Sms.DATE} >= ?",
            arrayOf(since.toString()),
            "${Telephony.Sms.DATE} ASC",
        )?.use { c ->
            while (out.length() < max && c.moveToNext()) {
                val address = c.getString(1) ?: ""
                val row = JSONObject()
                    .put("id", c.getLong(0))
                    .put("address", address)
                    .put("date", c.getLong(2))
                    .put("type", c.getInt(3))
                if (withContacts && address.isNotBlank()) {
                    val name = names.getOrPut(address) { contactName(ctx, address) ?: "" }
                    if (name.isNotEmpty()) row.put("name", name)
                }
                if (withText) row.put("body", (c.getString(4) ?: "").take(1000))
                out.put(row)
            }
        }
        return out
    }

    private fun contactName(ctx: Context, number: String): String? = try {
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}

// Photos taken with the camera in [from, to): when, and where if the photo says so. Never the
// photo itself: only the few bytes at its start where the camera wrote the place.
object PhotoReader {
    fun read(ctx: Context, from: Long, to: Long, max: Int): JSONArray {
        val out = JSONArray()
        if (to <= from) return out
        val withPlace = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
        val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN, MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
        ctx.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            "${MediaStore.Images.Media.DATE_TAKEN} >= ? AND ${MediaStore.Images.Media.DATE_TAKEN} < ?",
            arrayOf(from.toString(), to.toString()),
            "${MediaStore.Images.Media.DATE_TAKEN} ASC",
        )?.use { c ->
            while (out.length() < max && c.moveToNext()) {
                val bucket = (c.getString(2) ?: "").lowercase()
                // The camera's own folder: not screenshots, downloads or what a chat app saved.
                if (bucket != "camera" && !bucket.startsWith("dcim")) continue
                val id = c.getLong(0)
                val row = JSONObject().put("id", id).put("at", c.getLong(1))
                if (withPlace) place(ctx, ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id))?.let {
                    row.put("lat", it[0]).put("lon", it[1])
                }
                out.put(row)
            }
        }
        return out
    }

    private fun place(ctx: Context, uri: Uri): DoubleArray? = try {
        val original = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.setRequireOriginal(uri) else uri
        ctx.contentResolver.openInputStream(original)?.use { stream ->
            val exif = ExifInterface(stream)
            val ll = FloatArray(2)
            if (exif.getLatLong(ll) && !(ll[0] == 0f && ll[1] == 0f)) doubleArrayOf(ll[0].toDouble(), ll[1].toDouble()) else null
        }
    } catch (_: Exception) {
        null
    }
}

// Phone unlocks per day, and when it was first and last used, from Android's record of app use
// (Usage access; it keeps about a week). Whole days in [fromDay, toDay) on the phone's clock.
object UnlockReader {
    private const val RESUMED = 1 // ACTIVITY_RESUMED
    private const val PAUSED = 2 // ACTIVITY_PAUSED
    private const val SCREEN_ON = 15 // SCREEN_INTERACTIVE
    private const val SCREEN_OFF = 16 // SCREEN_NON_INTERACTIVE
    private const val UNLOCKED = 18 // KEYGUARD_HIDDEN (Android 9 and later)

    fun read(ctx: Context, fromDay: LocalDate, toDay: LocalDate): JSONArray {
        val out = JSONArray()
        if (!toDay.isAfter(fromDay)) return out
        val zone = ZoneId.systemDefault()
        val from = fromDay.atStartOfDay(zone).toInstant().toEpochMilli()
        val to = toDay.atStartOfDay(zone).toInstant().toEpochMilli()
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val unlocks = HashMap<LocalDate, Int>()
        val first = HashMap<LocalDate, Long>()
        val last = HashMap<LocalDate, Long>()
        val events = usm.queryEvents(from, to)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            val day = Instant.ofEpochMilli(e.timeStamp).atZone(zone).toLocalDate()
            when (e.eventType) {
                UNLOCKED -> unlocks[day] = (unlocks[day] ?: 0) + 1
                SCREEN_ON, RESUMED -> if (e.packageName != "android") first.putIfAbsent(day, e.timeStamp)
                SCREEN_OFF, PAUSED -> last[day] = e.timeStamp
            }
            if (e.eventType == RESUMED || e.eventType == UNLOCKED) last[day] = maxOf(last[day] ?: 0L, e.timeStamp)
        }
        var day = fromDay
        while (day.isBefore(toDay)) {
            val f = first[day]
            if (f != null || unlocks.containsKey(day)) {
                val row = JSONObject().put("day", day.toString()).put("unlocks", unlocks[day] ?: 0)
                if (f != null) row.put("first", f)
                last[day]?.let { row.put("last", it) }
                out.put(row)
            }
            day = day.plusDays(1)
        }
        return out
    }
}

// Bluetooth and Wi-Fi connections as they happen, while the Player has Connections on. Android
// tells the receiver below about Bluetooth even while Arise is closed, and about joining a Wi-Fi
// network through a request it keeps for Arise. Each waits in LifeQueue ("connections").
object ConnectionWatch {
    const val WIFI = "com.abyyworld.arise.life.WIFI"
    private const val ON = "connectionsOn"
    private const val LAST_WIFI = "lastWifi"
    private const val LAST_BT = "lastBluetooth"

    fun isOn(ctx: Context): Boolean = LifePrefs.prefs(ctx).getBoolean(ON, false)

    fun set(ctx: Context, on: Boolean) {
        LifePrefs.prefs(ctx).edit().putBoolean(ON, on).apply()
        apply(ctx)
        if (!on) LifeQueue.clear(ctx, LifeQueue.CONNECTIONS)
    }

    private fun wifiIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx, ConnectionReceiver::class.java).setAction(WIFI)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, 4703, intent, flags)
    }

    fun apply(ctx: Context) {
        val on = isOn(ctx)
        ctx.packageManager.setComponentEnabledSetting(
            ComponentName(ctx, ConnectionReceiver::class.java),
            if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.unregisterNetworkCallback(wifiIntent(ctx))
        } catch (_: Exception) {
        }
        if (on) {
            try {
                cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), wifiIntent(ctx))
            } catch (_: Exception) {
            }
        }
    }

    private fun add(ctx: Context, item: JSONObject) {
        if (!isOn(ctx) || LifePrefs.paused(ctx)) return
        LifeQueue.add(ctx, item, LifeQueue.CONNECTIONS)
    }

    // The network's name needs Location allowed (all the time, while Arise is closed): without
    // it, Android says "<unknown ssid>", and it's noted as a Wi-Fi network with no name.
    @SuppressLint("MissingPermission")
    fun wifi(ctx: Context) {
        val name = try {
            @Suppress("DEPRECATION")
            val ssid = ctx.applicationContext.getSystemService(WifiManager::class.java)?.connectionInfo?.ssid ?: ""
            ssid.trim('"').takeIf { it.isNotBlank() && it != "<unknown ssid>" } ?: ""
        } catch (_: Exception) {
            ""
        }
        val prefs = LifePrefs.prefs(ctx)
        val now = System.currentTimeMillis()
        val last = prefs.getString(LAST_WIFI, "") ?: ""
        // Android may say so a few times for the same network.
        if (last == "$name|${now / 600_000L}") return
        prefs.edit().putString(LAST_WIFI, "$name|${now / 600_000L}").apply()
        add(ctx, JSONObject().put("at", now).put("type", "wifi").put("state", "connected").put("name", name))
    }

    @SuppressLint("MissingPermission")
    fun bluetooth(ctx: Context, intent: Intent, connected: Boolean) {
        val device: BluetoothDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
        }
        if (device == null) return
        var name = ""
        var kind = ""
        try {
            name = device.name ?: ""
            val cls = device.bluetoothClass
            kind = when {
                cls == null -> ""
                cls.deviceClass == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO || cls.deviceClass == BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE -> "car"
                cls.majorDeviceClass == BluetoothClass.Device.Major.AUDIO_VIDEO -> "audio"
                cls.majorDeviceClass == BluetoothClass.Device.Major.WEARABLE -> "watch"
                else -> ""
            }
        } catch (_: SecurityException) {
            // Without "Nearby devices", Android doesn't say which device.
        }
        val state = if (connected) "connected" else "disconnected"
        val now = System.currentTimeMillis()
        val address = try {
            device.address ?: ""
        } catch (_: Exception) {
            ""
        }
        val key = "${address.ifEmpty { name }}|$state"
        val prefs = LifePrefs.prefs(ctx)
        val last = prefs.getString(LAST_BT, "") ?: ""
        // The same device coming and going within 2 minutes, noted once.
        if (last.substringBeforeLast('|') == key && now - (last.substringAfterLast('|').toLongOrNull() ?: 0L) < 120_000L) return
        prefs.edit().putString(LAST_BT, "$key|$now").apply()
        add(ctx, JSONObject().put("at", now).put("type", "bluetooth").put("state", state).put("name", name).put("kind", kind))
    }
}

class ConnectionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return
        val ctx = context.applicationContext
        try {
            when (intent.action) {
                BluetoothDevice.ACTION_ACL_CONNECTED -> ConnectionWatch.bluetooth(ctx, intent, true)
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> ConnectionWatch.bluetooth(ctx, intent, false)
                ConnectionWatch.WIFI -> ConnectionWatch.wifi(ctx)
            }
        } catch (_: Exception) {
        }
    }
}
