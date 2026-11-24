// The media a view plays, served to its player from a URL of the app's own that answers HTTP
// ranges (`https://<bridge.host>/_cophyla_media/<id>/<name>`), as the desktop shell serves it on
// its `doc` scheme: the player streams and seeks instead of waiting for a whole download. The
// bytes are the host page's to fetch (viewhost's MediaHost), since they come over Cophyla's RPC
// from whichever machine holds the file: for each piece of 1.5 MiB not at hand a `need` goes to
// the page (CophylaMediaPlugin) and the request waits up to a minute for its `piece`. Requests
// for the same piece share one need, a stream has at most four with the page at once, and the
// three pieces after each answer are asked for ahead of the player. One answer carries at most
// two pieces; the engine asks again for the rest. Pieces are kept: the 16 most recent in memory
// across every stream (MemoryPieces), and those of a file on another machine (`keep`) on disk
// under `cacheDir/media-cache/` (MediaCache), so a seek back or a second play fetches nothing.
//
// WebView applies a request's `Range` itself to the stream an intercepted response hands it
// (Chromium's InputStreamReader::Seek): it reads `available()`, then skips the range's first
// bytes before it reads. A body here already starts at the range's first byte, so it
// acknowledges those skips without dropping anything, and sizes its first `available()` so
// that the Content-Length WebView writes comes out right (EngineBody).
package com.fareaststudios.cophyla

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class MediaFiles(
    /** The disk cache's folder: `cacheDir/media-cache/` in the app. */
    dir: File,
    private val needs: Needs,
    private val pieceSize: Int = PIECE,
    diskCap: Long = DISK_CAP,
    memoryPieces: Int = MEMORY_PIECES,
    private val needTimeoutMs: Long = NEED_TIMEOUT_MS,
) {
    /** Where a need goes: the page, which answers it with `piece`. Called on whatever thread asked, never under a lock. */
    fun interface Needs {
        fun need(req: Long, id: String, index: Long, at: Long, len: Long)
    }

    /** A stream's counts: HTTP requests answered, pieces fetched from the page, pieces served from a cache without a fetch. */
    class Stats(val requests: Long, val fetched: Long, val cached: Long)

    /** An HTTP answer before it is WebView's: its status, its headers (Content-Type among them) and its body. */
    class Reply(val status: Int, val reason: String, val headers: Map<String, String>, val body: InputStream)

    private sealed class Outcome {
        class Data(val bytes: ByteArray) : Outcome()
        class Failed(val message: String) : Outcome()
        object TimedOut : Outcome()
        object Closed : Outcome()
    }

    /** One piece asked of the page: queued until a slot frees, then sent, then settled once. */
    private class Need(val req: Long, val stream: Stream, val index: Long, val len: Int, var wanted: Boolean) {
        var sent = false
        var outcome: Outcome? = null
        var timer: ScheduledFuture<*>? = null
        val done = CountDownLatch(1)
    }

    private class Stream(val id: String, val hex: String, val size: Long, val mime: String, val keep: Boolean) {
        var closed = false
        val requests = AtomicLong()
        val fetched = AtomicLong()
        val cached = AtomicLong()
        /** Needs not settled yet, by piece: queued or with the page. */
        val needs = HashMap<Long, Need>()
        /** Needs waiting for a slot, in the order they came. */
        val queue = ArrayList<Need>()
        var inFlight = 0
        fun stats() = Stats(requests.get(), fetched.get(), cached.get())
    }

    /** Where a piece of an answer comes from. */
    private sealed class Source {
        class Ready(val bytes: ByteArray) : Source()
        class OnDisk(val index: Long) : Source()
        class Pending(val need: Need) : Source()
    }

    /** Guards the streams, their needs and `byReq`. */
    private val lock = Any()
    private val streams = HashMap<String, Stream>()
    /** Streams closed lately, for their stats and a 410 to a late request. */
    private val gone = object : LinkedHashMap<String, Stream>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Stream>?): Boolean = size > GONE_KEPT
    }
    /** Needs with the page, by `req`. */
    private val byReq = HashMap<Long, Need>()
    private var nextReq = 1L

    private val memory = MemoryPieces(memoryPieces)
    private val disk = MediaCache(dir, diskCap, pieceSize)
    /** Pieces go to disk on a thread of their own, so neither the page's calls nor the player wait on the flash. */
    private val writer = Executors.newSingleThreadExecutor(daemon("cophyla-media-write"))
    private val timer = ScheduledThreadPoolExecutor(1, daemon("cophyla-media-timer")).apply { removeOnCancelPolicy = true }

    // --- the page's side ------------------------------------------------------------------------

    /** Opens a stream the player can be given the URL of; an id opened again is a new stream. Throws IllegalArgumentException on a bad argument. */
    fun open(id: String, key: String, size: Long, mime: String, keep: Boolean) {
        require(ID.matches(id)) { "id must be 1 to 64 of A-Z, a-z, 0-9, _ and -" }
        require(key.isNotEmpty() && key.length <= KEY_MAX) { "key required" }
        require(size >= 0) { "size must be 0 or more" }
        require(size / pieceSize < Int.MAX_VALUE) { "size is too large" }
        require(MIME.matches(mime)) { "mime must be a type like video/mp4" }
        close(id)
        val s = Stream(id, sha256(key), size, mime, keep)
        if (keep) disk.open(s.hex, size)
        synchronized(lock) {
            streams[id] = s
            gone.remove(id)
        }
    }

    /** The page's answer to need `req`: the piece's bytes, or what went wrong. An answer to a need already settled is dropped. */
    fun piece(req: Long, data: ByteArray?, error: String?) {
        val n = synchronized(lock) { byReq[req] } ?: return
        val outcome = when {
            data != null && data.size == n.len -> Outcome.Data(data)
            data != null -> Outcome.Failed("the piece came with ${data.size} bytes, not ${n.len}")
            else -> Outcome.Failed(error?.trim()?.take(ERROR_MAX)?.ifEmpty { null } ?: "the piece did not come")
        }
        complete(n, outcome)
    }

    /** Ends a stream: requests waiting on it end with 410, a body still being read fails; its disk cache stays. */
    fun close(id: String) {
        val s: Stream
        val ended: List<Need>
        synchronized(lock) {
            s = streams.remove(id) ?: return
            s.closed = true
            gone[id] = s
            ended = s.needs.values.toList()
            for (n in ended) settle(n, Outcome.Closed)
            s.needs.clear()
            s.queue.clear()
            s.inFlight = 0
        }
        for (n in ended) n.done.countDown()
        if (s.keep) disk.close(s.hex)
    }

    /** Ends every stream, as a page loaded afresh knows none of them. */
    fun closeAll() {
        val ids = synchronized(lock) { streams.keys.toList() }
        for (id in ids) close(id)
    }

    /** A stream's counts, open or closed lately; null for an id never opened. */
    fun stats(id: String): Stats? = synchronized(lock) { (streams[id] ?: gone[id])?.stats() }

    /** Ends everything: the app is going. */
    fun shutdown() {
        closeAll()
        writer.shutdown()
        timer.shutdownNow()
    }

    /** Waits until the pieces handed to the disk so far are written (tests). */
    internal fun flush() {
        writer.submit(Runnable {}).get()
    }

    // --- the player's side ----------------------------------------------------------------------

    /** The response for a request to a stream's URL, or null when the request is not for one. Runs on WebView's thread, and blocks while the first piece comes. */
    fun serve(request: WebResourceRequest, host: String?): WebResourceResponse? {
        val uri = request.url
        if (uri.host != host) return null
        val path = uri.path ?: return null
        if (!path.startsWith(PREFIX)) return null
        val range = request.requestHeaders?.entries?.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val reply = answer(request.method ?: "GET", idOf(path) ?: "", range)
        val type = reply.headers["Content-Type"] ?: "application/octet-stream"
        val mime = type.substringBefore(';').trim()
        val charset = type.substringAfter("charset=", "").trim().ifEmpty { null }
        // WebView writes Content-Type from the mime given here; the map's copy would only repeat it
        val headers = reply.headers.filterKeys { it != "Content-Type" }
        return WebResourceResponse(mime, charset, reply.status, reply.reason, headers, reply.body)
    }

    /** The answer to `method` on stream `id` with the request's `Range` header, if any. Blocks while the answer's first piece comes. */
    fun answer(method: String, id: String, range: String?): Reply {
        val s = synchronized(lock) { streams[id] ?: gone[id] } ?: return text(404, "Not Found", "no such stream")
        s.requests.incrementAndGet()
        if (method != "GET" && method != "HEAD") return text(405, "Method Not Allowed", "only GET and HEAD are answered", mapOf("Allow" to "GET, HEAD"))
        if (s.closed) return text(410, "Gone", "the stream closed")
        if (s.size == 0L) return Reply(200, "OK", common(s.mime, 0L), TextBody(ByteArray(0)))
        val span = MediaRange.answer(range, s.size, pieceSize.toLong())
            ?: return Reply(416, "Range Not Satisfiable", common("text/plain; charset=utf-8", 0L) + ("Content-Range" to "bytes */${s.size}"), TextBody(ByteArray(0)))
        val headers = common(s.mime, span.last - span.first + 1) + ("Content-Range" to "bytes ${span.first}-${span.last}/${s.size}")
        val hint = MediaRange.seekHint(range, span)
        if (method == "HEAD") return Reply(206, "Partial Content", headers, TextBody(ByteArray(0), hint))
        val first = span.first / pieceSize
        val last = span.last / pieceSize
        val sources: List<Source>
        val toSend: List<Need>
        synchronized(lock) {
            if (s.closed) return text(410, "Gone", "the stream closed")
            sources = (first..last).map { sourceOf(s, it) }
            ahead(s, last + 1, minOf(last + READAHEAD, pieces(s) - 1))
            toSend = pump(s)
        }
        send(toSend)
        val head = when (val o = resolve(s, first, sources[0])) {
            is Outcome.Data -> o.bytes
            is Outcome.Failed -> return text(502, "Bad Gateway", o.message)
            Outcome.TimedOut -> return text(504, "Gateway Timeout", "the piece did not come in time")
            Outcome.Closed -> return text(410, "Gone", "the stream closed")
        }
        val rest = sources.getOrNull(1)?.let { src -> { bytesOf(s, last, src) } }
        return Reply(206, "Partial Content", headers, RangeBody(span.first, span.last, pieceSize, head, first, rest, hint))
    }

    // --- pieces ---------------------------------------------------------------------------------

    private fun pieces(s: Stream): Long = (s.size + pieceSize - 1) / pieceSize

    private fun lengthOf(s: Stream, index: Long): Int = minOf(pieceSize.toLong(), s.size - index * pieceSize).toInt()

    /** Where piece `index` of an answer comes from; under the lock. */
    private fun sourceOf(s: Stream, index: Long): Source {
        memory.get(s.hex, index)?.let {
            s.cached.incrementAndGet()
            return Source.Ready(it)
        }
        if (s.keep && disk.has(s.hex, index)) return Source.OnDisk(index)
        return Source.Pending(needFor(s, index, wanted = true))
    }

    /** The piece, from where it is, waiting for it if it is with the page. */
    private fun resolve(s: Stream, index: Long, src: Source): Outcome {
        val need = when (src) {
            is Source.Ready -> return Outcome.Data(src.bytes)
            is Source.Pending -> src.need
            is Source.OnDisk -> {
                disk.read(s.hex, index)?.let {
                    memory.put(s.hex, index, it)
                    s.cached.incrementAndGet()
                    return Outcome.Data(it)
                }
                // the disk lost it meanwhile: ask the page after all
                val toSend: List<Need>
                val n: Need
                synchronized(lock) {
                    if (s.closed) return Outcome.Closed
                    n = needFor(s, index, wanted = true)
                    toSend = pump(s)
                }
                send(toSend)
                n
            }
        }
        // a need is settled within the timeout once sent; this bounds the wait for a slot too
        if (!need.done.await(needTimeoutMs * 3, TimeUnit.MILLISECONDS)) return Outcome.TimedOut
        return synchronized(lock) { need.outcome } ?: Outcome.TimedOut
    }

    /** The bytes of an answer's second piece, for its body: what went wrong fails the read. */
    private fun bytesOf(s: Stream, index: Long, src: Source): ByteArray =
        when (val o = resolve(s, index, src)) {
            is Outcome.Data -> o.bytes
            is Outcome.Failed -> throw IOException(o.message)
            Outcome.TimedOut -> throw IOException("the piece did not come in time")
            Outcome.Closed -> throw IOException("the stream closed")
        }

    /** The need for piece `index`, made unless one is pending; under the lock. One a request waits on goes before readahead. */
    private fun needFor(s: Stream, index: Long, wanted: Boolean): Need {
        s.needs[index]?.let {
            if (wanted) it.wanted = true
            return it
        }
        val n = Need(nextReq++, s, index, lengthOf(s, index), wanted)
        s.needs[index] = n
        s.queue.add(n)
        return n
    }

    /** Pieces `from`..`to` cached or being fetched; readahead queued for an earlier answer and not sent yet is dropped. Under the lock. */
    private fun ahead(s: Stream, from: Long, to: Long) {
        val queued = s.queue.iterator()
        while (queued.hasNext()) {
            val n = queued.next()
            if (!n.wanted && n.index !in from..to) {
                queued.remove()
                s.needs.remove(n.index)
            }
        }
        for (index in from..to) {
            if (s.needs.containsKey(index) || memory.has(s.hex, index) || (s.keep && disk.has(s.hex, index))) continue
            needFor(s, index, wanted = false)
        }
    }

    /** Takes needs off the queue while the stream has slots, wanted ones first; under the lock. The caller sends them. */
    private fun pump(s: Stream): List<Need> {
        val out = ArrayList<Need>()
        while (s.inFlight < MAX_IN_FLIGHT && s.queue.isNotEmpty()) {
            val n = s.queue.firstOrNull { it.wanted } ?: s.queue.first()
            s.queue.remove(n)
            n.sent = true
            s.inFlight++
            byReq[n.req] = n
            n.timer = try {
                timer.schedule(Runnable { complete(n, Outcome.TimedOut) }, needTimeoutMs, TimeUnit.MILLISECONDS)
            } catch (e: RejectedExecutionException) {
                null
            }
            out.add(n)
        }
        return out
    }

    private fun send(list: List<Need>) {
        for (n in list) {
            try {
                needs.need(n.req, n.stream.id, n.index, n.index * pieceSize, n.len.toLong())
            } catch (e: Exception) {
                complete(n, Outcome.Failed("the page could not be asked: ${e.message ?: e.javaClass.simpleName}"))
            }
        }
    }

    /** Settles a need once: its piece is kept, its waiters wake, and its slot goes to the next. */
    private fun complete(n: Need, outcome: Outcome) {
        val next: List<Need>
        synchronized(lock) {
            if (n.outcome != null) return
            val s = n.stream
            // kept before the need is gone, so a request coming between finds one or the other
            if (outcome is Outcome.Data) {
                memory.put(s.hex, n.index, outcome.bytes)
                if (s.keep) keep(s.hex, n.index, outcome.bytes)
                s.fetched.incrementAndGet()
            }
            settle(n, outcome)
            if (s.needs[n.index] === n) s.needs.remove(n.index)
            if (n.sent) s.inFlight-- else s.queue.remove(n)
            next = if (s.closed) emptyList() else pump(s)
        }
        n.done.countDown()
        send(next)
    }

    /** Marks a need settled; under the lock. The caller wakes its waiters. */
    private fun settle(n: Need, outcome: Outcome) {
        n.outcome = outcome
        n.timer?.cancel(false)
        byReq.remove(n.req)
    }

    private fun keep(hex: String, index: Long, bytes: ByteArray) {
        try {
            writer.execute { disk.write(hex, index, bytes) }
        } catch (e: RejectedExecutionException) {
            // shutting down: the piece stays unkept
        }
    }

    private fun text(status: Int, reason: String, message: String, extra: Map<String, String> = emptyMap()): Reply {
        val bytes = message.toByteArray(Charsets.UTF_8)
        return Reply(status, reason, common("text/plain; charset=utf-8", bytes.size.toLong()) + extra, TextBody(bytes))
    }

    private fun common(type: String, length: Long): Map<String, String> = linkedMapOf(
        "Content-Type" to type,
        "Content-Length" to length.toString(),
        "Accept-Ranges" to "bytes",
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff",
    )

    companion object {
        /** A piece: the daemon's `WHOLE_CHUNK`, which the page reads a file in. */
        const val PIECE = 1572864
        /** The disk cache's cap, counted as the pieces present. */
        const val DISK_CAP = 1L shl 30
        /** Pieces kept in memory across every stream: about 24 MiB. */
        const val MEMORY_PIECES = 16
        /** How long a need waits for its piece once the page is asked. */
        const val NEED_TIMEOUT_MS = 60_000L
        /** Needs a stream may have with the page at once. */
        const val MAX_IN_FLIGHT = 4
        /** Pieces asked for ahead of an answer. */
        const val READAHEAD = 3
        /** Where the player's URLs are, under the page's own host: `/_cophyla_media/<id>/<name>`. */
        const val PREFIX = "/_cophyla_media/"
        private const val KEY_MAX = 4096
        private const val ERROR_MAX = 300
        private const val GONE_KEPT = 64
        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val MIME = Regex("^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*( *;[\\x20-\\x7e]*)?$")

        /** The stream id a URL's path names, or null when it names none. */
        fun idOf(path: String): String? {
            if (!path.startsWith(PREFIX)) return null
            val id = path.substring(PREFIX.length).substringBefore('/')
            return if (ID.matches(id)) id else null
        }

        /** The cache's name for a key: its SHA-256, in hex. */
        fun sha256(text: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            val out = StringBuilder(digest.size * 2)
            for (b in digest) {
                val v = b.toInt() and 0xff
                out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
            }
            return out.toString()
        }

        private const val HEX = "0123456789abcdef"

        private fun daemon(name: String) = ThreadFactory { r -> Thread(r, name).apply { isDaemon = true } }
    }
}

