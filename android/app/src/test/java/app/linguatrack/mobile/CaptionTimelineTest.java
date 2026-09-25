package app.linguatrack.mobile;

import static org.junit.Assert.*;
import java.util.Arrays;
import org.junit.Test;

public class CaptionTimelineTest {
    @Test public void backgroundClockHonorsRatePauseSeekAndDuration() {
        CaptionTimeline clock = new CaptionTimeline();
        clock.sync(1, 10, 60, 2, false, 1000);
        assertEquals(30, clock.positionAt(11000), 0.001);
        clock.sync(2, 30, 60, 2, true, 11000);
        assertEquals(30, clock.positionAt(21000), 0.001);
        clock.sync(3, 3, 60, 0.5, false, 21000);
        assertEquals(8, clock.positionAt(31000), 0.001);
        assertEquals(60, clock.positionAt(200000), 0.001);
    }

    @Test public void staleUpdatesCannotRewindOrResumeAPausedClock() {
        CaptionTimeline clock = new CaptionTimeline();
        clock.sync(5, 25, 60, 1, true, 1000);
        assertFalse(clock.sync(4, 0, 60, 2, false, 2000));
        assertFalse(clock.sync(5, 0, 60, 2, false, 2000));
        assertEquals(25, clock.positionAt(10000), 0.001);
    }

    @Test public void sentencesAreSortedAndTranslationsCanBeReplacedWithoutResettingClock() {
        CaptionTimeline clock = new CaptionTimeline();
        clock.setLines(Arrays.asList(line(10, "second", "第二句"), line(2, "first", "第一句"), line(Double.NaN, "bad", "")));
        clock.sync(1, 0, 30, 1, false, 0);
        assertEquals("first", clock.lineAt(0).text);
        assertEquals("first", clock.lineAt(5000).text);
        assertEquals("second", clock.lineAt(10000).text);
        clock.setLines(Arrays.asList(line(2, "first", "第一句"), line(10, "second", "更新译文")));
        assertEquals("更新译文", clock.lineAt(12000).translation);
        clock.setLines(Arrays.asList(line(-1, "bad", "")));
        assertNull(clock.lineAt(12000));
    }

    @Test public void invalidClockValuesDoNotPoisonLaterTicks() {
        CaptionTimeline clock = new CaptionTimeline();
        clock.sync(1, 2, 30, 1, false, 1000);
        clock.sync(2, Double.NaN, Double.POSITIVE_INFINITY, Double.NaN, false, 2000);
        assertEquals(3, clock.positionAt(3000), 0.001);
        assertEquals(2, clock.positionAt(1000), 0.001);
    }

    private CaptionTimeline.Line line(double start, String text, String translation) {
        return new CaptionTimeline.Line(start, text, translation);
    }
}
