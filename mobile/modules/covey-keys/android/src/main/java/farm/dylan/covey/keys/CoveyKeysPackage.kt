package farm.dylan.covey.keys

import android.content.Context
import android.view.KeyEvent
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler

/**
 * Where a hardware key reaches covey.
 *
 * An Expo module cannot see a key press: it has no activity. A
 * `ReactActivityHandler` does, and `expo-modules-core` offers one for exactly
 * this — every handler is asked about `onKeyDown` and `onKeyUp`, and the first
 * that answers true consumes the event. That is the whole mechanism, and it is
 * why holding a volume key does not also change the volume.
 *
 * Autolinking finds this class by its name and its import: a file whose name
 * ends `Package.kt` and which imports `expo.modules.core.interfaces.Package`
 * is added to `ExpoModulesPackageList`. Rename either and the keys go quiet
 * with nothing to say why — see `expo-modules-autolinking`.
 *
 * The nullability of each parameter is the Java interface's own. Match it or
 * Kotlin does not see an override, and the handler is built with three methods
 * that are never called.
 */
class CoveyKeysPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context): List<ReactActivityHandler> =
    listOf(
      object : ReactActivityHandler {
        override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean =
          CoveyKeys.take(keyCode, event, true)

        override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
          CoveyKeys.take(keyCode, event, false)

        override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean =
          CoveyKeys.takeLongPress(keyCode)
      },
    )
}
