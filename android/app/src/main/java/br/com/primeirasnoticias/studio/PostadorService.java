package br.com.primeirasnoticias.studio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Postador automático no celular: serviço em primeiro plano permanente
 * (notificação "Postador automático ligado") que segura a CPU acordada e, a
 * cada 5 minutos, acorda o código do app (mesmo com a tela bloqueada) para ver
 * se é hora de postar. Volta sozinho se o sistema o encerrar.
 */
public class PostadorService extends Service {

    private static final String CHANNEL = "postador";
    private static final int ID = 4712;
    private static final long TICK_MS = 5 * 60 * 1000L;

    static volatile boolean running = false;
    /** texto da notificação (o que o Postador está fazendo agora) */
    private static volatile String texto = "Postador ligado: continua mesmo fora do app ou com a tela bloqueada";

    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            MainActivity.wakeWebView();
            MainActivity.dispatch("postador-tick");
            handler.postDelayed(this, TICK_MS);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = true;
        if (intent != null && intent.getStringExtra("texto") != null) texto = intent.getStringExtra("texto");
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Postador automático", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Primeiras Notícias · Postador")
            .setContentText(texto)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(texto))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ID, n);
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pnstudio:postador");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, 15_000);
        // alarme exato às 6h (o temporizador comum pode parar no modo de economia)
        PostadorAlarm.agendar(this);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        PostadorAlarm.cancelar(this);
        running = false;
        handler.removeCallbacks(tick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
