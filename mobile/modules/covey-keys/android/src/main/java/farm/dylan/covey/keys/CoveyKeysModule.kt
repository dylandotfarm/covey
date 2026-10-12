package farm.dylan.covey.keys

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "CoveyKeys"

/**
 * Hold a volume key to talk.
 *
 * One call and one event. `setWatching` says whether the composer wants the
 * keys, and `keypress` reports each press and each release of one. The module
 * holds no state of its own: `CoveyKeys` is the state, because the handler
 * that reads the keys is built with the activity and cannot reach a module.
 *
 * Nothing here decides what a press means. The composer starts the recording
 * on the press and stops it on the release, which is the same pair of events
 * the microphone button already sends — so the two gestures end at one route
 * and a change to dictation never has to be made twice.
 */
class CoveyKeysModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("CoveyKeys")

      Events("keypress")

      OnCreate {
        CoveyKeys.listener = { key, pressed ->
          try {
            sendEvent("keypress", mapOf("key" to key, "pressed" to pressed))
          } catch (e: IllegalArgumentException) {
            // The module left the registry between the key press and this
            // line. Nothing can hear it, and nothing is wrong.
            Log.e(TAG, "Failed to report $key", e)
          }
        }
      }

      /*
       * The keys go back to the reader when the module does.
       *
       * A reload destroys the module and builds another, and a `watching` left
       * true across that gap is a phone whose volume keys answer a composer
       * that is no longer on screen. JavaScript turns it on again as the
       * composer mounts.
       */
      OnDestroy {
        CoveyKeys.release()
      }

      Function("setWatching") { on: Boolean ->
        CoveyKeys.watching = on
        true
      }

      Function("isWatching") {
        CoveyKeys.watching
      }
    }
}
