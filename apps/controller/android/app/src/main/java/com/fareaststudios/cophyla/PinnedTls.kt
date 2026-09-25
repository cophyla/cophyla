// The trust every socket to the node shares: one self-signed leaf, trusted by the SPKI hash
// of its key rather than by a certificate authority. At pairing (no pin) any self-signed leaf
// is accepted and its hash is kept for the page; from then on a leaf whose key differs is
// refused with `pin_mismatch`, never accepted on the quiet. The LAN socket and the stream
// forwarder both open their TLS through here.
package com.fareaststudios.cophyla

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** Trusts one self-signed leaf: any when `pin` is null (pairing), the pinned key otherwise. */
class LeafTrust(private val pin: String?) : X509TrustManager {
    @Volatile var seenSpki: String? = null

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("not a server")

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
        val spki = PinnedTls.spkiHash(leaf)
        seenSpki = spki
        if (pin != null && pin != spki) throw CertificateException(PinnedTls.PIN_MISMATCH)
        try {
            leaf.checkValidity()
        } catch (e: Exception) {
            throw CertificateException("the node's certificate is not valid now")
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

object PinnedTls {
    const val PIN_MISMATCH = "pin_mismatch"

    /** A TLS context that trusts what `trust` does and nothing else. */
    fun context(trust: LeafTrust): SSLContext {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        return context
    }

    /** SHA-256 of the certificate's SubjectPublicKeyInfo, base64: the same hash the node logs at pairing. */
    fun spkiHash(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    /** Whether a failure came from a pin that did not match, however deep the TLS stack wrapped it. */
    fun isPinMismatch(t: Throwable): Boolean {
        var cause: Throwable? = t
        while (cause != null) {
            if (cause is CertificateException && cause.message == PIN_MISMATCH) return true
            cause = cause.cause
        }
        return false
    }
}
