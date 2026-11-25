package com.audiosticker.studio;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final int REQ_RECORD_AUDIO = 401;
    private static final String PREFS_NAME = "as_studio_prefs";
    private static final String KEY_WA_LINKED = "wa_ever_linked";
    private static final String DESKTOP_CHROME_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile String pendingSharedMediaJson = null;
    private boolean bridgeAttached = false;

    // Embedded Invisible Background WhatsApp Multi-Device Engine (never visible during normal sends!)
    private LinearLayout waPairingContainer = null;
    private WebView waBgWebView = null;
    private TextView waPairingHeaderStatus = null;
    private String cachedSenderScript = null;
    private volatile boolean waEngineStarted = false;
    private volatile boolean waSessionReady = false;
    private volatile boolean waOverlayVisible = false;
    private volatile String lastChatsJson = "[]";
    private View capacitorMainView = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.RECORD_AUDIO},
                REQ_RECORD_AUDIO
            );
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (waOverlayVisible) {
                    hidePairingOverlay();
                    return;
                }
                if (getBridge() != null && getBridge().getWebView() != null && getBridge().getWebView().canGoBack()) {
                    getBridge().getWebView().goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });

        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#020617"));
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setAllowFileAccess(true);

            if (!bridgeAttached) {
                webView.addJavascriptInterface(new NativeAndroidBridge(), "AndroidSoundStickerBridge");
                bridgeAttached = true;
            }

            // Pre-warm invisible background WhatsApp engine AFTER startup if user already linked once!
            if (isEverLinked() && !waEngineStarted) {
                mainHandler.postDelayed(() -> ensureWaEngineInitialized(false), 1100);
            }

            if (pendingSharedMediaJson != null) {
                pushSharedMediaToWebView(pendingSharedMediaJson);
            }
        }
    }

    @Override
    public void onDestroy() {
        ioExecutor.shutdownNow();
        if (waBgWebView != null) {
            try {
                waBgWebView.destroy();
            } catch (Exception ignored) {}
            waBgWebView = null;
        }
        super.onDestroy();
    }

    private boolean isEverLinked() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(KEY_WA_LINKED, false);
    }

    private void setEverLinked(boolean linked) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_WA_LINKED, linked).apply();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void ensureWaEngineInitialized(boolean showPairingNow) {
        runOnUiThread(() -> {
            FrameLayout rootContent = findViewById(android.R.id.content);
            if (rootContent == null) return;

            if (capacitorMainView == null && rootContent.getChildCount() > 0) {
                capacitorMainView = rootContent.getChildAt(0);
            }

            if (waPairingContainer == null) {
                waPairingContainer = new LinearLayout(this);
                waPairingContainer.setOrientation(LinearLayout.VERTICAL);
                waPairingContainer.setBackgroundColor(Color.parseColor("#020617"));

                // Native Pairing Header (ONLY shown once during 8-digit code linking!)
                LinearLayout topBar = new LinearLayout(this);
                topBar.setOrientation(LinearLayout.HORIZONTAL);
                topBar.setBackgroundColor(Color.parseColor("#111B21"));
                topBar.setGravity(Gravity.CENTER_VERTICAL);
                final int padH = dp(10);
                final int padBottom = dp(10);
                topBar.setPadding(padH, dp(14), padH, padBottom);

                ViewCompat.setOnApplyWindowInsetsListener(topBar, (v, insets) -> {
                    Insets sys = insets.getInsets(
                        WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout()
                    );
                    v.setPadding(padH + sys.left, Math.max(dp(12), sys.top + dp(6)), padH + sys.right, padBottom);
                    return insets;
                });

                Button btnClose = makePillButton("← Volver", "#25D366", "#020617");
                btnClose.setOnClickListener(v -> hidePairingOverlay());

                waPairingHeaderStatus = new TextView(this);
                waPairingHeaderStatus.setText("Conecta 1 sola vez (código 8 dígitos) · Luego será invisible");
                waPairingHeaderStatus.setTextColor(Color.WHITE);
                waPairingHeaderStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
                waPairingHeaderStatus.setSingleLine(true);
                waPairingHeaderStatus.setEllipsize(TextUtils.TruncateAt.END);
                waPairingHeaderStatus.setPadding(dp(8), 0, dp(8), 0);
                waPairingHeaderStatus.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

                topBar.addView(btnClose);
                topBar.addView(waPairingHeaderStatus);
                waPairingContainer.addView(topBar);

                waBgWebView = new WebView(this);
                waBgWebView.setBackgroundColor(Color.parseColor("#0B141A"));
                waBgWebView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
                waBgWebView.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
                waPairingContainer.addView(waBgWebView);

                // Mount at index 0 (BEHIND opaque Capacitor WebView) so Chromium keeps timers active while 100% invisible!
                rootContent.addView(
                    waPairingContainer,
                    0,
                    new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                );
                ViewCompat.requestApplyInsets(topBar);

                WebSettings ws = waBgWebView.getSettings();
                ws.setJavaScriptEnabled(true);
                ws.setDomStorageEnabled(true);
                ws.setCacheMode(WebSettings.LOAD_DEFAULT);
                ws.setUserAgentString(DESKTOP_CHROME_UA);
                ws.setUseWideViewPort(true);
                ws.setLoadWithOverviewMode(true);
                ws.setBuiltInZoomControls(true);
                ws.setDisplayZoomControls(false);
                ws.setMediaPlaybackRequiresUserGesture(false);
                ws.setAllowFileAccess(true);

                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setAcceptThirdPartyCookies(waBgWebView, true);

                waBgWebView.addJavascriptInterface(new WaBackgroundBridge(), "AndroidPayloadBridge");
                waBgWebView.setWebChromeClient(new WebChromeClient());
                waBgWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        super.onPageFinished(view, url);
                        if (url != null && url.contains("web.whatsapp.com")) {
                            injectSenderScript(view);
                        }
                    }
                });
            }

            if (!waEngineStarted && waBgWebView != null) {
                waEngineStarted = true;
                waBgWebView.loadUrl("https://web.whatsapp.com/");
            }

            if (showPairingNow) {
                showPairingOverlay();
            } else {
                hidePairingOverlay();
            }
        });
    }

    private void showPairingOverlay() {
        runOnUiThread(() -> {
            if (waPairingContainer == null) return;
            waOverlayVisible = true;
            waPairingContainer.setVisibility(View.VISIBLE);
            waPairingContainer.bringToFront();
            if (waBgWebView != null) {
                waBgWebView.setFocusable(true);
                waBgWebView.setFocusableInTouchMode(true);
                waBgWebView.requestFocus();
            }
        });
    }

    private void hidePairingOverlay() {
        runOnUiThread(() -> {
            waOverlayVisible = false;
            if (waBgWebView != null) {
                waBgWebView.setFocusable(false);
                waBgWebView.clearFocus();
            }
            if (capacitorMainView != null) {
                capacitorMainView.bringToFront();
            }
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().requestFocus();
            }
        });
    }

    private void injectSenderScript(WebView view) {
        if (cachedSenderScript == null) {
            cachedSenderScript = readAssetText("wa-main-sender.js");
        }
        if (cachedSenderScript != null && !cachedSenderScript.isEmpty()) {
            view.evaluateJavascript(cachedSenderScript, null);
        }
    }

    private void triggerBackgroundSendNow() {
        runOnUiThread(() -> {
            if (waBgWebView != null) {
                waBgWebView.evaluateJavascript(
                    "(function(){ if(window.__AS_PUSH_ANDROID_PAYLOAD__) window.__AS_PUSH_ANDROID_PAYLOAD__(); })()",
                    null
                );
            }
        });
    }

    private void notifyStudioUi(String fnName, String argJsonOrStr) {
        runOnUiThread(() -> {
            if (getBridge() == null || getBridge().getWebView() == null) return;
            String js = "(function(){ if(typeof window." + fnName + " === 'function') window."
                + fnName + "(" + JSONObject.quote(argJsonOrStr) + "); })();";
            getBridge().getWebView().evaluateJavascript(js, null);
        });
    }

    private void launchOfficialWhatsAppApp(String optionalPhone) {
        runOnUiThread(() -> {
            PackageManager pm = getPackageManager();
            String waPkg = null;
            if (pm.getLaunchIntentForPackage("com.whatsapp") != null) {
                waPkg = "com.whatsapp";
            } else if (pm.getLaunchIntentForPackage("com.whatsapp.w4b") != null) {
                waPkg = "com.whatsapp.w4b";
            }

            // If we sent to a specific 1-on-1 contact, deep-link DIRECTLY into that chat in the official WhatsApp app!
            if (optionalPhone != null && !optionalPhone.isEmpty() && waPkg != null) {
                try {
                    Intent chatIntent = new Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("whatsapp://send?phone=" + Uri.encode(optionalPhone))
                    );
                    chatIntent.setPackage(waPkg);
                    chatIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    startActivity(chatIntent);
                    return;
                } catch (Exception ignored) {}
            }

            if (waPkg != null) {
                Intent launch = pm.getLaunchIntentForPackage(waPkg);
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    startActivity(launch);
                    return;
                }
            }

            try {
                Intent deep = new Intent(Intent.ACTION_VIEW, Uri.parse("whatsapp://app"));
                deep.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(deep);
            } catch (Exception e) {
                Toast.makeText(this, "No se encontró la app oficial de WhatsApp instalada.", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void shareFileDirectlyToWhatsAppApp(final String base64Data, final String fileName, final String mimeType) {
        ioExecutor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                File outDir = new File(getCacheDir(), "wa_share");
                if (!outDir.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    outDir.mkdirs();
                }
                File[] oldFiles = outDir.listFiles();
                if (oldFiles != null) {
                    for (File old : oldFiles) {
                        //noinspection ResultOfMethodCallIgnored
                        old.delete();
                    }
                }
                String safeName = (fileName != null && !fileName.isEmpty())
                    ? fileName.replaceAll("[^a-zA-Z0-9._-]", "_")
                    : "audiosticker.mp4";
                File outFile = new File(outDir, safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                    fos.flush();
                }

                Uri contentUri = FileProvider.getUriForFile(
                    MainActivity.this,
                    getPackageName() + ".fileprovider",
                    outFile
                );

                runOnUiThread(() -> {
                    PackageManager pm = getPackageManager();
                    Intent share = new Intent(Intent.ACTION_SEND);
                    share.setType(mimeType != null && !mimeType.isEmpty() ? mimeType : "video/mp4");
                    share.putExtra(Intent.EXTRA_STREAM, contentUri);
                    share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

                    if (pm.getLaunchIntentForPackage("com.whatsapp") != null) {
                        share.setPackage("com.whatsapp");
                        try {
                            startActivity(share);
                            return;
                        } catch (Exception ignored) {}
                    }
                    if (pm.getLaunchIntentForPackage("com.whatsapp.w4b") != null) {
                        share.setPackage("com.whatsapp.w4b");
                        try {
                            startActivity(share);
                            return;
                        } catch (Exception ignored) {}
                    }
                    share.setPackage(null);
                    startActivity(Intent.createChooser(share, "Enviar a WhatsApp"));
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "No se pudo compartir a WhatsApp: " + e.getMessage(),
                    Toast.LENGTH_LONG
                ).show());
            }
        });
    }

    // ------------------------------------------------------------------ Incoming Share Intent (Videos/Images/Audio)
    private void handleShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;

        final Uri streamUri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            streamUri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            @SuppressWarnings("deprecation")
            Uri legacy = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            streamUri = legacy;
        }
        if (streamUri == null) return;

        final String intentMime = intent.getType() != null ? intent.getType() : "";

        ioExecutor.execute(() -> {
            try {
                ContentResolver cr = getContentResolver();
                String mime = cr.getType(streamUri);
                if (mime == null || mime.isEmpty()) mime = intentMime;

                String displayName = queryDisplayName(cr, streamUri);
                String ext = resolveExtension(displayName, mime);
                if (displayName == null || displayName.isEmpty()) {
                    displayName = "video_compartido" + ext;
                }

                cleanupOldSharedCacheFiles();

                File outFile = new File(getCacheDir(), "shared_media_" + System.currentTimeMillis() + ext);
                try (InputStream in = cr.openInputStream(streamUri);
                     FileOutputStream out = new FileOutputStream(outFile)) {
                    if (in == null) return;
                    byte[] buf = new byte[65536];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                    }
                    out.flush();
                }

                String baseUrl = (getBridge() != null && getBridge().getLocalUrl() != null)
                    ? getBridge().getLocalUrl()
                    : "https://localhost";
                String localStreamUrl = baseUrl + Bridge.CAPACITOR_FILE_START + outFile.getAbsolutePath();

                JSONObject payload = new JSONObject();
                payload.put("url", localStreamUrl);
                payload.put("name", displayName);
                payload.put("mime", mime);

                String json = payload.toString();
                pendingSharedMediaJson = json;
                pushSharedMediaToWebView(json);
            } catch (Exception ignored) {}
        });
    }

    private void pushSharedMediaToWebView(final String json) {
        runOnUiThread(() -> {
            if (getBridge() == null || getBridge().getWebView() == null) return;
            String js = "(function(){ if (typeof window.__AS_RECEIVE_SHARED_MEDIA__ === 'function') { "
                + "if (window.AndroidSoundStickerBridge && window.AndroidSoundStickerBridge.consumePendingSharedMedia) { "
                + "window.AndroidSoundStickerBridge.consumePendingSharedMedia(); } "
                + "window.__AS_RECEIVE_SHARED_MEDIA__(" + JSONObject.quote(json) + "); } })();";
            getBridge().getWebView().evaluateJavascript(js, null);
        });
    }

    private void cleanupOldSharedCacheFiles() {
        File cacheDir = getCacheDir();
        if (cacheDir == null) return;
        File[] files = cacheDir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.getName().startsWith("shared_media_")) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    private String queryDisplayName(ContentResolver cr, Uri uri) {
        try (Cursor cursor = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String resolveExtension(String displayName, String mime) {
        if (displayName != null) {
            int dot = displayName.lastIndexOf('.');
            if (dot >= 0 && dot < displayName.length() - 1) {
                String candidate = displayName.substring(dot).toLowerCase().replaceAll("[^a-z0-9.]", "");
                if (candidate.length() >= 2 && candidate.length() <= 6) return candidate;
            }
        }
        if (mime != null && !mime.isEmpty()) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext != null && !ext.isEmpty()) return "." + ext;
            if (mime.startsWith("video/")) return ".mp4";
            if (mime.startsWith("audio/")) return ".mp3";
            if (mime.startsWith("image/")) return ".png";
        }
        return ".mp4";
    }

    private Button makePillButton(String text, String bgHex, String textHex) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextColor(Color.parseColor(textHex));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        b.setAllCaps(false);
        b.setMinHeight(dp(36));
        b.setMinimumHeight(dp(36));
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(12), dp(6), dp(12), dp(6));

        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(10));
        b.setBackground(gd);
        return b;
    }

    private String readAssetText(String assetPath) {
        try (InputStream is = getAssets().open(assetPath);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()
        ));
    }

    // ------------------------------------------------------------------ JS Bridge for Studio UI (Capacitor WebView)
    private class NativeAndroidBridge {
        @JavascriptInterface
        public String getWhatsAppEngineStatus() {
            try {
                JSONObject o = new JSONObject();
                o.put("connected", waSessionReady);
                o.put("everLinked", isEverLinked());
                o.put("chats", new JSONArray(lastChatsJson));
                return o.toString();
            } catch (Exception e) {
                return "{\"connected\":false,\"everLinked\":false,\"chats\":[]}";
            }
        }

        @JavascriptInterface
        public void openWhatsAppSender(String payloadJson) {
            PendingStickerStore.setPending(payloadJson);
            if (waSessionReady) {
                // 100% INVISIBLE BACKGROUND SEND! Never shows WhatsApp Web!
                notifyStudioUi("__AS_WA_SEND_PROGRESS__", "⚡ Enviando Sticker Real a tu WhatsApp...");
                triggerBackgroundSendNow();
            } else if (isEverLinked()) {
                // Reconnecting silently in background — never flash WhatsApp Web unless login expired!
                notifyStudioUi("__AS_WA_SEND_PROGRESS__", "⚡ Conectando en segundo plano con WhatsApp...");
                ensureWaEngineInitialized(false);
                triggerBackgroundSendNow();
            } else {
                // First time ever -> show 1-time 8-digit pairing setup
                ensureWaEngineInitialized(true);
            }
        }

        @JavascriptInterface
        public void openWhatsAppPairing() {
            ensureWaEngineInitialized(true);
        }

        @JavascriptInterface
        public void openWhatsAppSession() {
            if (waSessionReady) {
                launchOfficialWhatsAppApp("");
            } else {
                ensureWaEngineInitialized(true);
            }
        }

        @JavascriptInterface
        public void openOfficialWhatsAppApp(String optionalPhone) {
            launchOfficialWhatsAppApp(optionalPhone);
        }

        @JavascriptInterface
        public void shareFileDirectToWhatsApp(String base64Data, String fileName, String mimeType) {
            shareFileDirectlyToWhatsAppApp(base64Data, fileName, mimeType);
        }

        @JavascriptInterface
        public String consumePendingSharedMedia() {
            String data = pendingSharedMediaJson;
            pendingSharedMediaJson = null;
            return data != null ? data : "";
        }
    }

    // ------------------------------------------------------------------ JS Bridge for Invisible WA Engine WebView
    private class WaBackgroundBridge {
        @JavascriptInterface
        public String peekPendingPayload() {
            String json = PendingStickerStore.peekPending();
            return json != null ? json : "";
        }

        @JavascriptInterface
        public void clearPendingPayload() {
            PendingStickerStore.consumePending();
        }

        @JavascriptInterface
        public void onWhatsAppReady(String chatsJson) {
            waSessionReady = true;
            setEverLinked(true);
            if (chatsJson != null && chatsJson.startsWith("[")) {
                lastChatsJson = chatsJson;
            }
            boolean wasShowingPairing = waOverlayVisible;
            if (wasShowingPairing) {
                hidePairingOverlay();
                runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "✅ ¡WhatsApp conectado! Ya no volverás a ver WhatsApp Web.",
                    Toast.LENGTH_LONG
                ).show());
            }

            try {
                JSONObject st = new JSONObject();
                st.put("connected", true);
                st.put("everLinked", true);
                st.put("chats", new JSONArray(lastChatsJson));
                notifyStudioUi("__AS_WA_ENGINE_STATE__", st.toString());
            } catch (Exception ignored) {}

            // If a sticker was waiting to be sent, fire immediately in background!
            if (PendingStickerStore.peekPending() != null) {
                triggerBackgroundSendNow();
            }
        }

        @JavascriptInterface
        public void onWhatsAppNeedsLogin() {
            waSessionReady = false;
            setEverLinked(false);
            try {
                JSONObject st = new JSONObject();
                st.put("connected", false);
                st.put("everLinked", false);
                st.put("chats", new JSONArray());
                notifyStudioUi("__AS_WA_ENGINE_STATE__", st.toString());
            } catch (Exception ignored) {}

            // Only show pairing screen if user explicitly tried to send a real Sound Sticker
            if (PendingStickerStore.peekPending() != null) {
                notifyStudioUi("__AS_WA_SEND_ERROR__", "Tu sesión de WhatsApp expiró. Vuelve a vincular 1 sola vez.");
                showPairingOverlay();
            }
        }

        @JavascriptInterface
        public void onSendProgress(String text) {
            if (text != null) {
                notifyStudioUi("__AS_WA_SEND_PROGRESS__", text);
            }
        }

        @JavascriptInterface
        public void onSendError(String errorMsg) {
            PendingStickerStore.consumePending();
            notifyStudioUi("__AS_WA_SEND_ERROR__", errorMsg != null ? errorMsg : "Error enviando sticker.");
        }

        @JavascriptInterface
        public void onStickerSentAndOpenWhatsApp(String targetPhone) {
            PendingStickerStore.consumePending();
            notifyStudioUi("__AS_WA_SENT_OK__", targetPhone != null ? targetPhone : "");
            runOnUiThread(() -> {
                Toast.makeText(
                    MainActivity.this,
                    "✅ ¡Sticker Real con Sonido (🔊) enviado! Abriendo app de WhatsApp...",
                    Toast.LENGTH_LONG
                ).show();
                launchOfficialWhatsAppApp(targetPhone);
            });
        }
    }
}