/** Reading a `Range` header and bounding the answer to it, as the contract with the page says. */
object MediaRange {
    /** The bytes one answer carries, `first` to `last`, both inclusive. */
    data class Span(val first: Long, val last: Long)

    /** A header's first range as asked: `first-last`, `first-` (no `last`) or `-suffix`; `single` when it was the only one. */
    private class Asked(val first: Long, val last: Long?, val suffix: Long?, val single: Boolean)

    /**
     * The span to answer for `header` on a file of `size` bytes (more than 0) in pieces of
     * `piece`, or null for 416. No header, or one that cannot be read, is `bytes=0-`; several
     * ranges are the first. The span ends at the asked end, the end of the piece after the one
     * holding its start, or the file's end, whichever comes first.
     */
    fun answer(header: String?, size: Long, piece: Long): Span? {
        require(size > 0)
        val asked = parse(header)
        val first: Long
        val wantLast: Long
        when {
            asked == null -> {
                first = 0
                wantLast = size - 1
            }
            asked.suffix != null -> {
                if (asked.suffix == 0L) return null
                first = maxOf(0L, size - asked.suffix)
                wantLast = size - 1
            }
            else -> {
                first = asked.first
                wantLast = asked.last ?: (size - 1)
            }
        }
        if (first >= size) return null
        val bound = (first / piece + 2) * piece - 1
        return Span(first, minOf(wantLast, bound, size - 1))
    }

