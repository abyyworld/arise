package com.abyyworld.arise.life

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.abyyworld.arise.R
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

// Location on a timer (src/life/location-sense.ts). Only the phone's own LocationManager, no Google
// services. Every 15 minutes or more, a background job wakes Arise for one point; for less than
// that, a small service with a notification keeps running. Each point goes through the places
// never to note and the rounding before it's kept, then waits in LifeQueue ("places") until the
// app takes it into the life log. Nothing is sent anywhere from here.
object LocationReader {
    private const val JOB_ID = 4701
    private const val MIN = 60_000L
    // Under this many minutes, a job can't wake Arise often enough: the service does it.
    const val JOB_MINUTES = 15

    fun hasLocation(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun hasFine(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    // Minutes between points the job asks for, and whether the service runs ('' mode: off).
    private fun jobMinutes(ctx: Context): Int =
        if (LifePrefs.locationMode(ctx) == "places") JOB_MINUTES else max(JOB_MINUTES, LifePrefs.locationEvery(ctx))

    fun wantsService(ctx: Context): Boolean =
        LifePrefs.locationMode(ctx) == "interval" && LifePrefs.locationEvery(ctx) < JOB_MINUTES && hasLocation(ctx)

    // Starts or stops the job and the service to match the setting. Called when the setting
    // changes, when the app opens, and after the phone starts.
    fun apply(ctx: Context) {
        val scheduler = ctx.getSystemService(JobScheduler::class.java) ?: return
        if (LifePrefs.locationMode(ctx) == "off" || !hasLocation(ctx)) {
            scheduler.cancel(JOB_ID)
            stopService(ctx)
            return
        }
        val period = jobMinutes(ctx) * MIN
        // The same job is already waiting: left alone, so its clock doesn't start again.
        val pending = scheduler.getPendingJob(JOB_ID)
        if (pending == null || pending.intervalMillis != period) {
            val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, LocationJob::class.java))
                .setPeriodic(period)
                .setPersisted(true)
                .build()
            try {
                scheduler.schedule(job)
            } catch (_: Exception) {
            }
        }
        if (wantsService(ctx)) startService(ctx) else stopService(ctx)
    }

    fun startService(ctx: Context) {
        try {
            ctx.startForegroundService(Intent(ctx, LocationService::class.java))
        } catch (_: Exception) {
            // Android doesn't let it start from the background now: the next time the app opens.
        }
    }

    fun stopService(ctx: Context) {
        try {
            ctx.stopService(Intent(ctx, LocationService::class.java))
        } catch (_: Exception) {
        }
    }

