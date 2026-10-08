package expo.modules.guardianprotection.vpn

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.InetAddress
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** A configured HTTPS DoH endpoint. Query strings, credentials and fragments are rejected. */
internal data class DohEndpoint(
  val host: String,
  val port: Int,
  val requestPath: String,
) {
  companion object {
    fun parse(value: String?): DohEndpoint? {
      val uri = runCatching { URI(value?.trim().orEmpty()) }.getOrNull() ?: return null
      val host = uri.host ?: return null
      val port = if (uri.port == -1) HTTPS_PORT else uri.port
      if (!uri.scheme.equals("https", ignoreCase = true) || host.isBlank() ||
        port !in 1..65535 || uri.rawQuery != null || uri.userInfo != null || uri.fragment != null
      ) return null
      return DohEndpoint(host, port, uri.rawPath?.takeIf(String::isNotBlank) ?: DEFAULT_PATH)
    }

    private const val HTTPS_PORT = 443
    private const val DEFAULT_PATH = "/dns-query"
  }
}

/**
 * DNS-over-HTTPS transport for the VPN. It is deliberately a POST-only byte transport:
 * the DNS message is sent to the configured resolver over TLS, never in a URL or to
 * Guardian's backend. The socket is protected before connecting so it does not loop into
 * the VPN tunnel.
 */
internal class EncryptedDohTransport(
  private val endpoint: DohEndpoint,
  private val bootstrapAddresses: List<InetAddress>,
  private val protectSocket: (Socket) -> Boolean,
  private val socketFactory: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
) {
  fun query(dnsMessage: ByteArray): ByteArray? {
    require(dnsMessage.isNotEmpty() && dnsMessage.size <= MAX_DNS_MESSAGE_BYTES)
    return bootstrapAddresses.firstNotNullOfOrNull { address -> query(address, dnsMessage) }
  }

  private fun query(address: InetAddress, dnsMessage: ByteArray): ByteArray? = runCatching {
    val rawSocket = Socket()
    try {
      check(protectSocket(rawSocket))
      rawSocket.soTimeout = TIMEOUT_MILLIS
      rawSocket.connect(InetSocketAddress(address, endpoint.port), TIMEOUT_MILLIS)
      (socketFactory.createSocket(rawSocket, endpoint.host, endpoint.port, true) as SSLSocket).use { socket ->
        socket.sslParameters = socket.sslParameters.apply {
          endpointIdentificationAlgorithm = "HTTPS"
          if (endpoint.host.any { it.isLetter() }) serverNames = listOf(SNIHostName(endpoint.host))
        }
        socket.startHandshake()
        socket.outputStream.buffered().let { output ->
          output.write(DohHttpRequest.headers(endpoint, dnsMessage.size))
          output.write(dnsMessage)
          output.flush()
        }
        readResponse(socket.inputStream)
      }
    } finally {
      rawSocket.close()
    }
  }.getOrNull()

  private fun readResponse(input: InputStream): ByteArray? {
    val status = readHeaderLine(input) ?: return null
    if (!status.startsWith("HTTP/") || !status.split(' ').getOrNull(1).equals("200")) return null
    val headers = linkedMapOf<String, String>()
    while (true) {
      val line = readHeaderLine(input) ?: return null
      if (line.isEmpty()) break
      val separator = line.indexOf(':')
      if (separator <= 0) return null
      headers[line.substring(0, separator).lowercase()] = line.substring(separator + 1).trim()
    }
    if (!headers["content-type"].orEmpty().lowercase().startsWith("application/dns-message")) return null
    val length = headers["content-length"]?.toIntOrNull()?.takeIf { it in 1..MAX_DNS_MESSAGE_BYTES } ?: return null
    return readExactly(input, length)
  }

  private fun readHeaderLine(input: InputStream): String? {
    val result = ByteArrayOutputStream()
    repeat(MAX_HEADER_LINE_BYTES) {
      val value = input.read()
      if (value < 0) return null
      if (value == '\n'.code) return result.toByteArray().toString(Charsets.US_ASCII).trimEnd('\r')
      result.write(value)
    }
    return null
  }

  private fun readExactly(input: InputStream, length: Int): ByteArray? {
    val result = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val read = input.read(result, offset, length - offset)
      if (read <= 0) return null
      offset += read
    }
    return result
  }

  companion object {
    /** Resolve before the TUN is established; resolution failure means no DNS interception starts. */
    fun bootstrap(
      endpoint: DohEndpoint,
      protectSocket: (Socket) -> Boolean,
      resolver: (String) -> Array<InetAddress> = InetAddress::getAllByName,
    ): EncryptedDohTransport? {
      val addresses = runCatching { resolveOffCallerThread { resolver(endpoint.host).toList() } }
        .getOrDefault(emptyList())
      return addresses.takeIf { it.isNotEmpty() }?.let { EncryptedDohTransport(endpoint, it, protectSocket) }
    }

    /** Android forbids DNS lookups on the main thread, where services receive start commands. */
    private fun <T> resolveOffCallerThread(lookup: () -> T): T {
      val executor = Executors.newSingleThreadExecutor()
      try {
        return executor.submit(lookup).get(RESOLVE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
      } finally {
        executor.shutdownNow()
      }
    }

    private const val RESOLVE_TIMEOUT_MILLIS = 5_000L
    const val TIMEOUT_MILLIS = 2_000
    const val MAX_DNS_MESSAGE_BYTES = 4_096
    const val MAX_HEADER_LINE_BYTES = 8_192
  }
}

internal object DohHttpRequest {
  fun headers(endpoint: DohEndpoint, contentLength: Int): ByteArray = buildString {
    val host = if (endpoint.port == 443) endpoint.host else "${endpoint.host}:${endpoint.port}"
    append("POST ${endpoint.requestPath} HTTP/1.1\r\n")
    append("Host: $host\r\n")
    append("Content-Type: application/dns-message\r\n")
    append("Accept: application/dns-message\r\n")
    append("Content-Length: $contentLength\r\n")
    append("Connection: close\r\n\r\n")
  }.toByteArray(Charsets.US_ASCII)
}
