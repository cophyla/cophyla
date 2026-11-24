// The range server on the JVM, with pieces of ten bytes and the page played by the test. An
// answer is a 206 of at most two pieces with the contract's headers; the pieces after it are
// asked for ahead; a stream has at most four needs with the page and requests a need waits on
// go first; concurrent requests for a piece share one need; pieces at hand are not asked for
// again, in memory or, for a kept file, on disk after a restart. A failed need is 502, one that
// times out 504, a stream closed under a request 410, an unknown one 404, a start past the end
// 416. And every body, read the way WebView reads one (it applies the range to the body
// itself), yields exactly the span's bytes, with WebView's own Content-Length the span's.
package com.fareaststudios.cophyla

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class MediaFilesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private data class Ask(val req: Long, val id: String, val index: Long, val at: Long, val len: Long)

    private val asked = LinkedBlockingQueue<Ask>()
    private val pool = Executors.newCachedThreadPool()
    private val made = ArrayList<MediaFiles>()

    @After
    fun stop() {
        for (m in made) m.shutdown()
        pool.shutdownNow()
    }

    private fun media(dir: File = tmp.root, timeoutMs: Long = 10_000): MediaFiles =
        MediaFiles(dir, { req, id, index, at, len -> asked.add(Ask(req, id, index, at, len)) }, pieceSize = P, diskCap = 1000, needTimeoutMs = timeoutMs)
            .also { made.add(it) }

    private fun byteAt(i: Long) = (i % 251).toByte()

    private fun bytes(at: Long, len: Long) = ByteArray(len.toInt()) { byteAt(at + it) }

    private fun give(m: MediaFiles, a: Ask) = m.piece(a.req, bytes(a.at, a.len), null)

    private fun next(): Ask = asked.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no need came")

    private fun noMore(ms: Long = 300) = assertNull(asked.poll(ms, TimeUnit.MILLISECONDS))

    /** Needs as they come, `n` of them. */
    private fun take(n: Int): List<Ask> = List(n) { next() }

    /** Pieces the page answered by itself, by index. */
    private val answered = java.util.concurrent.CopyOnWriteArrayList<Long>()

    /** Answers every need from now on, as the page would. */
    private fun page(m: MediaFiles) {
        pool.execute {
            while (!Thread.currentThread().isInterrupted) {
                val a = try {
                    asked.take()
                } catch (e: InterruptedException) {
                    return@execute
                }
                answered.add(a.index)
                give(m, a)
            }
        }
    }

    private fun request(m: MediaFiles, range: String?, id: String = "s1"): Future<MediaFiles.Reply> = pool.submit<MediaFiles.Reply> { m.answer("GET", id, range) }

    private fun MediaFiles.Reply.text(): String = String(body.readBytes(), Charsets.UTF_8)

    private fun waitUntil(what: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!what()) {
            assertTrue("timed out", System.currentTimeMillis() < end)
            Thread.sleep(10)
        }
    }

    @Test
    fun anAnswerIsTwoPiecesAtMostWithThreeAheadAndFourNeedsAtOnce() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val reply = request(m, "bytes=0-")
        // the pieces the request waits on first, then readahead, four at once
        val first = take(4)
        assertEquals(listOf(0L, 1L, 2L, 3L), first.map { it.index })
        assertEquals(Ask(first[1].req, "s1", 1, 10, 10), first[1])
        noMore()
        give(m, first[0])
        // a slot freed: the last piece ahead goes
        val fifth = next()
        assertEquals(4L, fifth.index)
        give(m, first[1])
        val r = reply.get(5, TimeUnit.SECONDS)
        assertEquals(206, r.status)
        assertEquals("Partial Content", r.reason)
        assertEquals("bytes 0-19/100", r.headers["Content-Range"])
        assertEquals("20", r.headers["Content-Length"])
        assertEquals("video/mp4", r.headers["Content-Type"])
        assertEquals("bytes", r.headers["Accept-Ranges"])
        assertEquals("no-store", r.headers["Cache-Control"])
        assertEquals("nosniff", r.headers["X-Content-Type-Options"])
        assertArrayEquals(bytes(0, 20), r.body.readBytes())
        give(m, first[2])
        give(m, first[3])
        give(m, fifth)
        noMore()
    }

    @Test
    fun aRequestsNeedGoesBeforeReadaheadForASlot() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val one = request(m, "bytes=0-")
        val first = take(4)
        // a seek while the slots are full: its pieces go before piece 4, which nobody waits on
        val two = request(m, "bytes=70-")
        noMore()
        give(m, first[0])
        val seven = next()
        assertEquals(7L, seven.index)
        give(m, first[1])
        val eight = next()
        assertEquals(8L, eight.index)
        assertEquals(206, one.get(5, TimeUnit.SECONDS).status)
        page(m)
        give(m, seven)
        give(m, eight)
        give(m, first[2])
        give(m, first[3])
        val r = two.get(5, TimeUnit.SECONDS)
        assertEquals("bytes 70-89/100", r.headers["Content-Range"])
        assertArrayEquals(bytes(70, 20), r.body.readBytes())
    }

    @Test
    fun concurrentRequestsForAPieceShareOneNeed() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val replies = mutableListOf(request(m, "bytes=0-"))
        val firstFour = take(4)
        assertEquals(listOf(0L, 1L, 2L, 3L), firstFour.map { it.index })
        // two more while those are with the page: they wait on the same needs
        replies.add(request(m, "bytes=5-"))
        replies.add(request(m, "bytes=12-"))
        noMore()
        page(m)
        for (a in firstFour) give(m, a)
        val spans = listOf(0L to 20L, 5L to 15L, 12L to 18L)
        for ((i, f) in replies.withIndex()) {
            val r = f.get(5, TimeUnit.SECONDS)
            assertEquals(206, r.status)
            assertArrayEquals(bytes(spans[i].first, spans[i].second), r.body.readBytes())
        }
        waitUntil { m.stats("s1")!!.fetched == 6L }
        Thread.sleep(200)
        // pieces 0 to 5, each asked for once
        val all = firstFour.map { it.index } + answered
        assertEquals((0L..5L).toList(), all.sorted())
        val stats = m.stats("s1")!!
        assertEquals(6L, stats.fetched)
        assertEquals(3L, stats.requests)
    }

    @Test
    fun piecesAtHandAreNotAskedForAgain() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        page(m)
        assertArrayEquals(bytes(0, 20), request(m, "bytes=0-").get(5, TimeUnit.SECONDS).body.readBytes())
        waitUntil { m.stats("s1")!!.fetched == 5L }
        assertArrayEquals(bytes(20, 20), request(m, "bytes=20-").get(5, TimeUnit.SECONDS).body.readBytes())
        // 2 and 3 from memory; 4 was there; 5 and 6 fetched ahead
        waitUntil { m.stats("s1")!!.fetched == 7L }
        val stats = m.stats("s1")!!
        assertEquals(2L, stats.requests)
        assertEquals(2L, stats.cached)
        // the same key opened again finds them
        m.open("s2", "k1", 100, "video/mp4", false)
        assertArrayEquals(bytes(30, 20), request(m, "bytes=30-", "s2").get(5, TimeUnit.SECONDS).body.readBytes())
        assertEquals(2L, m.stats("s2")!!.cached)
    }

    @Test
    fun keptPiecesOutliveTheApp() {
        val one = media()
        one.open("s1", "k1", 100, "video/mp4", true)
        page(one)
        assertArrayEquals(bytes(0, 20), request(one, "bytes=0-").get(5, TimeUnit.SECONDS).body.readBytes())
        waitUntil { one.stats("s1")!!.fetched == 5L }
        one.flush()
        one.shutdown()
        pool.shutdownNow()
        assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
        asked.clear()
        val two = media()
        two.open("s2", "k1", 100, "video/mp4", true)
        // pieces 0 and 1 from disk, and 2 to 4 ahead are there too
        val r = two.answer("GET", "s2", "bytes=0-")
        assertArrayEquals(bytes(0, 20), r.body.readBytes())
        noMore()
        assertEquals(2L, two.stats("s2")!!.cached)
        assertEquals(0L, two.stats("s2")!!.fetched)
    }

    @Test
    fun aFailedNeedIs502AndAPieceOfTheWrongSizeFails() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val f = request(m, "bytes=0-")
        val first = take(4)
        m.piece(first[0].req, null, "the link is down")
        val r = f.get(5, TimeUnit.SECONDS)
        assertEquals(502, r.status)
        assertEquals("the link is down", r.text())
        // a late answer for a settled need is dropped
        m.piece(first[0].req, bytes(0, 10), null)
        val g = request(m, "bytes=10-")
        // piece 1 is still pending: the request shares it
        m.piece(first[1].req, bytes(10, 9), null)
        val s = g.get(5, TimeUnit.SECONDS)
        assertEquals(502, s.status)
        assertTrue(s.text().contains("9 bytes"))
    }

    @Test
    fun aNeedThatTimesOutIs504() {
        val m = media(timeoutMs = 300)
        m.open("s1", "k1", 100, "video/mp4", false)
        val started = System.currentTimeMillis()
        val r = request(m, "bytes=50-").get(5, TimeUnit.SECONDS)
        assertEquals(504, r.status)
        assertTrue(System.currentTimeMillis() - started < 3_000)
    }

    @Test
    fun aSecondPieceThatFailsFailsTheRead() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val f = request(m, "bytes=5-")
        val first = take(4)
        give(m, first[0])
        val r = f.get(5, TimeUnit.SECONDS)
        assertEquals("15", r.headers["Content-Length"])
        val buf = ByteArray(5)
        assertEquals(5, r.body.read(buf, 0, 5))
        assertArrayEquals(bytes(5, 5), buf)
        m.piece(first[1].req, null, "the read failed")
        try {
            r.body.read(buf, 0, 5)
            fail("the read should fail")
        } catch (e: IOException) {
            assertEquals("the read failed", e.message)
        }
    }

    @Test
    fun aStreamClosedUnderARequestIs410() {
        val m = media()
        m.open("s1", "k1", 100, "video/mp4", false)
        val f = request(m, "bytes=0-")
        take(4)
        m.close("s1")
        assertEquals(410, f.get(5, TimeUnit.SECONDS).status)
        assertEquals(410, m.answer("GET", "s1", null).status)
        assertEquals(404, m.answer("GET", "nope", null).status)
        assertNotNull(m.stats("s1"))
        assertEquals(2L, m.stats("s1")!!.requests)
        assertNull(m.stats("nope"))
    }

    @Test
    fun theEdges() {
        val m = media()
        m.open("s1", "k1", 100, "audio/mpeg", false)
        val past = m.answer("GET", "s1", "bytes=100-")
        assertEquals(416, past.status)
        assertEquals("bytes */100", past.headers["Content-Range"])
        val head = m.answer("HEAD", "s1", "bytes=30-")
        assertEquals(206, head.status)
        assertEquals("bytes 30-49/100", head.headers["Content-Range"])
        assertEquals("20", head.headers["Content-Length"])
        assertEquals(-1, head.body.read())
        assertEquals(405, m.answer("POST", "s1", null).status)
        noMore()
        m.open("e", "empty", 0, "video/mp4", false)
        val empty = m.answer("GET", "e", "bytes=0-")
        assertEquals(200, empty.status)
        assertEquals("0", empty.headers["Content-Length"])
        assertEquals(-1, empty.body.read())
        noMore()
        assertEquals(3L, m.stats("s1")!!.requests)
    }

    @Test
    fun badOpensAreRefused() {
        val m = media()
        for ((id, key, size, mime) in listOf(
            listOf("", "k", 1L, "video/mp4"),
            listOf("a/b", "k", 1L, "video/mp4"),
            listOf("x".repeat(65), "k", 1L, "video/mp4"),
            listOf("ok", "", 1L, "video/mp4"),
            listOf("ok", "k", -1L, "video/mp4"),
            listOf("ok", "k", 1L, "video"),
            listOf("ok", "k", 1L, "video/mp4\r\nX-Evil: 1"),
            listOf("ok", "k", 1L, "video/mp4\r\n;x"),
        )) {
            try {
                m.open(id as String, key as String, size as Long, mime as String, false)
                fail("$id $key $size $mime should be refused")
            } catch (e: IllegalArgumentException) {
                // refused
            }
        }
        m.open("A-z_09", "k", 5_000_000_000L, "audio/ogg; codecs=opus", false)
        assertEquals(0L, m.stats("A-z_09")!!.requests)
    }

    @Test
    fun theIdComesFromThePath() {
        assertEquals("abc_1-2", MediaFiles.idOf("/_cophyla_media/abc_1-2/My%20Film.mp4"))
        assertEquals("abc", MediaFiles.idOf("/_cophyla_media/abc"))
        assertNull(MediaFiles.idOf("/_cophyla_media//x.mp4"))
        assertNull(MediaFiles.idOf("/_cophyla_media/a.b/x.mp4"))
        assertNull(MediaFiles.idOf("/views/x"))
    }

    @Test
    fun everyBodyIsTheSpanAsWebViewReadsIt() {
        val m = media()
        m.open("s1", "k1", 95, "video/mp4", false)
        page(m)
        for (range in listOf(null, "bytes=0-", "bytes=15-", "bytes=15-17", "bytes=19-", "bytes=90-", "bytes=94-", "bytes=-7", "bytes=30-40, 0-1")) {
            val r = request(m, range).get(5, TimeUnit.SECONDS)
            assertEquals(range, 206, r.status)
            val (first, last) = r.headers["Content-Range"]!!.removePrefix("bytes ").substringBefore('/').split('-').map { it.toLong() }
            val length = r.headers["Content-Length"]!!.toLong()
            assertEquals(range, last - first + 1, length)
            val (got, webViewLength) = asWebView(r.body, range)
            assertArrayEquals(range, bytes(first, length), got)
            // where WebView reads the header alike, its own Content-Length is the span's; else it says 0
            val alike = range == null || (!range.contains(',') && !range.contains("=-"))
            assertEquals(range, if (alike) length else 0L, webViewLength.toLong())
        }
    }

    /**
     * Reads a body as WebView does (Chromium's InputStreamReader::Seek, then ReadRawData): the
     * first `available()` taken as the stream's size to bound the range against, the range's
     * first bytes skipped, then reads sized by `available()`, each filled unless the end comes.
     * What it got, and the Content-Length it would write.
     */
    private fun asWebView(body: InputStream, header: String?): Pair<ByteArray, Int> {
        var first = -1L
        var last = -1L
        val spec = header?.removePrefix("bytes=")
        if (spec != null && !spec.contains(',') && !spec.startsWith("-")) {
            first = spec.substringBefore('-').toLong()
            last = spec.substringAfter('-').ifEmpty { "-1" }.toLong()
        }
        var contentSize = 0
        val size = body.available()
        if (size > 0) {
            if (first < 0) {
                first = 0
                last = size - 1L
            } else {
                assertTrue("the range is past what available() said", first < size)
                if (last < 0 || last >= size) last = size - 1L
            }
            contentSize = (last - first + 1).toInt()
        }
        var left = if (first > 0) first else 0L
        while (left > 0) {
            val k = body.skip(left)
            assertTrue(k in 1..Int.MAX_VALUE.toLong())
            left -= k
        }
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val avail = body.available()
            val want = if (avail > 1) minOf(avail, buf.size) else minOf(2048, buf.size)
            var got = 0
            while (got < want) {
                val n = body.read(buf, got, minOf(want - got, 4096))
                if (n < 0) break
                got += n
            }
            if (got == 0) break
            out.write(buf, 0, got)
        }
        return out.toByteArray() to contentSize
    }

    companion object {
        private const val P = 10
    }
}
