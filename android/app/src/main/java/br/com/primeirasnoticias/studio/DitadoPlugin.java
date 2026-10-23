package br.com.primeirasnoticias.studio;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Ditado contínuo (sem limite de tempo): fica ouvindo até o jornalista
 * desligar. O reconhecedor do Android para sozinho a cada pausa na fala —
 * cada vez que isso acontece a gente reinicia na hora, então para quem usa
 * parece uma escuta sem fim. Cada frase reconhecida (depois de uma pausa) é
 * um "comando" e sobe pro JS como evento.
 */
@CapacitorPlugin(name = "Ditado", permissions = { @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }) })
public class DitadoPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private volatile boolean ouvindo = false;
    /** true enquanto deveria continuar ouvindo (religa sozinho após cada pausa) */
    private volatile boolean deveContinuar = false;

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
        getActivity().runOnUiThread(this::iniciarEscuta);
        call.resolve();
    }

    private void iniciarEscuta() {
        if (!deveContinuar) return;
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            notifyListeners("ditado-erro", new JSObject().put("mensagem", "Este aparelho não tem reconhecimento de voz."));
            deveContinuar = false;
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(listener);
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200);
        recognizer.startListening(i);
        ouvindo = true;
        notifyListeners("ditado-status", new JSObject().put("ouvindo", true));
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onResults(Bundle results) {
            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) {
                notifyListeners("ditado-comando", new JSObject().put("texto", list.get(0).trim()));
            }
            if (deveContinuar) getActivity().runOnUiThread(DitadoPlugin.this::iniciarEscuta);
            else {
                ouvindo = false;
                notifyListeners("ditado-status", new JSObject().put("ouvindo", false));
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty()) notifyListeners("ditado-parcial", new JSObject().put("texto", list.get(0)));
        }

        @Override
        public void onError(int error) {
            // sem fala / timeout: normal numa escuta contínua — só religa
            if (deveContinuar) getActivity().runOnUiThread(DitadoPlugin.this::iniciarEscuta);
            else {
                ouvindo = false;
                notifyListeners("ditado-status", new JSObject().put("ouvindo", false));
            }
        }

        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}
    };

    @PluginMethod
    public void stop(PluginCall call) {
        deveContinuar = false;
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
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
        if (recognizer != null) recognizer.destroy();
        super.handleOnDestroy();
    }
}