    /**
     * What a body's first `available()` should say so that WebView, applying the request's range
     * to the body itself, makes its own Content-Length the span's: the span's end + 1, which it
     * reads as the stream's size. Only where WebView reads the header as this does (none, or one
     * `first-[last]` range) and the number fits an int; else 0, which makes WebView skip its check.
     */
    fun seekHint(header: String?, span: Span): Int {
        if (header != null) {
            val asked = parse(header) ?: return 0
            if (!asked.single || asked.suffix != null) return 0
        }
        val end = span.last + 1
        return if (end <= Int.MAX_VALUE) end.toInt() else 0
    }

    private fun parse(header: String?): Asked? {
        if (header == null) return null
        val eq = header.indexOf('=')
        if (eq < 0 || !header.substring(0, eq).trim().equals("bytes", ignoreCase = true)) return null
        val specs = header.substring(eq + 1).split(',').map { it.trim() }.filter { it.isNotEmpty() }
        val spec = specs.firstOrNull() ?: return null
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val a = spec.substring(0, dash).trim()
        val b = spec.substring(dash + 1).trim()
        if (a.isEmpty()) return Asked(-1, null, digits(b) ?: return null, specs.size == 1)
        val first = digits(a) ?: return null
        val last = if (b.isEmpty()) null else (digits(b) ?: return null)
        if (last != null && last < first) return null
        return Asked(first, last, null, specs.size == 1)
    }

