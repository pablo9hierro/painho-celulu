package br.com.primeirasnoticias.studio;

import android.annotation.SuppressLint;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Navegador escondido para baixar Reels pelos sites tipo SnapInsta (fastdl,
 * sssinstagram, igram): esses sites bloqueiam pedidos automáticos (Cloudflare),
 * mas abrem normal num navegador de verdade. Abre o site num WebView invisível,
 * roda o roteiro (cola o link, manda, espera o botão "Download") e devolve o
 * link do arquivo. O download em si é feito depois pela camada nativa.
 */
@CapacitorPlugin(name = "Extrator")
public class ExtratorPlugin extends Plugin {

    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    @PluginMethod
    public void extrair(PluginCall call) {
        final String site = call.getString("site", "");
        final String script = call.getString("script", "");
        final int timeout = call.getInt("timeoutMs", 50000);
        if (site.isEmpty() || script.isEmpty()) {
            call.reject("site/roteiro vazio");
            return;
        }
        getActivity().runOnUiThread(() -> {
            final AtomicBoolean acabou = new AtomicBoolean(false);
            final WebView wv = new WebView(getContext());
            final ViewGroup root = getActivity().findViewById(android.R.id.content);
            final Runnable[] limpa = new Runnable[1];
            limpa[0] = () -> {
                try {
                    root.removeView(wv);
                } catch (Exception ignored) {
                    // já removido
                }
                wv.stopLoading();
                wv.destroy();
            };
            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setLoadsImagesAutomatically(false);
            s.setMediaPlaybackRequiresUserGesture(true);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);
            wv.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void done(String link) {
                    if (!acabou.compareAndSet(false, true)) return;
                    call.resolve(new JSObject().put("link", link).put("site", site));
                    handler.post(limpa[0]);
                }

                @JavascriptInterface
                public void fail(String motivo) {
                    if (!acabou.compareAndSet(false, true)) return;
                    call.reject(site + ": " + motivo);
                    handler.post(limpa[0]);
                }
            }, "PNExtrator");
            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    // a cada página carregada (inclusive depois da verificação da Cloudflare) roda o roteiro;
                    // ele mesmo não roda duas vezes na mesma página
                    if (!acabou.get()) view.evaluateJavascript(script, null);
                }
            });
            // precisa estar na tela para o JavaScript rodar normal: 1 pixel, invisível
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
            wv.setAlpha(0f);
            wv.setVisibility(View.VISIBLE);
            root.addView(wv, lp);
            handler.postDelayed(() -> {
                if (!acabou.compareAndSet(false, true)) return;
                call.reject(site + ": tempo esgotado");
                limpa[0].run();
            }, timeout);
            wv.loadUrl(site);
        });
    }
}
