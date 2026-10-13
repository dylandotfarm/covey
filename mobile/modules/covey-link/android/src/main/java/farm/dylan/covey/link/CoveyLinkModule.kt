package farm.dylan.covey.link

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Hold and release the service that keeps covey reachable (#184).
 *
 * Three calls and no state of its own: the service is the state, and it says so
 * itself. A flag kept here would disagree with it the first time Android
 * stopped the service without telling JavaScript.
 *
 * `hold` and `release` name a *reason* rather than switching the service, so
 * the device link and the thread watch cannot take each other down. The service
 * owns the set; see `CoveyLinkService`.
 */
class CoveyLinkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CoveyLink")

    Function("isRunning") {
      CoveyLinkService.running
    }

    Function("hold") { reason: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, CoveyLinkService::class.java)
        .putExtra(CoveyLinkService.EXTRA_REASON, reason)
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

    Function("release") { reason: String ->
      val context = appContext.reactContext ?: return@Function false
      // Nothing to release from a service that is not up, and starting one to
      // tell it to stop would put a notification on screen for an instant.
      if (!CoveyLinkService.running) return@Function true
      val intent = Intent(context, CoveyLinkService::class.java)
        .putExtra(CoveyLinkService.EXTRA_REASON, reason)
        .putExtra(CoveyLinkService.EXTRA_RELEASE, true)
      // Never `stopService`: it would end the service whatever else holds it.
      // The service stops itself when the last reason goes.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      true
    }
  }
}
