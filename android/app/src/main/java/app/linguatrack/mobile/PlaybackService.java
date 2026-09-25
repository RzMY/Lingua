package app.linguatrack.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.*;
import android.view.Surface;
import android.graphics.SurfaceTexture;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Owns decoding, audio focus, lock-screen controls and the clock even when WebView is stopped. */
public class PlaybackService extends Service {
    static PlaybackService instance;
    final Handler handler = new Handler(Looper.getMainLooper());
    final List<Runnable> listeners = new ArrayList<>();
    private final IBinder binder = new LocalBinder();
    class LocalBinder extends Binder { PlaybackService service() { return PlaybackService.this; } }
    private MediaPlayer player;
    private SurfaceTexture fallbackTexture;
    private Surface fallbackSurface;
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean focusHeld, resumeOnFocus, ready, playing, ended, seeking, foreground, appActive = true;
    private boolean repeatAll, waiting, releasing;
    private double loopStart = -1, loopEnd = -1;
    private float rate = 1, volume = 1;
    private boolean muted;
    private String session = "", title = "Lingua";
    private long revision, serial;
    private File source;
    private Consumer<JSObject> sink;
    private Consumer<String> preparation;
    private final Runnable prepareTimeout = () -> fail("媒体准备超时");
    private final Runnable pulse = new Runnable() {
        @Override public void run() {
            if (!ready) return;
            if (playing && !seeking && loopEnd > loopStart && loopStart >= 0
                && (position() >= loopEnd || position() < loopStart - .2)) seek(loopStart);
            else if (appActive && playing) publish("timeupdate");
            schedule();
        }
    };
    private final AudioManager.OnAudioFocusChangeListener focusChange = change -> {
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            if (resumeOnFocus) { resumeOnFocus = false; try { play(); } catch (RuntimeException ignored) { pause(); } }
        } else if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
            || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            boolean resume = playing && change != AudioManager.AUDIOFOCUS_LOSS;
            pause(); resumeOnFocus = resume;
        }
    };
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { pause(); }
    };

    @Override public void onCreate() {
        super.onCreate(); instance = this;
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel("playback", "媒体播放", NotificationManager.IMPORTANCE_LOW));
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes()).setOnAudioFocusChangeListener(focusChange).build();
        }
        androidx.core.content.ContextCompat.registerReceiver(this, noisy,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
        mediaSession = new MediaSession(this, "Lingua");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { control("play"); }
            @Override public void onPause() { control("pause"); }
            @Override public void onSeekTo(long pos) { seek(pos / 1000.0); }
            @Override public void onFastForward() { control("seekforward"); }
            @Override public void onRewind() { control("seekbackward"); }
            @Override public void onStop() { release(); }
        });
    }
    private AudioAttributes attributes() { return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build(); }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && session.equals(intent.getStringExtra("session"))) control(intent.getAction());
        return START_NOT_STICKY;
    }
    boolean matches(String id) { return !session.isEmpty() && session.equals(id); }
    String session() { return session; }
    boolean isReady() { return ready; }
    boolean isPlaying() { return playing; }
    double position() { return ready ? player.getCurrentPosition() / 1000.0 : 0; }
    double duration() { return ready ? Math.max(0, player.getDuration()) / 1000.0 : 0; }
    float rate() { return rate; }
    int videoWidth() { return ready ? player.getVideoWidth() : 0; }
    int videoHeight() { return ready ? player.getVideoHeight() : 0; }
    void setSurface(Surface surface) { if (player != null) player.setSurface(surface); }
    void setSink(Consumer<JSObject> value) { sink = value; }
    void setAppActive(boolean active) { appActive = active; if (active && ready) publish("state"); schedule(); }

    void prepare(String id, String name, File file, Consumer<String> result) {
        release(); session = id; title = name; source = file; preparation = result;
        revision = serial = 0; rate = 1; volume = 1; muted = false;
        player = new MediaPlayer();
        MediaPlayer expected = player;
        try {
            player.setAudioAttributes(attributes());
            player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
            player.setDataSource(file.getAbsolutePath());
            player.setOnPreparedListener(mp -> {
                if (player != expected) return;
                // A video-only/unextractable source needs a sink or MediaPlayer can stall its clock.
                // Ordinary MP4 audio was already separated by NativeVideo and has no video decoder.
                if (mp.getVideoWidth() > 0) {
                    fallbackTexture = Build.VERSION.SDK_INT >= 26 ? new SurfaceTexture(false) : new SurfaceTexture(0);
                    fallbackSurface = new Surface(fallbackTexture);
                    mp.setSurface(fallbackSurface);
                }
                ready = true; handler.removeCallbacks(prepareTimeout);
                Consumer<String> callback = preparation; preparation = null;
                if (callback != null) callback.accept(null);
                publish("loadedmetadata");
            });
            player.setOnSeekCompleteListener(mp -> {
                if (player != expected) return;
                seeking = false; publish("seeked"); schedule();
            });
            player.setOnCompletionListener(mp -> {
                if (player != expected) return;
                if (repeatAll || loopStart >= 0) { seek(loopStart >= 0 ? loopStart : 0); player.start(); }
                else { playing = false; ended = true; publish("ended"); }
            });
            player.setOnErrorListener((mp, what, extra) -> { if (player == expected) fail("原生媒体解码失败 (" + what + ")"); return true; });
            player.setOnInfoListener((mp, what, extra) -> {
                if (player != expected) return false;
                if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START || what == MediaPlayer.MEDIA_INFO_BUFFERING_END) {
                    waiting = what == MediaPlayer.MEDIA_INFO_BUFFERING_START; publish(waiting ? "waiting" : "playing");
                }
                return false;
            });
            handler.postDelayed(prepareTimeout, 15000); player.prepareAsync();
        } catch (Exception error) { fail("无法准备媒体：" + error.getMessage()); }
    }
    private void fail(String message) {
        Consumer<String> callback = preparation; preparation = null;
        if (callback != null) callback.accept(message);
        if (ready) { playing = false; publish("error"); }
        release();
    }
    private void startPlaybackService() {
        // Called from a visible page, a media notification or a visible application overlay.
        startService(new Intent(this, PlaybackService.class));
        if (Build.VERSION.SDK_INT >= 29) startForeground(71, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(71, notification());
        foreground = true;
    }
    void play() {
        if (!ready) return;
        startPlaybackService();
        if (!focusHeld) {
            int result = Build.VERSION.SDK_INT >= 26 ? audioManager.requestAudioFocus(focusRequest)
                : audioManager.requestAudioFocus(focusChange, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw new IllegalStateException("暂时无法取得音频焦点");
            focusHeld = true;
        }
        if (ended || position() >= duration() - .01) seek(0);
        ended = false; playing = true; resumeOnFocus = false;
        player.setPlaybackParams(new PlaybackParams().setSpeed(rate).setPitch(1));
        player.start(); publish("play"); schedule();
    }
    void pause() {
        resumeOnFocus = false;
        if (!ready) return;
        if (player.isPlaying()) player.pause();
        playing = false;
        if (focusHeld) {
            if (Build.VERSION.SDK_INT >= 26) audioManager.abandonAudioFocusRequest(focusRequest);
            else audioManager.abandonAudioFocus(focusChange);
            focusHeld = false;
        }
        publish("pause"); schedule();
    }
    void seek(double time) {
        if (!ready || !Double.isFinite(time)) return;
        long ms = Math.round(Math.max(0, Math.min(duration(), time)) * 1000);
        seeking = true; ended = false;
        if (Build.VERSION.SDK_INT >= 26) player.seekTo(ms, MediaPlayer.SEEK_CLOSEST);
        else player.seekTo((int) ms);
        publish("seeking");
    }
    void control(String action) {
        try {
            if ("play".equals(action)) play();
            else if ("pause".equals(action)) pause();
            else if ("seekbackward".equals(action)) seek(position() - 5);
            else if ("seekforward".equals(action)) seek(position() + 5);
            else if ("stop".equals(action)) release();
        } catch (RuntimeException error) { pause(); }
    }
    void command(JSObject data) {
        long next = data.optLong("revision", 0);
        if (next <= revision) return;
        revision = next;
        switch (data.optString("action")) {
            case "play": play(); break;
            case "pause": pause(); break;
            case "seek": seek(data.optDouble("position", position())); break;
            case "rate":
                double value = data.optDouble("rate", 1);
                if (!Double.isFinite(value) || value < .1 || value > 4) throw new IllegalArgumentException("播放速度无效");
                rate = (float) value;
                if (playing) player.setPlaybackParams(new PlaybackParams().setSpeed(rate).setPitch(1));
                publish("ratechange"); schedule(); break;
            case "volume":
                volume = (float) Math.max(0, Math.min(1, data.optDouble("volume", 1)));
                muted = data.optBoolean("muted", false); player.setVolume(muted ? 0 : volume, muted ? 0 : volume); break;
            case "metadata": title = data.optString("title", "Lingua"); publish("state"); break;
            case "loop":
                double start = data.optDouble("start", -1), end = Math.min(duration(), data.optDouble("end", -1));
                loopStart = Double.isFinite(start) && Double.isFinite(end) && start >= 0 && end > start ? start : -1;
                loopEnd = loopStart >= 0 ? end : -1; repeatAll = data.optBoolean("all", false); schedule(); break;
            default: throw new IllegalArgumentException("未知播放指令");
        }
    }
    JSObject snapshot(String event) {
        JSObject state = new JSObject();
        state.put("session", session); state.put("revision", revision); state.put("serial", ++serial);
        state.put("position", position()); state.put("duration", duration()); state.put("rate", rate);
        state.put("paused", !playing); state.put("ended", ended); state.put("seeking", seeking);
        state.put("waiting", waiting); state.put("ready", ready); state.put("event", event);
        return state;
    }
    private void publish(String event) {
        if (!"timeupdate".equals(event)) {
            mediaSession.setActive(ready);
            mediaSession.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration() * 1000)).build());
            mediaSession.setPlaybackState(new PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, (long) (position() * 1000), playing ? rate : 0).build());
            if (foreground) getSystemService(NotificationManager.class).notify(71, notification());
            for (Runnable listener : new ArrayList<>(listeners)) listener.run();
        }
        if (sink != null && (appActive || !"timeupdate".equals(event))) sink.accept(snapshot(event));
    }
    private void schedule() {
        handler.removeCallbacks(pulse);
        if (!ready || !playing) return;
        if (appActive) handler.postDelayed(pulse, 250);
        else if (loopEnd > loopStart && loopStart >= 0) handler.postDelayed(pulse,
            Math.max(20, (long) ((loopEnd - position()) / rate * 1000)));
    }
    private PendingIntent actionIntent(String action) {
        Intent intent = new Intent(this, PlaybackService.class).setAction(action).putExtra("session", session);
        return PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static void returnToApp(Context context) {
        context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "playback") : new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_pip_play).setContentTitle(title).setContentText(playing ? "正在播放" : "已暂停")
            .setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(R.drawable.ic_pip_rewind, "快退 5 秒", actionIntent("seekbackward")).build())
            .addAction(new Notification.Action.Builder(playing ? R.drawable.ic_pip_pause : R.drawable.ic_pip_play,
                playing ? "暂停" : "播放", actionIntent(playing ? "pause" : "play")).build())
            .addAction(new Notification.Action.Builder(R.drawable.ic_pip_forward, "快进 5 秒", actionIntent("seekforward")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "停止", actionIntent("stop")).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .setOngoing(playing).setDeleteIntent(actionIntent("stop")).build();
    }
    void release() {
        if (releasing) return;
        releasing = true;
        handler.removeCallbacks(pulse); handler.removeCallbacks(prepareTimeout);
        Consumer<String> callback = preparation; preparation = null;
        if (callback != null) callback.accept("媒体准备已取消");
        if (ready) pause();
        ready = playing = ended = seeking = waiting = false; repeatAll = false; loopStart = loopEnd = -1;
        if (player != null) { player.release(); player = null; }
        if (fallbackSurface != null) { fallbackSurface.release(); fallbackSurface = null; }
        if (fallbackTexture != null) { fallbackTexture.release(); fallbackTexture = null; }
        if (source != null) { source.delete(); source = null; }
        session = "";
        if (mediaSession != null) mediaSession.setActive(false);
        if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground = false; stopSelf(); }
        for (Runnable listener : new ArrayList<>(listeners)) listener.run();
        releasing = false;
    }
    @Override public void onTaskRemoved(Intent rootIntent) { release(); stopSelf(); }
    @Override public void onDestroy() { release(); unregisterReceiver(noisy); mediaSession.release(); listeners.clear(); instance = null; super.onDestroy(); }
}
