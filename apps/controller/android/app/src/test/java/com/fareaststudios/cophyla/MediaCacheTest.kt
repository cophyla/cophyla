// The media caches on the JVM. On disk: pieces written come back after a restart, a map made
// for another size or broken is thrown away with its data, and so is one whose data went; past
// the cap the closed file least recently opened or read goes first, whole, across restarts too,
// an open one never, and with only open ones left a piece is not kept; the cap counts pieces by
// their length. In memory: the least recently used piece goes past the capacity, and a look
// that is not a use does not keep one.
package com.fareaststudios.cophyla

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class MediaCacheTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clock = 1_000_000L
    private fun cache(cap: Long = 1000) = MediaCache(tmp.root, cap, 10) { clock }

    private val a = MediaFiles.sha256("a")
    private val b = MediaFiles.sha256("b")
    private val c = MediaFiles.sha256("c")
    private val d = MediaFiles.sha256("d")

    private fun piece(seed: Int, len: Int = 10) = ByteArray(len) { (seed * 31 + it).toByte() }

    private fun file(hex: String, ext: String) = File(tmp.root, hex + ext)

    @Test
    fun piecesComeBackAfterARestart() {
        val one = cache()
        one.open(a, 25)
        one.write(a, 0, piece(1))
        one.write(a, 2, piece(3, 5))
        one.close(a)
        val two = cache()
        two.open(a, 25)
        assertTrue(two.has(a, 0))
        assertFalse(two.has(a, 1))
        assertTrue(two.has(a, 2))
        assertArrayEquals(piece(1), two.read(a, 0))
        assertArrayEquals(piece(3, 5), two.read(a, 2))
        assertNull(two.read(a, 1))
        assertEquals(15L, two.bytes)
        assertEquals(2, two.present(a))
    }

    @Test
    fun aMapMadeForAnotherSizeIsThrownAway() {
        val one = cache()
        one.open(a, 25)
        one.write(a, 0, piece(1))
        one.close(a)
        val two = cache()
        two.open(a, 30)
        assertFalse(two.has(a, 0))
        assertEquals(0L, two.bytes)
        assertFalse(file(a, ".data").exists())
        assertFalse(file(a, ".map").exists())
    }

    @Test
    fun aBrokenMapIsThrownAwayWithItsData() {
        val one = cache()
        for (k in listOf(a, b)) {
            one.open(k, 25)
            one.write(k, 0, piece(1))
            one.close(k)
        }
        val map = file(a, ".map").readBytes()
        file(a, ".map").writeBytes(map.copyOf(map.size - 1))
        val other = file(b, ".map").readBytes()
        other[other.size - 1] = 7
        file(b, ".map").writeBytes(other)
        val two = cache()
        assertEquals(0L, two.bytes)
        for (k in listOf(a, b)) {
            assertFalse(file(k, ".data").exists())
            assertFalse(file(k, ".map").exists())
        }
    }

    @Test
    fun aMapWhoseDataWentIsThrownAway() {
        val one = cache()
        one.open(a, 25)
        one.write(a, 0, piece(1))
        one.close(a)
        assertTrue(file(a, ".data").delete())
        val two = cache()
        two.open(a, 25)
        assertFalse(two.has(a, 0))
        assertEquals(0L, two.bytes)
        // and one going while the app runs is noticed before a piece would be marked over the holes
        two.write(a, 1, piece(2))
        assertTrue(file(a, ".data").delete())
        two.write(a, 2, piece(3, 5))
        assertFalse(two.has(a, 1))
        assertTrue(two.has(a, 2))
        assertEquals(5L, two.bytes)
    }

    @Test
    fun theClosedFileLeastRecentlyUsedGoesFirst() {
        val cache = cache(cap = 30)
        for ((i, k) in listOf(a, b, c).withIndex()) {
            clock = 10L * (i + 1)
            cache.open(k, 10)
            cache.write(k, 0, piece(i))
            clock += 1
            cache.close(k)
        }
        // a was closed first but read since
        clock = 40
        assertArrayEquals(piece(0), cache.read(a, 0))
        clock = 50
        cache.open(d, 10)
        cache.write(d, 0, piece(9))
        assertTrue(cache.has(a, 0))
        assertFalse(cache.has(b, 0))
        assertTrue(cache.has(c, 0))
        assertTrue(cache.has(d, 0))
        assertEquals(30L, cache.bytes)
        assertFalse(file(b, ".data").exists())
        assertFalse(file(b, ".map").exists())
    }

    @Test
    fun theOrderHoldsAcrossARestart() {
        val one = cache(cap = 20)
        clock = 100
        one.open(b, 10)
        one.write(b, 0, piece(2))
        one.close(b)
        clock = 50
        one.open(a, 10)
        one.write(a, 0, piece(1))
        one.close(a)
        val two = cache(cap = 20)
        clock = 200
        two.open(c, 10)
        two.write(c, 0, piece(3))
        assertFalse(two.has(a, 0))
        assertTrue(two.has(b, 0))
        assertTrue(two.has(c, 0))
    }

    @Test
    fun anOpenFileIsNeverEvicted() {
        val cache = cache(cap = 30)
        for ((i, k) in listOf(a, b, c).withIndex()) {
            clock = 10L * (i + 1)
            cache.open(k, 10)
            cache.write(k, 0, piece(i))
        }
        clock = 50
        cache.open(d, 10)
        cache.write(d, 0, piece(9))
        assertFalse(cache.has(d, 0))
        assertEquals(30L, cache.bytes)
        cache.close(b)
        cache.write(d, 0, piece(9))
        assertTrue(cache.has(d, 0))
        assertFalse(cache.has(b, 0))
        assertTrue(cache.has(a, 0))
        assertTrue(cache.has(c, 0))
    }

    @Test
    fun theOnlyOpenFileStopsBeingKeptAtTheCap() {
        val cache = cache(cap = 20)
        cache.open(a, 50)
        for (i in 0L until 3L) cache.write(a, i, piece(i.toInt()))
        assertTrue(cache.has(a, 0))
        assertTrue(cache.has(a, 1))
        assertFalse(cache.has(a, 2))
        assertEquals(20L, cache.bytes)
    }

    @Test
    fun theCapCountsPiecesByTheirLength() {
        val cache = cache(cap = 25)
        cache.open(a, 25)
        cache.write(a, 0, piece(0))
        cache.write(a, 1, piece(1))
        cache.write(a, 2, piece(2, 5))
        assertEquals(25L, cache.bytes)
        assertEquals(3, cache.present(a))
        // a piece of the wrong length, one past the end, and one there already are not kept again
        cache.write(a, 2, piece(2))
        cache.write(a, 3, piece(3))
        cache.write(a, 0, piece(7))
        assertEquals(25L, cache.bytes)
        assertArrayEquals(piece(0), cache.read(a, 0))
    }

    @Test
    fun theLeastRecentlyUsedPieceGoesPastTheMemorysCapacity() {
        val m = MemoryPieces(3)
        for (i in 0L until 3L) m.put(a, i, piece(i.toInt()))
        assertArrayEquals(piece(0), m.get(a, 0))
        m.put(a, 3, piece(3))
        assertFalse(m.has(a, 1))
        assertTrue(m.has(a, 0))
        assertEquals(3, m.size)
        // a look is not a use: 2 is the oldest still
        assertTrue(m.has(a, 2))
        m.put(b, 0, piece(9))
        assertFalse(m.has(a, 2))
        assertTrue(m.has(a, 0))
        assertTrue(m.has(a, 3))
        assertTrue(m.has(b, 0))
    }
}
