package expo.modules.guardianprotection.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class EncryptedDohTransportTest {
  @Test
  fun acceptsOnlyHttpsPostEndpointsWithoutQueryOrCredentials() {
    val endpoint = DohEndpoint.parse("https://resolver.example/dns-query")

    requireNotNull(endpoint)
    assertEquals("resolver.example", endpoint.host)
    assertEquals(443, endpoint.port)
    assertEquals("/dns-query", endpoint.requestPath)
    assertNull(DohEndpoint.parse("http://resolver.example/dns-query"))
    assertNull(DohEndpoint.parse("https://resolver.example/dns-query?dns=raw"))
    assertNull(DohEndpoint.parse("https://token@resolver.example/dns-query"))
    assertNull(DohEndpoint.parse("https://resolver.example/dns-query#fragment"))
  }

  @Test
  fun bootstrapResolvesOnceBeforeTheTunnelAndDoesNotNeedAPlaintextDnsUpstream() {
    val endpoint = requireNotNull(DohEndpoint.parse("https://resolver.example/dns-query"))
    var resolvedHost: String? = null
    val transport = EncryptedDohTransport.bootstrap(endpoint, { true }) { host ->
      resolvedHost = host
      arrayOf(InetAddress.getByAddress(byteArrayOf(203.toByte(), 0, 113, 9)))
    }

    assertEquals("resolver.example", resolvedHost)
    assertNotNull(transport)
  }

  @Test
  fun serializesHttpHeadersWithActualCrLfBytesAndNoUrlDnsParameter() {
    val endpoint = requireNotNull(DohEndpoint.parse("https://resolver.example/dns-query"))
    val headers = DohHttpRequest.headers(endpoint, 17)
    val text = headers.toString(Charsets.US_ASCII)

    assertTrue(text.contains("\r\n"))
    assertFalse(text.contains("\\r\\n"))
    assertTrue(headers.any { it == '\r'.code.toByte() })
    assertTrue(headers.any { it == '\n'.code.toByte() })
    assertFalse(text.contains("?dns="))
  }

  @Test
  fun protectsABoundSocketSoTheVpnCanExcludeItsDescriptor() {
    val endpoint = requireNotNull(DohEndpoint.parse("https://resolver.example/dns-query"))
    var protectedSocketWasBound: Boolean? = null
    val transport = EncryptedDohTransport(
      endpoint,
      listOf(InetAddress.getLoopbackAddress()),
      protectSocket = { socket ->
        protectedSocketWasBound = socket.isBound
        false
      },
    )

    assertNull(transport.query(byteArrayOf(0, 1)))
    assertEquals(true, protectedSocketWasBound)
  }
}
