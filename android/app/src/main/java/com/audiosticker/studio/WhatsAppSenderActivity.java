package com.audiosticker.studio;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Embedded Desktop-UA WhatsApp Web Engine inside the Android APK.
 * Adapts dynamically to notches/cutouts on any phone, auto-sends REAL native Sound Stickers (🔊),
 * confirms server ACK, and automatically launches official WhatsApp!
 */
public class WhatsAppSenderActivity extends AppCompatActivity {
    private static final String DESKTOP_CHROME_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private WebView waWebView;
    private TextView headerStatusView;
    private String cachedSenderScript = null;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#020617"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // Top Native Header Bar with dynamic notch/cutout safe-area padding
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

        Button btnBack = makePillButton("← Editor", "#25D366", "#020617");
        btnBack.setOnClickListener(v -> finish());

        headerStatusView = new TextView(this);
        headerStatusView.setText("🔊 Conectando WhatsApp...");
        headerStatusView.setTextColor(Color.WHITE);
        headerStatusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        headerStatusView.setSingleLine(true);
        headerStatusView.setEllipsize(TextUtils.TruncateAt.END);
        headerStatusView.setPadding(dp(8), 0, dp(8), 0);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        );
        headerStatusView.setLayoutParams(titleLp);

        Button btnOpenWaNow = makePillButton("Abrir WA", "#005C4B", "#FFFFFF");
        btnOpenWaNow.setOnClickListener(v -> launchOfficialWhatsAppApp());

        topBar.addView(btnBack);
        topBar.addView(headerStatusView);
        topBar.addView(btnOpenWaNow);
        root.addView(topBar);

        // Full-Screen Hardware-Accelerated Desktop-UA WebView pointing to web.whatsapp.com
        waWebView = new WebView(this);
        waWebView.setBackgroundColor(Color.parseColor("#0B141A"));
        waWebView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        LinearLayout.LayoutParams webLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        );
        waWebView.setLayoutParams(webLp);
        root.addView(waWebView);
        setContentView(root);

        ViewCompat.requestApplyInsets(topBar);

        WebSettings ws = waWebView.getSettings();
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
        cm.setAcceptThirdPartyCookies(waWebView, true);

        waWebView.addJavascriptInterface(new WaPayloadBridge(), "AndroidPayloadBridge");
        waWebView.setWebChromeClient(new WebChromeClient());
        waWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.contains("web.whatsapp.com")) {
                    injectSenderEngine(view);
                }
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (waWebView != null && waWebView.canGoBack()) {
                    waWebView.goBack();
                } else {
                    finish();
                }
            }
        });

        waWebView.loadUrl("https://web.whatsapp.com/");
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

    @Override
    protected void onResume() {
        super.onResume();
        if (waWebView != null) {
            waWebView.onResume();
            waWebView.evaluateJavascript(
                "(function(){ if(window.__AS_PUSH_ANDROID_PAYLOAD__) window.__AS_PUSH_ANDROID_PAYLOAD__(); })()",
                null
            );
        }
    }

    @Override
    protected void onPause() {
        if (waWebView != null) {
            waWebView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (waWebView != null) {
            waWebView.destroy();
            waWebView = null;
        }
        super.onDestroy();
    }

    private void injectSenderEngine(WebView view) {
        if (cachedSenderScript == null) {
            cachedSenderScript = readAssetText("wa-main-sender.js");
        }
        if (cachedSenderScript != null && !cachedSenderScript.isEmpty()) {
            view.evaluateJavascript(cachedSenderScript, null);
        }
    }

    private void launchOfficialWhatsAppApp() {
        PackageManager pm = getPackageManager();
        Intent launch = pm.getLaunchIntentForPackage("com.whatsapp");
        if (launch == null) {
            launch = pm.getLaunchIntentForPackage("com.whatsapp.w4b");
        }
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(launch);
            return;
        }
        try {
            Intent deep = new Intent(Intent.ACTION_VIEW, Uri.parse("whatsapp://app"));
            deep.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(deep);
        } catch (Exception e) {
            Toast.makeText(this, "No se encontró la app de WhatsApp instalada.", Toast.LENGTH_LONG).show();
        }
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

    private class WaPayloadBridge {
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
        public void updateHeaderStatus(String text) {
            runOnUiThread(() -> {
                if (headerStatusView != null && text != null) {
                    headerStatusView.setText(text);
                }
            });
        }

        @JavascriptInterface
        public void onStickerSentAndOpenWhatsApp() {
            PendingStickerStore.consumePending();
            runOnUiThread(() -> {
                Toast.makeText(
                    WhatsAppSenderActivity.this,
                    "✅ ¡Sticker con Sonido (🔊) enviado! Abriendo WhatsApp...",
                    Toast.LENGTH_LONG
                ).show();
                launchOfficialWhatsAppApp();
                finish();
            });
        }
    }
}