    private fun digits(s: String): Long? = if (s.isNotEmpty() && s.all { it in '0'..'9' }) s.toLongOrNull() else null
}

/** The most recent pieces, across every stream, by the file's hash and the piece's index. */
class MemoryPieces(private val capacity: Int) {
    private data class Key(val hex: String, val index: Long)

    private val map = object : LinkedHashMap<Key, ByteArray>(capacity + 1, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Key, ByteArray>?): Boolean = size > capacity
    }

    /** The piece, which counts as used now. */
    @Synchronized
    fun get(hex: String, index: Long): ByteArray? = map[Key(hex, index)]

    /** Whether the piece is here, without counting as a use. */
    @Synchronized
    fun has(hex: String, index: Long): Boolean = map.containsKey(Key(hex, index))

    /** Keeps the piece, the least recently used one going past the capacity. */
    @Synchronized
    fun put(hex: String, index: Long, bytes: ByteArray) {
        map[Key(hex, index)] = bytes
    }

    /** Pieces held now. */
    val size: Int
        @Synchronized get() = map.size
}

/**
 * The pieces of files on other machines, on disk: per file (by its key's hash) a `.data` file
 * written sparse at each piece's offset and a `.map` of which pieces are there, made for the
 * file's size and the piece size; a map that does not fit them is thrown away with its data.
 * A piece's data is written and synced before the map marks it, so a crash leaves a piece
 * missing, never wrong. Past the cap (the present pieces' lengths together) the files least
 * recently opened or read go first, whole, never one open now; when only open ones are left,
 * the piece is not kept. The maps' modified times carry the order across runs of the app.
 */
