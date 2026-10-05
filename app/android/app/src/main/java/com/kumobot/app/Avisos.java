package com.kumobot.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Notificaciones de Kumo sin Web Push (el WebView no tiene PushManager).
 *
 * Este servicio nativo consulta /api/feed de tu nube cada ~15 min (minimo de
 * JobScheduler) y muestra cada aviso nuevo como notificacion del sistema.
 */
final class Avisos {
    static final String CANAL = "kumo_avisos";
    static final int JOB_ID = 5301;
    private static final String PREFS = "kumo_avisos";

    private Avisos() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static boolean activos(Context c) { return prefs(c).getBoolean("enabled", false); }

    static boolean permisoConcedido(Context c) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    static void guardar(Context c, String api, String token, boolean enabled) {
        SharedPreferences.Editor e = prefs(c).edit().putString("api", api).putString("token", token).putBoolean("enabled", enabled);
        if (enabled && !prefs(c).contains("since")) e.putString("since", "");
        e.apply();
    }

    static void crearCanal(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CANAL, "Avisos de Kumo", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Operaciones del bot y alertas de tu nube");
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    static void programar(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, AvisosJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(job);
    }

    static void cancelar(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        js.cancel(JOB_ID);
    }

    static void mostrar(Context c, int id, String titulo, String cuerpo) {
        if (!permisoConcedido(c)) return;
        crearCanal(c);
        Intent abrir = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, abrir, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CANAL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_kumo).setColor(0xFFFF2E88).setContentTitle(titulo).setContentText(cuerpo)
                .setStyle(new Notification.BigTextStyle().bigText(cuerpo))
                .setAutoCancel(true).setContentIntent(pi);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    /** Consulta el historial y notifica lo nuevo. Devuelve cuantos avisos mostro (-1 = error). */
    static int revisar(Context c) {
        SharedPreferences p = prefs(c);
        if (!p.getBoolean("enabled", false)) return 0;
        String api = p.getString("api", ""), token = p.getString("token", ""), since = p.getString("since", "");
        if (api.isEmpty()) return 0;
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(api + "/api/feed?since=" + URLEncoder.encode(since, "UTF-8")).openConnection();
            con.setConnectTimeout(15000);
            con.setReadTimeout(20000);
            con.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) con.setRequestProperty("Authorization", "Bearer " + token);
            int code = con.getResponseCode();
            p.edit().putString("ultimo_estado", "HTTP " + code).putLong("ultimo_ts", System.currentTimeMillis()).apply();
            if (code != 200) return -1;
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"));
            for (String l; (l = r.readLine()) != null; ) sb.append(l);
            r.close();
            JSONObject body = new JSONObject(sb.toString());
            JSONArray items = body.optJSONArray("items");
            // Primera consulta tras activar: solo lo de los ultimos 10 min, sin
            // descargar de golpe el historial viejo.
            long corte = since.isEmpty() ? System.currentTimeMillis() - 10 * 60 * 1000L : 0;
            int mostrados = 0;
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    if (corte > 0 && it.optLong("ts", 0) < corte) continue;
                    mostrar(c, it.optString("id", String.valueOf(i)).hashCode(), it.optString("title", "Kumo Bot"), it.optString("body", ""));
                    mostrados++;
                }
            }
            p.edit().putString("since", body.optString("now", since)).apply();
            return mostrados;
        } catch (Exception e) {
            p.edit().putString("ultimo_estado", "error: " + e.getClass().getSimpleName()).putLong("ultimo_ts", System.currentTimeMillis()).apply();
            return -1;
        } finally {
            if (con != null) con.disconnect();
        }
    }
}
