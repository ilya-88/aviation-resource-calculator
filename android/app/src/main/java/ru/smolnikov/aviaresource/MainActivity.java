package ru.smolnikov.aviaresource;

import android.Manifest;
import android.app.Activity;
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

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final int PICK_BOARD_IMAGE = 1002;
    private static final int PICK_AIRCRAFT_TEMPLATE = 1003;
    private static final int SAVE_AIRCRAFT_TEMPLATE = 1004;
    private static final int TEMPLATE_FILE_LIMIT = 256 * 1024;
    private byte[] pendingTemplate;
    private android.webkit.ValueCallback<Uri[]> boardImagePicker;
    private static final String DIAGNOSTIC_PREFS = "touch_diagnostics";
    private static final String TOUCH_LOG = "events";

    @Override
    public boolean dispatchTouchEvent(android.view.MotionEvent event) {
        String action;
        switch (event.getActionMasked()) {
            case android.view.MotionEvent.ACTION_DOWN: action = "down"; break;
            case android.view.MotionEvent.ACTION_UP: action = "up"; break;
            case android.view.MotionEvent.ACTION_CANCEL: action = "cancel"; break;
            case android.view.MotionEvent.ACTION_POINTER_DOWN: action = "pointer-down"; break;
            case android.view.MotionEvent.ACTION_POINTER_UP: action = "pointer-up"; break;
            default: return super.dispatchTouchEvent(event);
        }
        boolean handled = super.dispatchTouchEvent(event);
        android.content.SharedPreferences prefs = getSharedPreferences(DIAGNOSTIC_PREFS, MODE_PRIVATE);
        String entry = java.time.Instant.now() + " android.touch." + action
                + " fingers=" + event.getPointerCount()
                + " duration=" + (event.getEventTime() - event.getDownTime()) + "ms"
                + " handled=" + handled;
        String[] lines = (prefs.getString(TOUCH_LOG, "") + entry + "\n").split("\n");
        StringBuilder log = new StringBuilder();
        for (int i = Math.max(0, lines.length - 100); i < lines.length; i++) {
            log.append(lines[i]).append('\n');
        }
        prefs.edit().putString(TOUCH_LOG, log.toString()).apply();
        return handled;
    }

    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private WebView webView;
    private String pendingNotificationTitle;
    private String pendingNotificationBody;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) pendingTemplate = savedInstanceState.getByteArray("pendingAircraftTemplate");
        getWindow().setStatusBarColor(Color.rgb(18, 38, 58));
        getWindow().setNavigationBarColor(Color.rgb(255, 255, 255));
        ResourceReminderReceiver.ensureChannel(this);

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
            WindowInsetsController controller = getWindow().getDecorView().getWindowInsetsController();
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
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (boardImagePicker != null) boardImagePicker.onReceiveValue(null);
                boardImagePicker = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("image/*");
                try {
                    startActivityForResult(picker, PICK_BOARD_IMAGE);
                } catch (android.content.ActivityNotFoundException error) {
                    boardImagePicker = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "Нет приложения для выбора изображения", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        setContentView(root);
        root.requestApplyInsets();
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        ResourceReminderReceiver.dispatch(this);
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

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (pendingTemplate != null) state.putByteArray("pendingAircraftTemplate", pendingTemplate);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent result) {
        super.onActivityResult(requestCode, resultCode, result);
        if (requestCode == PICK_AIRCRAFT_TEMPLATE) {
            Uri uri = resultCode == RESULT_OK && result != null ? result.getData() : null;
            if (uri != null) new Thread(() -> readAircraftTemplate(uri)).start();
            return;
        }
        if (requestCode == SAVE_AIRCRAFT_TEMPLATE) {
            Uri uri = resultCode == RESULT_OK && result != null ? result.getData() : null;
            byte[] data = pendingTemplate;
            pendingTemplate = null;
            if (uri != null && data != null) new Thread(() -> writeAircraftTemplate(uri, data)).start();
            return;
        }
        if (requestCode != PICK_BOARD_IMAGE || boardImagePicker == null) return;
        android.webkit.ValueCallback<Uri[]> callback = boardImagePicker;
        boardImagePicker = null;
        Uri uri = resultCode == RESULT_OK && result != null ? result.getData() : null;
        callback.onReceiveValue(uri != null ? new Uri[]{uri} : null);
    }

    private void writeAircraftTemplate(Uri uri, byte[] data) {
        String message;
        try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("Missing output stream");
            output.write(data);
            message = "Файл шаблона сохранён";
        } catch (IOException | SecurityException error) {
            message = "Не удалось сохранить файл";
        }
        String status = message;
        runOnUiThread(() -> Toast.makeText(this, status, Toast.LENGTH_SHORT).show());
    }

    private void readAircraftTemplate(Uri uri) {
        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException("Missing input stream");
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > TEMPLATE_FILE_LIMIT) {
                    deliverAircraftTemplate(null, "Файл шаблона должен быть не больше 256 КБ");
                    return;
                }
                output.write(buffer, 0, count);
            }
            String text = new String(output.toByteArray(), StandardCharsets.UTF_8);
            if (text.startsWith("\uFEFF")) text = text.substring(1);
            deliverAircraftTemplate(text, null);
        } catch (IOException | SecurityException error) {
            deliverAircraftTemplate(null, "Не удалось прочитать файл");
        }
    }

    private void deliverAircraftTemplate(String text, String error) {
        String argument = text == null ? "null" : JSONObject.quote(text).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String message = error == null ? "null" : JSONObject.quote(error);
        runOnUiThread(() -> {
            if (webView != null && !isDestroyed()) {
                webView.evaluateJavascript("window.receiveAircraftTemplate && window.receiveAircraftTemplate(" + argument + "," + message + ")", null);
            }
        });
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void saveAircraftTemplate(String filename, String text) {
            if (filename == null || !filename.matches("[a-z][a-z0-9-]{0,47}\\.json") || text == null) return;
            byte[] data = text.getBytes(StandardCharsets.UTF_8);
            if (data.length > TEMPLATE_FILE_LIMIT) return;
            runOnUiThread(() -> {
                if (pendingTemplate != null) return;
                Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("application/json");
                picker.putExtra(Intent.EXTRA_TITLE, filename);
                pendingTemplate = data;
                try {
                    startActivityForResult(picker, SAVE_AIRCRAFT_TEMPLATE);
                } catch (android.content.ActivityNotFoundException error) {
                    pendingTemplate = null;
                    Toast.makeText(MainActivity.this, "Файловый менеджер недоступен", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void pickAircraftTemplate() {
            runOnUiThread(() -> {
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
                try {
                    startActivityForResult(picker, PICK_AIRCRAFT_TEMPLATE);
                } catch (android.content.ActivityNotFoundException error) {
                    deliverAircraftTemplate(null, "Файловый менеджер недоступен");
                }
            });
        }

        @JavascriptInterface
        public String getTouchDiagnostics() {
            return getSharedPreferences(DIAGNOSTIC_PREFS, MODE_PRIVATE).getString(TOUCH_LOG, "");
        }

        @JavascriptInterface
        public void clearTouchDiagnostics() {
            getSharedPreferences(DIAGNOSTIC_PREFS, MODE_PRIVATE).edit().remove(TOUCH_LOG).apply();
        }

        @JavascriptInterface
        public String getDiagnosticEnvironment() {
            return Build.MODEL + " | Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")";
        }

        @JavascriptInterface
        public String readSavedState() {
            return getSharedPreferences("aircraft_state", MODE_PRIVATE).getString("state", null);
        }

        @JavascriptInterface
        public boolean storeState(String value) {
            return value != null && getSharedPreferences("aircraft_state", MODE_PRIVATE)
                    .edit().putString("state", value).commit();
        }

        @JavascriptInterface
        public void copyDiagnostics(String text) {
            runOnUiThread(() -> {
                android.content.ClipboardManager clipboard = getSystemService(android.content.ClipboardManager.class);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Авиаресурс · диагностика", text));
            });
        }

        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                }
            });
        }

        @JavascriptInterface
        public void syncResourceReminders(String json) {
            runOnUiThread(() -> ResourceReminderReceiver.replaceSchedule(MainActivity.this, json));
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
        android.app.Notification notification = new android.app.Notification.Builder(this, ResourceReminderReceiver.CHANNEL)
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
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (pendingNotificationTitle != null) showLocalNotification(pendingNotificationTitle, pendingNotificationBody);
            ResourceReminderReceiver.dispatch(this);
        }
        pendingNotificationTitle = null;
        pendingNotificationBody = null;
    }
}
