package br.com.primeirasnoticias.studio;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** a tela em uso (o serviço do Postador acorda o código do app por ela) */
    private static volatile MainActivity current;

    private static final int BG = Color.parseColor("#111316");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(PostadorPlugin.class);
        registerPlugin(DitadoPlugin.class);
        super.onCreate(savedInstanceState);

        // Mesmo comportamento em qualquer Android (o 15 força "edge-to-edge"):
        // o app desenha a tela toda e aplica margens do tamanho exato das barras
        // do sistema, do recorte da câmera e do teclado. Nada fica escondido.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(BG);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(sys.left, sys.top, sys.right, Math.max(sys.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        // Ignora o "tamanho da fonte" do sistema: com fonte aumentada no celular,
        // o layout do editor estourava e escondia botões (ex.: Ajustes).
        WebView webView = getBridge().getWebView();
        webView.getSettings().setTextZoom(100);
        webView.setBackgroundColor(BG);
        current = this;
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        super.onDestroy();
    }

    /** Postador: mantém o código do app rodando mesmo com a tela bloqueada */
    static void wakeWebView() {
        MainActivity a = current;
        if (a == null || a.getBridge() == null) return;
        a.runOnUiThread(() -> {
            WebView wv = a.getBridge().getWebView();
            wv.onResume();
            wv.resumeTimers();
        });
    }

    /** dispara um evento no código do app (ex.: "postador-tick") */
    static void dispatch(String event) {
        MainActivity a = current;
        if (a == null || a.getBridge() == null) return;
        a.runOnUiThread(() -> a.getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('" + event + "'))", null));
    }

    // Exportando: o WebView não pausa ao sair do app (a notificação mantém o processo vivo)
    @Override
    public void onPause() {
        super.onPause();
        keepRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepRunning();
    }

    private void keepRunning() {
        if (!(KeepAlivePlugin.active || PostadorService.running) || getBridge() == null) return;
        WebView wv = getBridge().getWebView();
        wv.onResume();
        wv.resumeTimers();
    }
}
