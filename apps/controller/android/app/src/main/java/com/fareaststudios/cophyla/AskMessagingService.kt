// The push receiver: the server's data-only messages become notifications here, so their
// buttons work while the app sleeps. An `ask` carries the ask's id, its node, title, detail
// and up to three options; each option becomes an action whose intent opens the app at
// `cophyla://ask/<id>/<option>`, and the body opens `cophyla://ask/<id>`. A `dismiss`
// withdraws the notification of an ask answered elsewhere. The Capacitor plugin's own
// handling still runs for the token (`registration`); the messages never reach it as
// notifications, since they carry no `notification` block.
package com.fareaststudios.cophyla

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray

class AskMessagingService : MessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        when (data["kind"]) {
            "ask" -> show(data)
            "dismiss" -> data["ask"]?.let { NotificationManagerCompat.from(this).cancel(it, NOTIFICATION_ID) }
            else -> super.onMessageReceived(message)
        }
    }

    private fun show(data: Map<String, String>) {
        val ask = data["ask"] ?: return
        val title = data["title"] ?: "Cophyla"
        val detail = data["detail"] ?: data["body"] ?: ""
        val multiple = data["multiple"] == "true"
        ensureChannel(this)
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openIntent(ask, null, 0))
        if (!multiple) {
            val options = try {
                JSONArray(data["options"] ?: "[]")
            } catch (e: Exception) {
                JSONArray()
            }
            var n = 0
            while (n < options.length() && n < MAX_BUTTONS) {
                val option = options.getJSONObject(n)
                val id = option.optString("id")
                val label = option.optString("label", id)
                if (id.isNotEmpty()) builder.addAction(0, label, openIntent(ask, id, n + 1))
                n++
            }
        }
        data["expiresAt"]?.toLongOrNull()?.let { expiresAt ->
            val ttl = expiresAt - System.currentTimeMillis()
            if (ttl > 0) builder.setTimeoutAfter(ttl)
        }
        try {
            NotificationManagerCompat.from(this).notify(ask, NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted: the ask waits on the socket
        }
    }

    /** Opens the app at the deep link; `slot` keeps the pending intents of one ask apart. */
    private fun openIntent(ask: String, option: String?, slot: Int): PendingIntent {
        val path = if (option == null) "cophyla://ask/${Uri.encode(ask)}" else "cophyla://ask/${Uri.encode(ask)}/${Uri.encode(option)}"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(path), this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(this, (ask.hashCode() * 8 + slot) and 0x7fffffff, intent, flags)
    }

    companion object {
        const val CHANNEL = "asks"
        const val NOTIFICATION_ID = 1
        const val MAX_BUTTONS = 3

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL) != null) return
            val channel = NotificationChannel(CHANNEL, "Asks", NotificationManager.IMPORTANCE_HIGH)
            channel.description = "An agent is waiting for your answer"
            manager.createNotificationChannel(channel)
        }
    }
}
