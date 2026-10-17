package app.linguatrack.mobile;

import android.content.*;
import android.media.*;
import android.os.*;
import android.speech.tts.*;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** System TTS is synthesized silently, measured, then played through the media stream. */
@CapacitorPlugin(name = "SpeechAudio")
public class SpeechAudioPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<PluginCall> probes = new ArrayList<>();
    private TextToSpeech tts;
    private boolean initialized, available, destroyed;
    private Job job;
    private AudioTrack player;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean focusHeld;
    private final AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    private static final class Job {
        final String id; final PluginCall call; final File file; final double gain; final Double target;
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int rate, channels, encoding; boolean rendering;
        Job(String id, PluginCall call, File file, double gain, Double target) {
            this.id = id; this.call = call; this.file = file; this.gain = gain; this.target = target;
        }
    }
    private final Runnable timeout = () -> finish("原生发音超时，请重试", "SPEECH_TIMEOUT");
    private final Runnable initTimeout = () -> completeInitialization(false);
    private final AudioManager.OnAudioFocusChangeListener focusChange = change -> {
        if (change < 0) main.post(() -> finish("音频已中断", "SPEECH_CANCELLED"));
    };
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { finish("音频输出已断开", "SPEECH_CANCELLED"); }
    };
    private final WebViewListener navigation = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { main.post(() -> finish("发音已停止", "SPEECH_CANCELLED")); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            main.post(() -> finish("发音已停止", "SPEECH_CANCELLED")); return false;
        }
    };
    @Override public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        ContextCompat.registerReceiver(getContext(), noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED);
        bridge.addWebViewListener(navigation);
        main.postDelayed(initTimeout, 10000);
        tts = new TextToSpeech(getContext(), status -> main.post(() -> completeInitialization(status == TextToSpeech.SUCCESS)));
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onError(String id) { fail(id); }
            @Override public void onError(String id, int code) { fail(id); }
            private void fail(String id) { main.post(() -> { if (matches(id)) finish("系统语音合成失败，请检查语音包或更换音色", "SPEECH_VOICE"); }); }
            @Override public void onBeginSynthesis(String id, int rate, int encoding, int channels) {
                main.post(() -> {
                    if (!matches(id)) return;
                    if (rate < 8000 || rate > 192000 || channels < 1 || channels > 2
                        || (encoding != AudioFormat.ENCODING_PCM_8BIT && encoding != AudioFormat.ENCODING_PCM_16BIT
                            && encoding != AudioFormat.ENCODING_PCM_FLOAT) || job.bytes.size() != 0) {
                        finish("此语音引擎无法生成支持的音频，请更换音色", "SPEECH_FORMAT"); return;
                    }
                    job.rate = rate; job.channels = channels; job.encoding = encoding;
                });
            }
            @Override public void onAudioAvailable(String id, byte[] audio) {
                // TTS engines can reuse callback buffers; copy before crossing queues.
                byte[] copied = audio.clone();
                main.post(() -> {
                    if (!matches(id) || job.rendering) return;
                    int width = job.encoding == AudioFormat.ENCODING_PCM_8BIT ? 1 : job.encoding == AudioFormat.ENCODING_PCM_16BIT ? 2 : 4;
                    if (job.rate == 0 || (long) job.bytes.size() + copied.length > (long) job.rate * job.channels * width * 30) {
                        finish("合成音频格式无效或过长", "SPEECH_FORMAT"); return;
                    }
                    job.bytes.write(copied, 0, copied.length);
                });
            }
            @Override public void onDone(String id) { main.post(() -> { if (matches(id) && !job.rendering) render(job); }); }
            @Override public void onStop(String id, boolean interrupted) {
                main.post(() -> { if (matches(id) && !job.rendering) finish("发音已停止", "SPEECH_CANCELLED"); });
            }
        });
    }
    private void completeInitialization(boolean success) {
        if (destroyed || initialized) return;
        initialized = true; available = success; main.removeCallbacks(initTimeout);
        for (PluginCall call : probes) resolveCapabilities(call);
        probes.clear();
    }
    @PluginMethod public void capabilities(PluginCall call) {
        main.post(() -> { if (destroyed) call.reject("发音已停止"); else if (initialized) resolveCapabilities(call); else probes.add(call); });
    }
    private void resolveCapabilities(PluginCall call) {
        JSArray voices = new JSArray();
        if (available) {
            Set<Voice> all = tts.getVoices(); Voice selected = tts.getVoice();
            if (all != null) {
                List<Voice> sorted = new ArrayList<>(all); sorted.sort(Comparator.comparing(Voice::getName));
                for (Voice voice : sorted) {
                    JSObject item = new JSObject(); item.put("voiceURI", voice.getName()); item.put("name", voice.getName());
                    item.put("lang", voice.getLocale().toLanguageTag()); item.put("localService", !voice.isNetworkConnectionRequired());
                    item.put("default", voice.equals(selected)); voices.put(item);
                }
            }
        }
        JSObject result = new JSObject(); result.put("pcmVolume", true); result.put("loudnessNormalization", true); result.put("externalPCM", true);
        result.put("voices", voices); call.resolve(result);
    }
    /** Downloaded voices bypass TextToSpeech and share its media output/focus lifecycle. */
    @PluginMethod public void playPCM(PluginCall call) {
        main.post(() -> {
            String id = call.getString("id", ""), encoded = call.getString("pcm", "");
            Integer rate = call.getInt("sampleRate"); Double target = call.getDouble("targetLufs");
            if (!id.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}") || rate == null || rate < 8000 || rate > 192000
                || encoded.isEmpty() || encoded.length() > (long) rate * 30 * 4 * 4 / 3 + 4
                || (target != null && (!Double.isFinite(target) || target < -100 || target > 0))) {
                call.reject("合成音频参数无效", "SPEECH_INVALID"); return;
            }
            if (destroyed) { call.reject("发音已停止", "SPEECH_CANCELLED"); return; }
            finish("发音已替换", "SPEECH_CANCELLED");
            Job current = new Job(id, call, null, call.getBoolean("muted", false) ? 0 : 1,
                call.getBoolean("muted", false) ? null : target);
            current.rate = rate; current.channels = 1; current.rendering = true; job = current;
            main.postDelayed(timeout, 45000);
            worker.execute(() -> {
                try {
                    byte[] raw = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
                    if (raw.length == 0 || raw.length % 4 != 0 || raw.length > rate * 30 * 4) throw new IllegalArgumentException("合成音频格式无效");
                    java.nio.FloatBuffer buffer = java.nio.ByteBuffer.wrap(raw).order(java.nio.ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
                    float[] samples = new float[buffer.remaining()]; buffer.get(samples);
                    short[] pcm = SpeechPCM.render(samples, rate, 1, current.gain, current.target);
                    main.post(() -> { if (job == current) play(current, pcm); });
                } catch (Exception error) { main.post(() -> { if (job == current) finish(error.getMessage(), "SPEECH_FORMAT"); }); }
            });
        });
    }
    @PluginMethod public void speak(PluginCall call) {
        main.post(() -> {
            String id = call.getString("id", ""), text = call.getString("text", ""); Double volume = call.getDouble("volume"), target = call.getDouble("targetLufs");
            if (!id.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}") || text.trim().isEmpty()
                || text.length() > 2000 || text.length() > TextToSpeech.getMaxSpeechInputLength() || volume == null
                || !Double.isFinite(volume) || volume < 0 || volume > 1
                || (target != null && (!Double.isFinite(target) || target < -100 || target > 0))) {
                call.reject("发音参数无效", "SPEECH_INVALID"); return;
            }
            if (destroyed || !available) { call.reject("系统语音引擎不可用，请安装或启用语音包后重新打开应用", "SPEECH_VOICE"); return; }
            finish("发音已替换", "SPEECH_CANCELLED");
            try {
                String lang = call.getString("lang", "en-US"), voiceId = call.getString("voiceURI", "");
                Locale locale = Locale.forLanguageTag(lang);
                int status = tts.setLanguage(locale);
                if (status < 0) throw new IllegalArgumentException("此语言没有可用的系统音色，请先安装语音包");
                Set<Voice> voices = tts.getVoices();
                if (!voiceId.isEmpty() && voices != null) for (Voice voice : voices) {
                    if (voice.getName().equals(voiceId) && voice.getLocale().getLanguage().equals(locale.getLanguage())) {
                        if (tts.setVoice(voice) != TextToSpeech.SUCCESS) throw new IllegalArgumentException("此音色不可用，请更换声音");
                        break;
                    }
                }
                tts.setSpeechRate(1); tts.setPitch(1);
                File file = File.createTempFile("lingua-speech-", ".wav", getContext().getCacheDir());
                boolean muted = call.getBoolean("muted", false);
                job = new Job(id, call, file, muted ? 0 : volume, muted ? null : target);
                main.postDelayed(timeout, 45000);
                Bundle params = new Bundle(); params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1);
                // synthesizeToFile has no audible output; onAudioAvailable supplies its raw PCM.
                if (tts.synthesizeToFile(text, params, file, id) != TextToSpeech.SUCCESS) finish("系统语音合成失败，请更换音色", "SPEECH_VOICE");
            } catch (Exception error) {
                if (job != null) finish(error.getMessage(), "SPEECH_VOICE"); else call.reject(error.getMessage(), "SPEECH_VOICE");
            }
        });
    }
    private boolean matches(String id) { return job != null && job.id.equals(id); }
    private void render(Job current) {
        current.rendering = true; byte[] raw = current.bytes.toByteArray(); current.bytes.reset(); current.file.delete();
        worker.execute(() -> {
            try {
                float[] decoded = SpeechPCM.decode(raw, current.encoding, current.rate, current.channels);
                short[] pcm = SpeechPCM.render(decoded, current.rate, current.channels, current.gain, current.target);
                main.post(() -> { if (job == current) play(current, pcm); });
            } catch (Exception error) { main.post(() -> { if (job == current) finish(error.getMessage(), "SPEECH_FORMAT"); }); }
        });
    }
    private void play(Job current, short[] pcm) {
        try {
            // Reuse the lesson's audio focus when it is playing; don't interrupt its clock.
            if (PlaybackService.instance == null || !PlaybackService.instance.isPlaying()) {
                int granted;
                if (Build.VERSION.SDK_INT >= 26) {
                    focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attributes).setOnAudioFocusChangeListener(focusChange, main).build();
                    granted = audioManager.requestAudioFocus(focusRequest);
                } else granted = audioManager.requestAudioFocus(focusChange, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
                focusHeld = granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
                if (!focusHeld) throw new IllegalStateException("音频输出正被占用，请重试");
            }
            AudioFormat format = new AudioFormat.Builder().setSampleRate(current.rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(current.channels == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO).build();
            player = new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(format)
                .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.length * 2).build();
            // Static tracks become initialized only after their first successful write.
            if (player.write(pcm, 0, pcm.length) != pcm.length || player.getState() != AudioTrack.STATE_INITIALIZED) {
                throw new IllegalStateException("原生发音音频加载失败");
            }
            player.setVolume(1);
            player.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
                @Override public void onMarkerReached(AudioTrack track) { if (job == current && player == track) finish(null, ""); }
                @Override public void onPeriodicNotification(AudioTrack track) { }
            }, main);
            if (player.setNotificationMarkerPosition(pcm.length / current.channels) != AudioTrack.SUCCESS) throw new IllegalStateException("发音结束标记设置失败");
            player.play();
            JSObject event = new JSObject(); event.put("id", current.id); event.put("state", "playing"); notifyListeners("stateChanged", event);
        } catch (Exception error) { finish(error.getMessage(), "SPEECH_PLAYBACK"); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        main.post(() -> { if (matches(call.getString("id", ""))) finish("发音已停止", "SPEECH_CANCELLED"); call.resolve(); });
    }
    private void finish(String message, String code) {
        Job previous = job; job = null; main.removeCallbacks(timeout);
        if (previous != null && !previous.rendering && tts != null) tts.stop();
        if (player != null) { player.release(); player = null; }
        if (focusHeld) {
            if (Build.VERSION.SDK_INT >= 26) audioManager.abandonAudioFocusRequest(focusRequest);
            else audioManager.abandonAudioFocus(focusChange);
            focusHeld = false; focusRequest = null;
        }
        if (previous != null) {
            if (previous.file != null) previous.file.delete(); previous.bytes.reset();
            if (message == null) previous.call.resolve(); else previous.call.reject(message, code);
        }
    }
    @Override protected void handleOnStop() { main.post(() -> finish("发音已停止", "SPEECH_CANCELLED")); }
    @Override protected void handleOnDestroy() {
        main.post(() -> {
            destroyed = true; finish("发音已停止", "SPEECH_CANCELLED"); main.removeCallbacks(initTimeout);
            for (PluginCall call : probes) call.reject("发音已停止", "SPEECH_CANCELLED"); probes.clear();
            if (tts != null) { tts.shutdown(); tts = null; }
            getContext().unregisterReceiver(noisy); bridge.removeWebViewListener(navigation); worker.shutdownNow();
        });
    }
}
