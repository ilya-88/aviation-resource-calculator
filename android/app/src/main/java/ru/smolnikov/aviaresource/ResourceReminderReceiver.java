package ru.smolnikov.aviaresource;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

public class ResourceReminderReceiver extends BroadcastReceiver {
    static final String CHANNEL = "resource_reminders";
    private static final String PREFS = "resource_reminder_schedule";
    private static final String SCHEDULE = "schedule";
    private static final String DELIVERED = "delivered";
    private static final String DISPLAYED = "displayed";
    private static final String TRIGGER = "ru.smolnikov.aviaresource.RESOURCE_REMINDER";
    private static final int NOTIFICATION_ID = 2002;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (TRIGGER.equals(intent.getAction()) || Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            dispatch(context);
        }
    }

    static void ensureChannel(Context context) {
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Ресурсы и регламентные работы",
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Напоминания о приближении работ и ограничений ресурсов");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static void replaceSchedule(Context context, String json) {
        final JSONArray reminders;
        try {
            reminders = new JSONArray(json);
        } catch (JSONException ignored) {
            return;
        }
        Set<String> active = new HashSet<>();
        for (int i = 0; i < reminders.length(); i++) {
            JSONObject item = reminders.optJSONObject(i);
            if (item != null && !item.optString("key").isEmpty()) active.add(item.optString("key"));
        }
        SharedPreferences prefs = preferences(context);
        Set<String> delivered = new HashSet<>(prefs.getStringSet(DELIVERED, Collections.emptySet()));
        delivered.retainAll(active);
        Set<String> displayed = prefs.getStringSet(DISPLAYED, Collections.emptySet());
        SharedPreferences.Editor change = prefs.edit().putString(SCHEDULE, json).putStringSet(DELIVERED, delivered);
        if (!active.containsAll(displayed)) {
            context.getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID);
            change.remove(DISPLAYED);
        }
        change.apply();
        dispatch(context);
    }

    static void dispatch(Context context) {
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent trigger = PendingIntent.getBroadcast(context, NOTIFICATION_ID,
                new Intent(context, ResourceReminderReceiver.class).setAction(TRIGGER), PendingIntent.FLAG_IMMUTABLE);
        SharedPreferences prefs = preferences(context);
        final JSONArray reminders;
        try {
            reminders = new JSONArray(prefs.getString(SCHEDULE, "[]"));
        } catch (JSONException ignored) {
            alarms.cancel(trigger);
            return;
        }
        if (!notifications.areNotificationsEnabled()) {
            alarms.cancel(trigger);
            return;
        }
        ensureChannel(context);
        NotificationChannel channel = notifications.getNotificationChannel(CHANNEL);
        if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
            alarms.cancel(trigger);
            return;
        }
        long now = System.currentTimeMillis();
        long next = Long.MAX_VALUE;
        Set<String> delivered = new HashSet<>(prefs.getStringSet(DELIVERED, Collections.emptySet()));
        Set<String> due = new HashSet<>();
        String text = "";
        for (int i = 0; i < reminders.length(); i++) {
            JSONObject item = reminders.optJSONObject(i);
            if (item == null) continue;
            String key = item.optString("key");
            long at = item.optLong("at", Long.MAX_VALUE);
            if (key.isEmpty() || delivered.contains(key)) continue;
            if (at > now) {
                next = Math.min(next, at);
            } else if (due.add(key)) {
                text = item.optString("body", "Проверь работы и остатки ресурсов");
            }
        }
        if (!due.isEmpty()) {
            showNotification(context, notifications, due.size() == 1 ? text : "Напоминаний о работах и ресурсах: " + due.size());
            delivered.addAll(due);
            prefs.edit().putStringSet(DELIVERED, delivered).putStringSet(DISPLAYED, due).apply();
        }
        if (next == Long.MAX_VALUE) alarms.cancel(trigger);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, trigger);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void showNotification(Context context, NotificationManager manager, String text) {
        Intent launch = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID, launch, PendingIntent.FLAG_IMMUTABLE);
        Notification publicVersion = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Авиаресурс")
                .setContentText("Напоминание о работе или ресурсе")
                .build();
        Notification notification = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Авиаресурс")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build();
        manager.notify(NOTIFICATION_ID, notification);
    }
}
