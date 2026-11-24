// The range a media request asks for, read and bounded as the contract with the page says: no
// header, or one that cannot be read, is `bytes=0-`; several ranges are the first; a start past
// the end is 416; an answer never reaches past the piece after the one holding its start, nor
// the file's end. And the first `available()` a body says, which makes the Content-Length
// WebView writes the span's, only where WebView reads the header the same way.
package com.fareaststudios.cophyla

import com.fareaststudios.cophyla.MediaRange.Span
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaRangeTest {
    private val p = MediaFiles.PIECE.toLong()
    private val size = 10 * p + 123

    private fun span(header: String?, size: Long = this.size) = MediaRange.answer(header, size, p)

    @Test
    fun noHeaderIsFromTheStartForTwoPieces() {
        assertEquals(Span(0, 2 * p - 1), span(null))
    }

    @Test
    fun anOpenEndStopsAtTheEndOfThePieceAfterTheStart() {
        assertEquals(Span(0, 2 * p - 1), span("bytes=0-"))
        assertEquals(Span(100, 2 * p - 1), span("bytes=100-"))
        assertEquals(Span(p - 1, 2 * p - 1), span("bytes=${p - 1}-"))
        assertEquals(Span(p, 3 * p - 1), span("bytes=$p-"))
        assertEquals(Span(2 * p - 1, 3 * p - 1), span("bytes=${2 * p - 1}-"))
    }

    @Test
    fun aBoundedRangeEndsWhereAskedOrAtTheBound() {
        assertEquals(Span(5, 9), span("bytes=5-9"))
        assertEquals(Span(0, 0), span("bytes=0-0"))
        assertEquals(Span(p + 5, p + 10), span("bytes=${p + 5}-${p + 10}"))
        assertEquals(Span(10, 2 * p - 1), span("bytes=10-${5 * p}"))
        assertEquals(Span(10, 2 * p - 1), span("BYTES = 10 - ${5 * p}"))
    }

    @Test
    fun theLastPiecesEndAtTheFile() {
        assertEquals(Span(9 * p, size - 1), span("bytes=${9 * p}-"))
        assertEquals(Span(size - 1, size - 1), span("bytes=${size - 1}-"))
        assertEquals(Span(0, 999), span("bytes=0-", 1000))
        assertEquals(Span(0, 999), span("bytes=0-5000", 1000))
        assertEquals(Span(0, 0), span(null, 1))
    }

    @Test
    fun aSuffixIsTheFilesLastBytes() {
        assertEquals(Span(size - 100, size - 1), span("bytes=-100"))
        assertEquals(Span(0, 2 * p - 1), span("bytes=-${size * 2}"))
        assertEquals(Span(0, 999), span("bytes=-5000", 1000))
        assertNull(span("bytes=-0"))
    }

    @Test
    fun aStartPastTheEndIs416() {
        assertNull(span("bytes=$size-"))
        assertNull(span("bytes=${size + 5}-${size + 9}"))
        assertNull(span("bytes=1000-", 1000))
    }

    @Test
    fun severalRangesAreTheFirst() {
        assertEquals(Span(500, 600), span("bytes=500-600, 0-10"))
        assertEquals(Span(size - 10, size - 1), span("bytes=-10,0-5"))
    }

    @Test
    fun aHeaderThatCannotBeReadIsFromTheStart() {
        for (h in listOf("items=0-5", "bytes=9-3", "bytes=abc", "bytes=", "bytes", "bytes=1-x", "bytes=99999999999999999999999-")) {
            assertEquals(h, Span(0, 2 * p - 1), span(h))
        }
    }

    @Test
    fun offsetsPastFourGiBAreLongs() {
        val big = 6_000_000_000L
        val first = 5_000_000_000L
        assertEquals(Span(first, (first / p + 2) * p - 1), span("bytes=$first-", big))
        assertEquals(Span(big - 10, big - 1), span("bytes=-10", big))
    }

    @Test
    fun theHintIsTheSpansEndWhereWebViewReadsTheHeaderAlike() {
        assertEquals((2 * p).toInt(), MediaRange.seekHint(null, Span(0, 2 * p - 1)))
        assertEquals((3 * p).toInt(), MediaRange.seekHint("bytes=$p-", Span(p, 3 * p - 1)))
        assertEquals(10, MediaRange.seekHint("bytes=5-9", Span(5, 9)))
        // a suffix, several ranges, a header WebView refuses, or past an int: WebView is told nothing
        assertEquals(0, MediaRange.seekHint("bytes=-100", Span(size - 100, size - 1)))
        assertEquals(0, MediaRange.seekHint("bytes=500-600, 0-10", Span(500, 600)))
        assertEquals(0, MediaRange.seekHint("items=0-", Span(0, 2 * p - 1)))
        assertEquals(0, MediaRange.seekHint("bytes=5000000000-", Span(5_000_000_000L, 5_000_000_009L)))
    }
}
