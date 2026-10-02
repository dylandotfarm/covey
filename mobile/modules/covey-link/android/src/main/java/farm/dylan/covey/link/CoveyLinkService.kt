package farm.dylan.covey.link

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * A service that does nothing, on purpose (#184).
 *
 * It holds no Bluetooth connection and reads no characteristic. All it does is
 * run in the foreground, and that is the whole point: Android stops a
 * *background* app from receiving Bluetooth scan results while the screen is
 * off, and it kills the process when the app is swiped away. Both are what make
 * the device unreachable with a locked phone. A foreground service lifts the
 * first and prevents the second, and the Bluetooth code carries on in
 * JavaScript exactly as it did before.
 *
 * So there is no second copy of the link here. `ble.ts` still owns the scan,
 * the connection and the fragments; this only keeps the process it runs in
 * alive. Anything else here would be a second implementation of something that
 * already works.
 *
 * The notification is not optional and cannot be hidden. Android requires it,
 * and that is right: a reader should be able to see what is holding their radio
 * open, and to stop it.
 */
class CoveyLinkService : Service() {

  companion object {
    const val CHANNEL_ID = "covey-device-link"
    const val NOTIFICATION_ID = 1978
    const val ACTION_STOP = "farm.dylan.covey.link.STOP"

    /** True while this service runs, so JavaScript need not keep its own flag. */
    @Volatile
    var running: Boolean = false
      private set
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // IMPORTANCE_LOW: it belongs in the shade, not in front of anybody. A
      // notification nobody asked for that also makes a sound is a feature
      // people turn off, and turning this one off turns the device off.
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Device link",
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.description = "Keeps covey connected to your device while the screen is off."
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stop()
      return START_NOT_STICKY
    }

    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val stopHere = PendingIntent.getService(
      this,
      1,
      Intent(this, CoveyLinkService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )

    val notification: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("covey device")
      .setContentText("Listening for your device.")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .apply {
        if (open != null) setContentIntent(open)
        // A way out that does not mean hunting through settings.
        addAction(
          Notification.Action.Builder(null, "Stop", stopHere).build(),
        )
      }
      .build()

    /*
     * From Android 14 the type must be given here as well as in the manifest,
     * and a mismatch throws rather than degrades. Below 14 the two-argument
     * call is the only one there is.
     */
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    running = true
    // START_STICKY: if Android reclaims the process under memory pressure, it
    // brings the service back. The JavaScript side re-scans when it does.
    return START_STICKY
  }

  private fun stop() {
    running = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
