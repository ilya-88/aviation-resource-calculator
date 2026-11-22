package ru.smolnikov.aviaresource;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String CHANNEL_ID = "resource_reminders";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private WebView webView;
    private String pendingNotificationTitle;
    private String pendingNotificationBody;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(18, 38, 58));
        getWindow().setNavigationBarColor(Color.rgb(255, 255, 255));
        createNotificationChannel();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(243, 246, 248));
        View statusBarBackground = new View(this);
        statusBarBackground.setBackgroundColor(Color.rgb(18, 38, 58));
        root.addView(statusBarBackground, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP
        ));
        View navigationBarBackground = new View(this);
        navigationBarBackground.setBackgroundColor(Color.WHITE);
        root.addView(navigationBarBackground, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM
        ));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(243, 246, 248));
        FrameLayout.LayoutParams webViewLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        root.addView(webView, webViewLayout);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 15+ принудительно включает edge-to-edge для новых targetSdk.
            // Веб-контент должен занимать прямоугольник МЕЖДУ системными панелями,
            // а не получать padding внутри полноэкранного WebView.
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                );
                FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) webView.getLayoutParams();
                if (params.leftMargin != bars.left
                        || params.topMargin != bars.top
                        || params.rightMargin != bars.right
                        || params.bottomMargin != bars.bottom) {
                    params.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                    webView.setLayoutParams(params);
                }
                FrameLayout.LayoutParams statusParams = (FrameLayout.LayoutParams) statusBarBackground.getLayoutParams();
                statusParams.height = bars.top;
                statusBarBackground.setLayoutParams(statusParams);
                FrameLayout.LayoutParams navigationParams = (FrameLayout.LayoutParams) navigationBarBackground.getLayoutParams();
                navigationParams.height = bars.bottom;
                navigationBarBackground.setLayoutParams(navigationParams);
                return insets;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        setContentView(root);
        root.requestApplyInsets();
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Ресурсы и регламентные работы",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Напоминания о приближении работ и ограничений ресурсов");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "window.handleAndroidBack ? window.handleAndroidBack() : false",
                handled -> {
                    if (!"true".equals(handled)) MainActivity.super.onBackPressed();
                }
        );
    }

    public class AndroidBridge {
        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                } else {
                    Toast.makeText(MainActivity.this, "Уведомления разрешены", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void showNotification(String title, String body) {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    pendingNotificationTitle = title;
                    pendingNotificationBody = body;
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                    return;
                }
                showLocalNotification(title, body);
            });
        }

        @JavascriptInterface
        public void openCalendarEvent(String title, String description, long startMillis) {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_INSERT)
                        .setData(CalendarContract.Events.CONTENT_URI)
                        .putExtra(CalendarContract.Events.TITLE, title)
                        .putExtra(CalendarContract.Events.DESCRIPTION, description)
                        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
                        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMillis + 60L * 60L * 1000L);
                if (intent.resolveActivity(getPackageManager()) != null) {
                    startActivity(intent);
                } else {
                    Toast.makeText(MainActivity.this, "На устройстве не найден календарь", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void showLocalNotification(String title, String body) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        android.app.Notification notification = new android.app.Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(2001, notification);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && pendingNotificationTitle != null) {
            showLocalNotification(pendingNotificationTitle, pendingNotificationBody);
        }
        pendingNotificationTitle = null;
        pendingNotificationBody = null;
    }
}