    // The provider to ask: the phone's own blend where it has one, else the network for a rough
    // place, else GPS.
    fun provider(ctx: Context, lm: LocationManager, exact: Boolean): String? {
        val on = { p: String -> try { lm.isProviderEnabled(p) } catch (_: Exception) { false } }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.hasProvider(LocationManager.FUSED_PROVIDER) && on(LocationManager.FUSED_PROVIDER)) {
            return LocationManager.FUSED_PROVIDER
        }
        if (!exact && on(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER
        if (hasFine(ctx) && on(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER
        if (on(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER
        return null
    }

    // The newest place the phone already knows, if it's from the last `within` ms.
    @SuppressLint("MissingPermission")
    private fun lastKnown(lm: LocationManager, within: Long): Location? {
        var best: Location? = null
        for (p in lm.allProviders) {
            val l = try {
                lm.getLastKnownLocation(p)
            } catch (_: Exception) {
                null
            } ?: continue
            if (best == null || l.time > best.time) best = l
        }
        return best?.takeIf { System.currentTimeMillis() - it.time <= within }
    }

    // Where the phone is now: one answer, or null after 30 seconds.
    @SuppressLint("MissingPermission")
    fun once(ctx: Context, exact: Boolean = LifePrefs.locationExact(ctx), done: (Location?) -> Unit) {
        val lm = ctx.getSystemService(LocationManager::class.java)
        if (lm == null || !hasLocation(ctx)) {
            done(null)
            return
        }
        val finished = AtomicBoolean(false)
        val finish = { l: Location? ->
            if (finished.compareAndSet(false, true)) done(l ?: lastKnown(lm, 10 * MIN))
        }
        val p = provider(ctx, lm, exact)
        if (p == null) {
            finish(null)
            return
        }
        val handler = Handler(Looper.getMainLooper())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val signal = CancellationSignal()
                handler.postDelayed({
                    signal.cancel()
                    finish(null)
                }, 30_000L)
                lm.getCurrentLocation(p, signal, ctx.mainExecutor) { l -> finish(l) }
            } else {
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        lm.removeUpdates(this)
                        finish(location)
                    }
                }
                handler.postDelayed({
                    lm.removeUpdates(listener)
                    finish(null)
                }, 30_000L)
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(p, listener, Looper.getMainLooper())
            }
        } catch (_: Exception) {
            finish(null)
        }
    }

    // Inside a place never to note.
    fun inNever(ctx: Context, lat: Double, lon: Double): Boolean {
        val out = FloatArray(1)
        for (n in LifePrefs.never(ctx)) {
            Location.distanceBetween(lat, lon, n[0], n[1], out)
            if (out[0] <= n[2]) return true
        }
        return false
    }

    private fun fix(v: Double): Double = (v * 100_000.0).roundToLong() / 100_000.0

    // To about 1 km, the same grid as the app (src/life/location.ts, roundSpot).
    fun round(lat: Double, lon: Double): Pair<Double, Double> {
        val step = 0.01
        val rlat = Math.round(lat / step) * step
        val wide = min(1.0, step / max(0.01, cos(Math.toRadians(rlat))))
        return Pair(fix(rlat), fix(max(-180.0, min(180.0, Math.round(lon / wide) * wide))))
    }

    // Keeps a point, if the setting, the pause and the places never to note allow it, at most one
    // per interval.
    @Synchronized
    fun record(ctx: Context, l: Location) {
        val mode = LifePrefs.locationMode(ctx)
        if (mode == "off" || LifePrefs.paused(ctx)) return
        if (inNever(ctx, l.latitude, l.longitude)) return
        val at = if (l.time > 0L) l.time else System.currentTimeMillis()
        val every = if (mode == "places") JOB_MINUTES else LifePrefs.locationEvery(ctx)
        val prefs = LifePrefs.prefs(ctx)
        val last = prefs.getLong(LifePrefs.LAST_POINT, 0L)
        if (last > 0L && at - last < (every * MIN * 8) / 10 && at >= last) return
        prefs.edit().putLong(LifePrefs.LAST_POINT, at).apply()
        val item = JSONObject().put("at", at)
        if (LifePrefs.locationExact(ctx)) {
            item.put("lat", l.latitude).put("lon", l.longitude)
            if (l.hasAccuracy()) item.put("acc", l.accuracy.toDouble())
        } else {
            val (lat, lon) = round(l.latitude, l.longitude)
            item.put("lat", lat).put("lon", lon).put("acc", 1000)
        }
        LifeQueue.add(ctx, item, LifeQueue.PLACES)
    }
}

// The background job: one point each time Android runs it (every 15 minutes or more).
class LocationJob : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        val ctx = applicationContext
        if (LifePrefs.locationMode(ctx) == "off") return false
        // The service should be running (under 15 minutes): try to bring it back.
        if (LocationReader.wantsService(ctx)) LocationReader.startService(ctx)
        if (LifePrefs.paused(ctx)) return false
        LocationReader.once(ctx) { l ->
            try {
                if (l != null) LocationReader.record(ctx, l)
            } catch (_: Exception) {
            }
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean = false
}

// For less than 15 minutes: keeps location updates coming while Arise is closed, with a
// notification that says so, as Android asks.
class LocationService : Service(), LocationListener {
    private var listening = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ctx = applicationContext
        try {
            showNotification()
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!LocationReader.wantsService(ctx)) {
            stopSelf()
            return START_NOT_STICKY
        }
        listen()
        return START_STICKY
    }

    private fun showNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm?.createNotificationChannel(NotificationChannel(CHANNEL, "Location", NotificationManager.IMPORTANCE_LOW))
        val every = LifePrefs.locationEvery(applicationContext)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_arise)
            .setContentTitle("Arise notes where you are")
            .setContentText(if (every == 1) "Every minute. Change it in Arise: Settings, Your life." else "Every $every minutes. Change it in Arise: Settings, Your life.")
            .setOngoing(true)
            .apply { if (open != null) setContentIntent(open) }
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    @SuppressLint("MissingPermission")
    private fun listen() {
        val ctx = applicationContext
        val lm = getSystemService(LocationManager::class.java) ?: return
        if (listening) lm.removeUpdates(this)
        val p = LocationReader.provider(ctx, lm, LifePrefs.locationExact(ctx)) ?: return
        val every = LifePrefs.locationEvery(ctx) * 60_000L
        try {
            lm.requestLocationUpdates(p, every, 0f, this, Looper.getMainLooper())
            listening = true
        } catch (_: Exception) {
            stopSelf()
        }
    }

    override fun onLocationChanged(location: Location) {
        try {
            LocationReader.record(applicationContext, location)
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        if (listening) {
            try {
                getSystemService(LocationManager::class.java)?.removeUpdates(this)
            } catch (_: Exception) {
            }
        }
        listening = false
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "arise-location"
        private const val NOTIFICATION_ID = 4702
    }
}

// After the phone starts, or Arise is updated: the job and the service as they were.
class LifeBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        try {
            LocationReader.apply(context.applicationContext)
        } catch (_: Exception) {
        }
    }
}
