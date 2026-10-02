package farm.dylan.covey.link

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Start and stop the service that keeps the device reachable (#184).
 *
 * Three calls and no state of its own: the service is the state, and it says so
 * itself. A flag kept here would disagree with it the first time Android
 * stopped the service without telling JavaScript.
 */
class CoveyLinkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CoveyLink")

    Function("isRunning") {
      CoveyLinkService.running
    }

    Function("start") {
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, CoveyLinkService::class.java)
      /*
       * `startForegroundService` is the only one that may be called while the
       * app is not in front, and the service then has a few seconds to call
       * `startForeground` or Android kills it. It does so in `onStartCommand`,
       * synchronously, which is why there is no work before that line.
       */
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      true
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      context.stopService(Intent(context, CoveyLinkService::class.java))
      true
    }
  }
}
