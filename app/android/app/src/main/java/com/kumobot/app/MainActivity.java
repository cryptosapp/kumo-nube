package com.kumobot.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

public class MainActivity extends Activity {
    private static final int PERMISO_AVISOS = 77;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        webView.setWebViewClient(new WebViewClient() {
            // Los enlaces web se abren en el navegador: dentro del WebView
            // reemplazarian la app sin forma de volver.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String s = u.getScheme();
                if ("http".equals(s) || "https".equals(s)) { abrirExterno(u.toString()); return true; }
                return false;
            }
        });
        // Without a WebChromeClient, alert()/confirm() return immediately and every confirmed action silently does nothing.
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Puente(), "KumoNative");
        webView.loadUrl("file:///android_asset/www/index.html");
        if (Avisos.activos(this)) Avisos.programar(this);
    }

    private void abrirExterno(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
    }

    private void avisarWeb(String estado) {
        webView.post(() -> webView.evaluateJavascript("window.onAvisosNativos&&window.onAvisosNativos(" + JSONObject.quote(estado) + ")", null));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PERMISO_AVISOS) return;
        if (Avisos.permisoConcedido(this)) {
            Avisos.crearCanal(this);
            Avisos.programar(this);
            avisarWeb("granted");
        } else {
            avisarWeb("denied");
        }
    }

    /** Puente JS -> Android: notificaciones, enlaces externos, HTTP sin CORS y color de barras. */
    private class Puente {
        @JavascriptInterface
        public String estado() {
            try {
                JSONObject o = new JSONObject();
                o.put("enabled", Avisos.activos(MainActivity.this));
                o.put("permiso", Avisos.permisoConcedido(MainActivity.this) ? "granted" : "denied");
                o.put("ultimo_estado", Avisos.prefs(MainActivity.this).getString("ultimo_estado", ""));
                o.put("ultimo_ts", Avisos.prefs(MainActivity.this).getLong("ultimo_ts", 0));
                o.put("android", Build.VERSION.SDK_INT);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** Guarda servidor/token, crea el canal y programa la revision. Pide permiso en Android 13+. */
        @JavascriptInterface
        public String activar(String api, String token) {
            Avisos.guardar(MainActivity.this, api, token, true);
            Avisos.crearCanal(MainActivity.this);
            if (!Avisos.permisoConcedido(MainActivity.this)) {
                runOnUiThread(() -> requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, PERMISO_AVISOS));
                return "prompt";
            }
            Avisos.programar(MainActivity.this);
            return "granted";
        }

        @JavascriptInterface
        public void desactivar() {
            Avisos.guardar(MainActivity.this, Avisos.prefs(MainActivity.this).getString("api", ""), Avisos.prefs(MainActivity.this).getString("token", ""), false);
            Avisos.cancelar(MainActivity.this);
        }

        /** Mantiene el token del servicio igual al de la app si el usuario lo cambia. */
        @JavascriptInterface
        public void config(String api, String token) {
            if (Avisos.activos(MainActivity.this)) Avisos.guardar(MainActivity.this, api, token, true);
        }

        @JavascriptInterface
        public void probar(String titulo, String cuerpo) {
            Avisos.mostrar(MainActivity.this, 1, titulo, cuerpo);
        }

        /** Revisa el historial ya (en un hilo aparte) y avisa el resultado a la web. */
        @JavascriptInterface
        public void revisarAhora() {
            new Thread(() -> avisarWeb("revisado:" + Avisos.revisar(getApplicationContext()))).start();
        }

        @JavascriptInterface
        public void abrirUrl(String url) {
            if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) runOnUiThread(() -> abrirExterno(url));
        }

        /** Abre una billetera con bitcoin:/monero:. Devuelve false si no hay ninguna instalada. */
        @JavascriptInterface
        public boolean abrirBilletera(String uri) {
            if (uri == null || !(uri.startsWith("bitcoin:") || uri.startsWith("monero:"))) return false;
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
            if (i.resolveActivity(getPackageManager()) == null) return false;
            runOnUiThread(() -> { try { startActivity(i); } catch (Exception ignored) {} });
            return true;
        }

        /** Copia al portapapeles (navigator.clipboard no funciona en un WebView con file://). */
        @JavascriptInterface
        public void copiar(String texto) {
            runOnUiThread(() -> {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Kumo", texto));
            });
        }

        /**
         * HTTP nativo para APIs que no aceptan CORS desde un WebView (Cloudflare).
         * Solo HTTPS. Responde llamando a window.kumoHttp(id, status, texto).
         */
        @JavascriptInterface
        public void http(String id, String metodo, String url, String cabecerasJson, String cuerpo) {
            new Thread(() -> {
                int status = 0;
                String texto;
                HttpURLConnection con = null;
                try {
                    if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("solo https");
                    con = (HttpURLConnection) new URL(url).openConnection();
                    con.setRequestMethod(metodo);
                    con.setConnectTimeout(20000);
                    con.setReadTimeout(30000);
                    JSONObject h = new JSONObject(cabecerasJson == null || cabecerasJson.isEmpty() ? "{}" : cabecerasJson);
                    for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); con.setRequestProperty(k, h.getString(k)); }
                    if (cuerpo != null && !cuerpo.isEmpty()) {
                        con.setDoOutput(true);
                        try (OutputStream o = con.getOutputStream()) { o.write(cuerpo.getBytes("UTF-8")); }
                    }
                    status = con.getResponseCode();
                    InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    if (in != null) { byte[] b = new byte[8192]; for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n); in.close(); }
                    texto = buf.toString("UTF-8");
                } catch (Exception e) {
                    texto = "{\"error\":" + JSONObject.quote(e.getClass().getSimpleName() + ": " + e.getMessage()) + "}";
                } finally {
                    if (con != null) con.disconnect();
                }
                final String js = "window.kumoHttp&&window.kumoHttp(" + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(texto) + ")";
                webView.post(() -> webView.evaluateJavascript(js, null));
            }).start();
        }

        /** Colorea las barras del sistema según el tema elegido. */
        @JavascriptInterface
        public void barras(String color, boolean claro) {
            runOnUiThread(() -> {
                try {
                    int c = Color.parseColor(color);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                    View d = getWindow().getDecorView();
                    int f = d.getSystemUiVisibility();
                    if (Build.VERSION.SDK_INT >= 23) f = claro ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                    if (Build.VERSION.SDK_INT >= 26) f = claro ? (f | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
                    d.setSystemUiVisibility(f);
                } catch (Exception ignored) {}
            });
        }
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("(window.appBack&&window.appBack())?'1':'0'", value -> {
            if (!"\"1\"".equals(value)) MainActivity.super.onBackPressed();
        });
    }
}
