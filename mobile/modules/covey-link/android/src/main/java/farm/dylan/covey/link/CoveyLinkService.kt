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
 * It holds no Bluetooth connection, reads no characteristic and opens no
 * socket. All it does is run in the foreground, and that is the whole point:
 * Android stops a *background* app from receiving Bluetooth scan results while
 * the screen is off, it suspends a cached app's network in Doze, and it kills
 * the process when the app is swiped away. Each of those makes covey unreachable
 * with a locked phone. A foreground service lifts them, and the JavaScript
 * carries on exactly as it did before.
 *
 * So there is no second copy of the link here, and no second copy of the socket.
 * `ble.ts` owns the scan and the connection and `store.ts` owns the machines;
 * this only keeps the process they run in alive. Anything else here would be a
 * second implementation of something that already works.
 *
 * **It is held for reasons, and it stops when the last one is released**.
 * Two things want the process alive and they are switched on separately — the
 * device link, and the watch that posts a notification when a thread needs the
 * reader. One service is right for both: Android gives each one the same
 * notification the reader cannot hide, and two rows in the shade for one process
 * would be a lie about what is running. The set of reasons lives here rather
 * than in JavaScript because this is also where the words are: the notification
 * has to say what covey is holding the phone awake *for*.
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
    const val EXTRA_REASON = "reason"
    const val EXTRA_RELEASE = "release"

    /** The reason the device link holds the service for. */
    const val REASON_DEVICE = "device"
    /** The reason the thread watch holds it for. */
    const val REASON_WATCH = "watch"

    /** True while this service runs, so JavaScript need not keep its own flag. */
    @Volatile
    var running: Boolean = false
      private set

    /**
     * What the notification says it is holding the phone awake for.
     *
     * One sentence per reason, joined, because a reader looking at the shade is
     * asking "why is this running" and the answer is a list of length one or
     * two. An unknown reason says nothing of its own rather than printing a
     * word covey chose for a wire: a bundle delivered over the air can be newer
     * than the app it lands in, so this build may be held for a reason it has
     * never heard of, and "covey is working" is true of all of them.
     */
    fun text(reasons: Set<String>): String {
      val says = mutableListOf<String>()
      if (reasons.contains(REASON_DEVICE)) says.add("listening for your device")
      if (reasons.contains(REASON_WATCH)) says.add("watching your conversations")
      if (says.isEmpty()) return "Working."
      return says.joinToString(", and ").replaceFirstChar { it.uppercase() } + "."
    }
  }

  /**
   * Why this service is up.
   *
   * A set and not a count: a start is sent whenever a switch is turned on and
   * whenever the app comes back to a service Android restarted, so the same
   * reason arrives more than once and must not be owed twice.
   */
  private val reasons = mutableSetOf<String>()

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
        "Running in the background",
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.description = "Keeps covey connected while the screen is off."
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // The reader pressed Stop. That is every reason at once: they are not
      // being asked which half of this to keep.
      stop()
      return START_NOT_STICKY
    }

    val reason = intent?.getStringExtra(EXTRA_REASON)
    if (reason != null) {
      if (intent.getBooleanExtra(EXTRA_RELEASE, false)) reasons.remove(reason)
      else reasons.add(reason)
    }
    /*
     * The last reason went, so the service goes. Nothing else may stop it: a
     * release from the device switch must not take the watch down with it.
     *
     * A service Android restarted (START_STICKY) arrives here with a null
     * intent and no reasons, which reads the same way — the process is back,
     * nothing has asked for it yet, and whichever switch is on asks again.
     */
    if (reasons.isEmpty()) {
      stop()
      return START_NOT_STICKY
    }

    startForeground(notification())
    running = true
    // START_STICKY: if Android reclaims the process under memory pressure, it
    // brings the service back. The JavaScript side asks again when it does.
    return START_STICKY
  }

  private fun notification(): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val stopHere = PendingIntent.getService(
      this,
      1,
      Intent(this, CoveyLinkService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )

    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("covey")
      .setContentText(text(reasons))
      // A neutral glyph, because this row is not about Bluetooth any more. It
      // was `stat_sys_data_bluetooth` when the device was the only thing that
      // held the service, and a reader who turns notifications on with no
      // device would read that as covey having switched their radio on.
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .apply {
        if (open != null) setContentIntent(open)
        // A way out that does not mean hunting through settings.
        addAction(
          Notification.Action.Builder(null, "Stop", stopHere).build(),
        )
      }
      .build()
  }

  /**
   * Put the service in the foreground, or keep it there with new words.
   *
   * `startForeground` is also the update: called again while the service runs,
   * it replaces the notification, which is how the text follows the reasons.
   */
  private fun startForeground(notification: Notification) {
    /*
     * From Android 14 the type must be given here as well as in the manifest,
     * and a mismatch throws rather than degrades. Below 14 the two-argument
     * call is the only one there is.
     *
     * `connectedDevice` covers both reasons. Android's own definition is
     * interaction with an external device over Bluetooth, NFC, IR, USB *or a
     * network connection*, and a daemon on the reader's tailnet is the second
     * of those. The types Android 15 caps at six hours a day — `dataSync` and
     * `mediaProcessing` — would make this a feature that stops working in the
     * evening, which is worse than a word.
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
  }

  private fun stop() {
    running = false
    reasons.clear()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
