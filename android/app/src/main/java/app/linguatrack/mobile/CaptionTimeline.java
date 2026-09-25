package app.linguatrack.mobile;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** A monotonic media clock, independent of WebView animation/timer throttling. */
final class CaptionTimeline {
    static final class Line {
        final double start;
        final String text, translation;

        Line(double start, String text, String translation) {
            this.start = start;
            this.text = text;
            this.translation = translation;
        }
    }

    private List<Line> lines = new ArrayList<>();
    private long sequence = -1, anchoredAt;
    private double position, duration, rate = 1;
    private boolean paused = true;

    boolean sync(long sequence, double position, double duration, double rate, boolean paused, long now) {
        if (sequence <= this.sequence) return false;
        this.sequence = sequence;
        if (Double.isFinite(position)) this.position = Math.max(0, position);
        if (Double.isFinite(duration)) this.duration = Math.max(0, duration);
        if (Double.isFinite(rate)) this.rate = Math.max(0.1, Math.min(16, rate));
        this.paused = paused;
        anchoredAt = now;
        return true;
    }

    void setLines(List<Line> value) {
        lines = new ArrayList<>();
        for (Line line : value) {
            if (Double.isFinite(line.start) && line.start >= 0) lines.add(line);
        }
        lines.sort(Comparator.comparingDouble(line -> line.start));
    }

    double positionAt(long now) {
        double elapsed = paused ? 0 : Math.max(0, now - anchoredAt) / 1000.0 * rate;
        return Math.min(duration, position + elapsed);
    }

    Line lineAt(long now) {
        if (lines.isEmpty()) return null;
        double time = positionAt(now) + 0.004;
        int lo = 0, hi = lines.size() - 1, index = 0;
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            if (lines.get(mid).start <= time) { index = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return lines.get(index);
    }

    /** Wake at the next caption boundary; a paused/final caption needs no polling. */
    long nextDelay(long now) {
        double time = positionAt(now) + 0.004;
        if (paused || time >= duration || lines.isEmpty()) return -1;
        int lo = 0, hi = lines.size();
        while (lo < hi) {
            int mid = (lo + hi) / 2;
            if (lines.get(mid).start <= time) lo = mid + 1; else hi = mid;
        }
        if (lo == lines.size() || lines.get(lo).start > duration) return -1;
        return Math.max(16, (long) Math.ceil((lines.get(lo).start - time) / rate * 1000));
    }
}
