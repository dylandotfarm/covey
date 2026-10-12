package farm.dylan.covey.keys

import android.view.KeyEvent

/**
 * The volume keys, while covey wants them.
 *
 * Two parts of the app meet here and neither can hold the other. The key
 * events arrive at a `ReactActivityHandler` that Android builds with the
 * activity, long before JavaScript runs; the listener belongs to a module the
 * React instance owns and replaces on every reload. So the handler asks this
 * object, which is the one thing that outlives both.
 *
 * Every field is read on the main thread, where key events arrive, and written
 * from the module's own calls. `@Volatile` is for the reload: a module
 * destroyed on one thread must not leave a stale listener visible on another.
 */
object CoveyKeys {
  /**
   * Whether covey takes the keys at all.
   *
   * False is the default and the resting state, because the volume keys belong
   * to the reader: a conversation covey is not listening to must leave them
   * alone. The composer turns this on while it is on screen and off as it
   * goes, so the keys change the volume everywhere else in the app.
   */
  @Volatile
  var watching: Boolean = false

  /** Where a press goes. Null between a reload and the module's `OnCreate`. */
  @Volatile
  var listener: ((String, Boolean) -> Unit)? = null

  /** Give the keys back. Called when the module goes, so a reload cannot keep them. */
  fun release() {
    watching = false
    listener = null
  }

  /**
   * Read one key event, and say whether covey took it.
   *
   * True means the volume must not move: the activity returns true, so
   * `PhoneWindow` never sees the key and neither the volume nor its slider
   * changes. False means covey is not listening and the key is the reader's.
   *
   * It fails open — no listener is no consumption — because the cost of the
   * two mistakes is not the same. A press covey misses is a sentence the
   * reader has to say again. A press covey eats with nothing behind it is a
   * phone whose volume keys have stopped working.
   */
  fun take(keyCode: Int, event: KeyEvent?, pressed: Boolean): Boolean {
    val name =
      when (keyCode) {
        KeyEvent.KEYCODE_VOLUME_DOWN -> "volumeDown"
        KeyEvent.KEYCODE_VOLUME_UP -> "volumeUp"
        else -> return false
      }
    if (!watching) return false
    val heard = listener ?: return false
    /*
     * A held key repeats, about twenty times a second. The hold began at the
     * first of them, so the rest are taken — the volume must still not move —
     * and said nothing about. Report them and every repeat would start the
     * recording again.
     */
    if (pressed && (event?.repeatCount ?: 0) > 0) return true
    heard(name, pressed)
    return true
  }

  /**
   * A long press, taken and never reported.
   *
   * Android offers the long press of a volume key to the activity separately,
   * and a hold-to-talk gesture is a long press by definition. Leave it and
   * something else answers for a key covey is already holding.
   */
  fun takeLongPress(keyCode: Int): Boolean =
    watching &&
      listener != null &&
      (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP)
}