class MediaCache(
    private val dir: File,
    private val cap: Long,
    private val pieceSize: Int,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Entry(val hex: String, val size: Long, val map: ByteArray) {
        var bytes = 0L
        var used = 0L
        var opens = 0
    }

    private val entries = HashMap<String, Entry>()
    /** The present pieces' lengths, with the writes under way. */
    private var total = 0L
    private var scanned = false

    /** Bytes counted against the cap now. */
    val bytes: Long
        @Synchronized get() {
            scan()
            return total
        }

    /** A file is open: its map is read, or made afresh when it does not fit `size`. */
    @Synchronized
    fun open(hex: String, size: Long) {
        scan()
        var e = entries[hex]
        if (e != null && e.size != size) {
            val opens = e.opens
            drop(e)
            e = Entry(hex, size, ByteArray(count(size)))
            e.opens = opens
            entries[hex] = e
        }
        if (e == null) {
            e = Entry(hex, size, ByteArray(count(size)))
            entries[hex] = e
        }
        e.opens++
        e.used = now()
        touch(e)
    }

    /** A file is closed; its pieces stay. */
    @Synchronized
    fun close(hex: String) {
        val e = entries[hex] ?: return
        if (e.opens > 0) e.opens--
        e.used = now()
        if (e.bytes == 0L && e.opens == 0) entries.remove(hex) else touch(e)
    }

    /** Whether piece `index` of the file is on disk. */
    @Synchronized
    fun has(hex: String, index: Long): Boolean {
        val e = entries[hex] ?: return false
        return index >= 0 && index < e.map.size && e.map[index.toInt()] == PRESENT
    }

    /** Pieces of the file on disk. */
    @Synchronized
    fun present(hex: String): Int = entries[hex]?.map?.count { it == PRESENT } ?: 0

    /** Piece `index` of the file, or null when it is not on disk (or could not be read, when the file's pieces are dropped). */
    fun read(hex: String, index: Long): ByteArray? {
        val e: Entry
        val at: Long
        val len: Int
        synchronized(this) {
            scan()
            e = entries[hex] ?: return null
            if (index < 0 || index >= e.map.size || e.map[index.toInt()] != PRESENT) return null
            e.used = now()
            at = index * pieceSize
            len = lengthOf(e.size, index)
        }
        return try {
            RandomAccessFile(dataFile(hex), "r").use { f ->
                if (f.length() < at + len) throw IOException("the data is short")
                ByteArray(len).also {
                    f.seek(at)
                    f.readFully(it)
                }
            }
        } catch (ex: IOException) {
            synchronized(this) { if (entries[hex] === e) reset(e) }
            null
        }
    }

    /** Keeps piece `index` of an open file, unless it is there already or no room can be made for it. */
    fun write(hex: String, index: Long, piece: ByteArray) {
        val e: Entry
        synchronized(this) {
            scan()
            var entry = entries[hex] ?: return
            if (index < 0 || index >= entry.map.size || entry.map[index.toInt()] == PRESENT) return
            if (piece.size != lengthOf(entry.size, index)) return
            // the system may clear a cache folder: a map whose data went would mark holes present
            if (entry.bytes > 0 && !dataFile(hex).exists()) entry = reset(entry)
            if (!room(piece.size.toLong(), hex)) return
            total += piece.size
            e = entry
        }
        val written = try {
            RandomAccessFile(dataFile(hex), "rw").use { f ->
                f.seek(index * pieceSize)
                f.write(piece)
                f.fd.sync()
            }
            true
        } catch (ex: IOException) {
            false
        }
        synchronized(this) {
            if (!written || entries[hex] !== e || e.map[index.toInt()] == PRESENT) {
                total -= piece.size
                return
            }
            e.map[index.toInt()] = PRESENT
            e.bytes += piece.size
            e.used = now()
            saveMap(e)
        }
    }

    /** Makes room for `len` more bytes by dropping closed files, least recently used first; false when it cannot. */
    private fun room(len: Long, hex: String): Boolean {
        if (len > cap) return false
        while (total + len > cap) {
            val victim = entries.values.filter { it.opens == 0 && it.hex != hex && it.bytes > 0 }.minByOrNull { it.used } ?: return false
            drop(victim)
        }
        return true
    }

    /** Forgets a file and deletes its pieces. */
    private fun drop(e: Entry) {
        dataFile(e.hex).delete()
        mapFile(e.hex).delete()
        total -= e.bytes
        entries.remove(e.hex)
    }

    /** Drops a file's pieces but keeps it, open as it was. */
    private fun reset(e: Entry): Entry {
        drop(e)
        val fresh = Entry(e.hex, e.size, ByteArray(e.map.size))
        fresh.opens = e.opens
        fresh.used = now()
        entries[e.hex] = fresh
        return fresh
    }

    /** Reads the folder once: every map that fits, with its data; the rest is deleted. */
    private fun scan() {
        if (scanned) return
        scanned = true
        dir.mkdirs()
        val files = dir.listFiles() ?: return
        val kept = HashSet<String>()
        for (f in files) {
            val name = f.name
            if (name.endsWith(TMP)) {
                f.delete()
                continue
            }
            if (!name.endsWith(MAP)) continue
            val hex = name.removeSuffix(MAP)
            if (!HASH.matches(hex)) continue
            val e = load(hex, f)
            if (e == null || !dataFile(hex).exists()) {
                f.delete()
                continue
            }
            entries[hex] = e
            total += e.bytes
            kept.add(hex)
        }
        for (f in files) {
            val name = f.name
            if (name.endsWith(DATA) && HASH.matches(name.removeSuffix(DATA)) && name.removeSuffix(DATA) !in kept) f.delete()
        }
    }

    /** A map as written by `saveMap`, or null when it is not one for this piece size. */
    private fun load(hex: String, f: File): Entry? {
        val raw = try {
            f.readBytes()
        } catch (e: IOException) {
            return null
        }
        if (raw.size < HEADER) return null
        for (i in MAGIC.indices) if (raw[i] != MAGIC[i]) return null
        val piece = readInt(raw, 4)
        val size = readLong(raw, 8)
        if (piece != pieceSize || size < 0 || (size + pieceSize - 1) / pieceSize > Int.MAX_VALUE) return null
        val n = count(size)
        if (raw.size != HEADER + n) return null
        val map = raw.copyOfRange(HEADER, raw.size)
        var bytes = 0L
        for (i in 0 until n) {
            when (map[i]) {
                PRESENT -> bytes += lengthOf(size, i.toLong())
                ABSENT -> {}
                else -> return null
            }
        }
        return Entry(hex, size, map).also {
            it.bytes = bytes
            it.used = f.lastModified()
        }
    }

    /** Writes a file's map whole, by a rename, so a reader finds the old map or the new one. */
    private fun saveMap(e: Entry) {
        val tmp = File(dir, e.hex + TMP)
        val target = mapFile(e.hex)
        try {
            DataOutputStream(FileOutputStream(tmp).buffered()).use { out ->
                out.write(MAGIC)
                out.writeInt(pieceSize)
                out.writeLong(e.size)
                out.write(e.map)
            }
            // a rename over a file replaces it on Android; the JVM on Windows wants it gone first
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) tmp.delete()
            }
            touch(e)
        } catch (ex: IOException) {
            tmp.delete()
        }
    }

    /** The map's modified time is the file's last use, for the order across runs. */
    private fun touch(e: Entry) {
        val f = mapFile(e.hex)
        if (f.exists()) f.setLastModified(e.used)
    }

    private fun count(size: Long): Int = ((size + pieceSize - 1) / pieceSize).toInt()

    private fun lengthOf(size: Long, index: Long): Int = minOf(pieceSize.toLong(), size - index * pieceSize).toInt()

    private fun dataFile(hex: String) = File(dir, hex + DATA)

    private fun mapFile(hex: String) = File(dir, hex + MAP)

    private fun readInt(b: ByteArray, at: Int): Int {
        var v = 0
        for (i in 0 until 4) v = (v shl 8) or (b[at + i].toInt() and 0xff)
        return v
    }

    private fun readLong(b: ByteArray, at: Int): Long {
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (b[at + i].toLong() and 0xff)
        return v
    }

    companion object {
        private const val DATA = ".data"
        private const val MAP = ".map"
        private const val TMP = ".map.tmp"
        private const val PRESENT: Byte = 1
        private const val ABSENT: Byte = 0
        /** "CMM1", the piece size (4 bytes) and the file's size (8 bytes), then a byte per piece. */
        private val MAGIC = byteArrayOf('C'.code.toByte(), 'M'.code.toByte(), 'M'.code.toByte(), '1'.code.toByte())
        private const val HEADER = 16
        private val HASH = Regex("^[0-9a-f]{64}$")
    }
}

