package br.com.primeirasnoticias.studio;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;

import java.util.Calendar;
import java.util.TimeZone;

/**
 * Alarme exato do Postador: às 6h (horário de Brasília) e, depois, a cada 30 min
 * até o meio-dia. O Android libera alarme exato mesmo no modo de economia
 * (Doze), coisa que o temporizador comum não garante com a tela bloqueada.
 * Ao tocar, segura a CPU 2 min e acorda o código do app para fazer o lote do blog.
 */
public class PostadorAlarm extends BroadcastReceiver {

    private static final int REQ = 4713;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pnstudio:alarme");
        wl.acquire(2 * 60 * 1000L);
        MainActivity.wakeWebView();
        MainActivity.dispatch("postador-tick");
        agendar(ctx);
    }

    /** próximo disparo: 6h00, depois a cada 30 min até 12h; fora disso, 6h do dia seguinte */
    static void agendar(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("America/Sao_Paulo"));
        int h = c.get(Calendar.HOUR_OF_DAY);
        int m = c.get(Calendar.MINUTE);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (h >= 6 && h < 12) {
            c.set(Calendar.MINUTE, m < 30 ? 30 : 0);
            if (m >= 30) c.add(Calendar.HOUR_OF_DAY, 1);
        } else {
            if (h >= 12) c.add(Calendar.DAY_OF_YEAR, 1);
            c.set(Calendar.HOUR_OF_DAY, 6);
            c.set(Calendar.MINUTE, 0);
        }
        Intent i = new Intent(ctx, PostadorAlarm.class);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, REQ, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        long at = c.getTimeInMillis();
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    static void cancelar(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, PostadorAlarm.class);
        am.cancel(PendingIntent.getBroadcast(ctx, REQ, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    }
}
