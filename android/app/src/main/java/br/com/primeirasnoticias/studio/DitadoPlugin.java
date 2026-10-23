package br.com.primeirasnoticias.studio;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Ditado contínuo (sem limite de tempo): fica ouvindo até o jornalista
 * desligar. O reconhecedor do Android para sozinho a cada pausa na fala —
 * cada vez que isso acontece a gente reinicia, então para quem usa parece uma
 * escuta sem fim. Cada frase reconhecida (depois de uma pausa) é um "comando"
 * e sobe pro JS como evento.
 *
 * Cuidados que resolveram o "liga e desliga em loop, sem transcrever nada":
 * - um SpeechRecognizer NOVO a cada religada (reaproveitar o mesmo depois de
 *   um erro deixava alguns aparelhos presos, devolvendo erro na hora, sem
 *   nem abrir o microfone de verdade — daí o beep contínuo sem texto);
 * - uma pequena pausa (400 ms) antes de religar, para o áudio do aparelho
 *   liberar o microfone direito;
 * - se errar várias vezes seguidas rapidinho, desliga sozinho e avisa qual
 *   foi o erro, em vez de ficar preso num loop silencioso para sempre.
 */
@CapacitorPlugin(name = "Ditado", permissions = { @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }) })
public class DitadoPlugin extends Plugin {

    private static final int MAX_ERROS_SEGUIDOS = 4;
    private static final long PAUSA_RELIGAR_MS = 400;

    private SpeechRecognizer recognizer;
    private volatile boolean ouvindo = false;
    /** true enquanto deveria continuar ouvindo (religa sozinho após cada pausa) */
    private volatile boolean deveContinuar = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int errosSeguidos = 0;
    private long ultimoInicio = 0;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("mic") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "onMicPermission");
            return;
        }
        ligar(call);
    }

    @PermissionCallback
    private void onMicPermission(PluginCall call) {
        if (getPermissionState("mic") == com.getcapacitor.PermissionState.GRANTED) ligar(call);
        else call.reject("Sem permissão do microfone.");
    }

    private void ligar(PluginCall call) {
        deveContinuar = true;
        errosSeguidos = 0;
        getActivity().runOnUiThread(this::iniciarEscuta);
        call.resolve();
    }

    private void iniciarEscuta() {
        if (!deveContinuar) return;
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            notifyListeners("ditado-erro", new JSObject().put("mensagem", "Este aparelho não tem reconhecimento de voz do Google instalado/ativado."));
            parar();
            return;
        }
        // recognizer novo a cada religada: alguns aparelhos travam reaproveitando
        // o mesmo objeto depois de um erro (erro na hora, sem abrir o microfone)
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // já estava destruído
            }
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(listener);
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        ultimoInicio = System.currentTimeMillis();
        recognizer.startListening(i);
        ouvindo = true;
        notifyListeners("ditado-status", new JSObject().put("ouvindo", true));
    }

    /** religa depois de uma pausinha, pro microfone ser liberado de verdade entre uma escuta e outra */
    private void religarComPausa() {
        if (!deveContinuar) return;
        handler.postDelayed(() -> {
            if (deveContinuar) iniciarEscuta();
        }, PAUSA_RELIGAR_MS);
    }

    private void parar() {
        deveContinuar = false;
        ouvindo = false;
        notifyListeners("ditado-status", new JSObject().put("ouvindo", false));
    }

    private static String nomeDoErro(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH: return "não entendi o que foi falado";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "silêncio (normal, religando)";
            case SpeechRecognizer.ERROR_AUDIO: return "erro de áudio no aparelho";
            case SpeechRecognizer.ERROR_NETWORK: return "sem internet para reconhecer a voz";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "internet lenta demais para reconhecer a voz";
            case SpeechRecognizer.ERROR_CLIENT: return "o reconhecedor do Android recusou (erro interno do aparelho)";
            case SpeechRecognizer.ERROR_SERVER: return "erro no servidor de voz do Google";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "o reconhecedor estava ocupado";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "sem permissão do microfone";
            default: return "erro " + error;
        }
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onResults(Bundle results) {
            errosSeguidos = 0;
            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) {
                notifyListeners("ditado-comando", new JSObject().put("texto", list.get(0).trim()));
            }
            if (deveContinuar) religarComPausa();
            else {
                ouvindo = false;
                notifyListeners("ditado-status", new JSObject().put("ouvindo", false));
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) {
                errosSeguidos = 0; // está captando voz de verdade
                notifyListeners("ditado-parcial", new JSObject().put("texto", list.get(0)));
            }
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyListeners("ditado-pronto", new JSObject());
        }

        @Override
        public void onError(int error) {
            boolean imediato = System.currentTimeMillis() - ultimoInicio < 800;
            // timeout por silêncio é normal numa escuta contínua; não conta como erro de verdade
            boolean esperado = error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_NO_MATCH;
            if (imediato && !esperado) errosSeguidos++;
            else if (!esperado) errosSeguidos = 0;
            if (errosSeguidos >= MAX_ERROS_SEGUIDOS) {
                notifyListeners("ditado-erro", new JSObject().put("mensagem", "O microfone não conseguiu ouvir (" + nomeDoErro(error) + "). Desliguei para não ficar piscando; tente ligar de novo.").put("codigo", error));
                parar();
                return;
            }
            if (deveContinuar) religarComPausa();
            else {
                ouvindo = false;
                notifyListeners("ditado-status", new JSObject().put("ouvindo", false));
            }
        }

        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}
    };

    @PluginMethod
    public void stop(PluginCall call) {
        deveContinuar = false;
        handler.removeCallbacksAndMessages(null);
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) {
                try {
                    recognizer.cancel();
                } catch (Exception ignored) {
                    // já parado
                }
            }
        });
        ouvindo = false;
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(new JSObject().put("ouvindo", ouvindo).put("disponivel", SpeechRecognizer.isRecognitionAvailable(getContext())));
    }

    @Override
    protected void handleOnDestroy() {
        deveContinuar = false;
        handler.removeCallbacksAndMessages(null);
        if (recognizer != null) recognizer.destroy();
        super.handleOnDestroy();
    }
}