/**
 * A response body as WebView reads it. WebView applies the request's range to the body itself:
 * it asks `available()` once and takes it for the stream's size, then skips the range's first
 * bytes, then reads. Those skips (up to `ahead` bytes, before any read) are acknowledged and drop
 * nothing, since the body starts at the range's first byte already; each is at most 1 GiB, which
 * WebView keeps in an int. The first `available()` says `hint` (MediaRange.seekHint); later ones
 * say what can be read without waiting.
 */
abstract class EngineBody(private val ahead: Long, private val hint: Int) : InputStream() {
    @Volatile private var hinted = false
    @Volatile private var started = false
    @Volatile private var skipped = 0L

    /** Reads up to `len` bytes, waiting for them if need be: at least one, or -1 at the end. */
    protected abstract fun take(b: ByteArray, off: Int, len: Int): Int

    /** Bytes that can be read now without waiting. */
    protected abstract fun ready(): Int

    /** Skips up to `n` bytes of the body itself. */
    protected abstract fun pass(n: Long): Long

    override fun read(): Int {
        val one = ByteArray(1)
        val n = read(one, 0, 1)
        return if (n <= 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (off < 0 || len < 0 || len > b.size - off) throw IndexOutOfBoundsException()
        started = true
        return take(b, off, len)
    }

    override fun available(): Int {
        if (!hinted && !started && skipped == 0L) {
            hinted = true
            return hint
        }
        return ready()
    }

    override fun skip(n: Long): Long {
        if (n <= 0) return 0
        if (!started && skipped < ahead) {
            val k = minOf(n, ahead - skipped, SKIP_STEP)
            skipped += k
            return k
        }
        started = true
        return pass(n)
    }

    companion object {
        /** The most one skip says it skipped: WebView keeps the count in an int. */
        const val SKIP_STEP = 1L shl 30
    }
}

/** A body held whole: an error's text, or nothing. */
class TextBody(private val bytes: ByteArray, hint: Int = 0) : EngineBody(Long.MAX_VALUE, hint) {
    @Volatile private var pos = 0

