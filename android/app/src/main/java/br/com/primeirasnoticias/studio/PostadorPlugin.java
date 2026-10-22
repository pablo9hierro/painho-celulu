package br.com.primeirasnoticias.studio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Liga/desliga o Postador automático (serviço permanente) e pede para o Android não economizar bateria nele. */
@CapacitorPlugin(name = "Postador")
public class PostadorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4712);
            }
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), PostadorService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("Não consegui ligar o Postador: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), PostadorService.class));
        } catch (Exception e) {
            // já parado
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ligado", PostadorService.running);
        r.put("semEconomiaBateria", batteryOk());
        call.resolve(r);
    }

    /** abre o pedido do Android: "deixar o app rodar em segundo plano sem restrição" */
    @PluginMethod
    public void pedirBateria(PluginCall call) {
        try {
            if (!batteryOk() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(i);
            }
        } catch (Exception e) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
                // sem tela de bateria neste aparelho
            }
        }
        call.resolve();
    }

    private boolean batteryOk() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