    override fun take(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (pos >= bytes.size) return -1
        val n = minOf(len, bytes.size - pos)
        System.arraycopy(bytes, pos, b, off, n)
        pos += n
        return n
    }

    override fun ready(): Int = bytes.size - pos

    override fun pass(n: Long): Long {
        val k = minOf(n, (bytes.size - pos).toLong()).toInt()
        pos += k
        return k.toLong()
    }
}

/**
 * The body of a 206: bytes `first`..`last` of the file, from its first piece (in hand) and, when
 * the span reaches into the next, that piece, which `rest` waits for; a piece that does not come
 * fails the read, so the body never yields other than its Content-Length.
 */
class RangeBody(
    private val first: Long,
    private val last: Long,
    private val pieceSize: Int,
    head: ByteArray,
    headIndex: Long,
    private val rest: (() -> ByteArray)?,
    hint: Int,
) : EngineBody(first, hint) {
    @Volatile private var pos = first
    @Volatile private var piece = head
    @Volatile private var index = headIndex

    override fun take(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (pos > last) return -1
        val at = pos / pieceSize
        if (at != index) {
            piece = (rest ?: throw IOException("piece $at is not part of this answer")).invoke()
            index = at
        }
        val inPiece = (pos - at * pieceSize).toInt()
        val n = minOf(len.toLong(), last - pos + 1, (piece.size - inPiece).toLong()).toInt()
        if (n <= 0) throw IOException("piece $at is short")
        System.arraycopy(piece, inPiece, b, off, n)
        pos += n
        return n
    }

    override fun ready(): Int {
        if (pos > last || pos / pieceSize != index) return 0
        return minOf(last - pos + 1, piece.size - (pos - index * pieceSize)).toInt()
    }

    override fun pass(n: Long): Long {
        val k = minOf(n, last - pos + 1).coerceAtLeast(0L)
        pos += k
        return k
    }
}
