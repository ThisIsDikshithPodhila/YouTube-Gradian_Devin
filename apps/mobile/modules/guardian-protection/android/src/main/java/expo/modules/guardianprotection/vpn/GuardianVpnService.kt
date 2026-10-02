package expo.modules.guardianprotection.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import expo.modules.guardianprotection.BuildConfig
import expo.modules.guardianprotection.flow.AndroidFlowAttribution
import expo.modules.guardianprotection.inventory.InventorySource
import expo.modules.guardianprotection.inventory.PackageInventory
import expo.modules.guardianprotection.policy.GuardianPolicyRuntime
import expo.modules.guardianprotection.policy.PolicyManager
import expo.modules.guardianprotection.storage.EncryptedPolicyStore
import expo.modules.guardianprotection.observability.GuardianPerformanceMetrics
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Selective-route VPN. Only DNS servers and destinations already classified as
 * blocked enter the TUN. Ordinary allowed traffic stays on Android's network.
 */
class GuardianVpnService : VpnService() {
  private val stateLock = Any()
  private val running = AtomicBoolean(false)
  private val failureReasons = CopyOnWriteArraySet<String>()
  private val blockedRoutes = BlockedDestinationRoutes(MAX_BLOCKED_DESTINATIONS)
  private val dnsCache = DnsCache()
  private val attribution by lazy { AndroidFlowAttribution(this) }
  private val inventory by lazy { PackageInventory(this) }
  private var interfaceFd: ParcelFileDescriptor? = null
  private var worker: Thread? = null
  private var output: FileOutputStream? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var dnsServers: List<InetAddress> = emptyList()
  private var dohTransport: EncryptedDohTransport? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (running.compareAndSet(false, true)) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification())
      }
      if (VpnService.prepare(this) != null) {
        GuardianVpnPreferences.setEnabled(this, false)
        GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.REVOKED, "VPN_CONSENT_REVOKED")
        fail("VPN_CONSENT_REVOKED")
        stopSelf()
        return START_NOT_STICKY
      }
      val dohEndpoint = DohEndpoint.parse(BuildConfig.GUARDIAN_DOH_URL)
      if (dohEndpoint == null) {
        GuardianVpnPreferences.setEnabled(this, false)
        GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.UNAVAILABLE, "DOH_TRANSPORT_UNAVAILABLE")
        setRunningState(false, "DOH_TRANSPORT_UNAVAILABLE")
        fail("DOH_TRANSPORT_UNAVAILABLE")
        stopSelf()
        return START_NOT_STICKY
      }
      dohTransport = EncryptedDohTransport.bootstrap(dohEndpoint, protectSocket = { socket -> protect(socket) })
      if (dohTransport == null) {
        GuardianVpnPreferences.setEnabled(this, false)
        GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.UNAVAILABLE, "DOH_BOOTSTRAP_UNAVAILABLE")
        setRunningState(false, "DOH_BOOTSTRAP_UNAVAILABLE")
        fail("DOH_BOOTSTRAP_UNAVAILABLE")
        stopSelf()
        return START_NOT_STICKY
      }
      ensurePolicyRuntime()
      registerNetworkCallback()
      dnsServers = currentDnsServers()
      if (!establishInterface()) {
        GuardianVpnPreferences.setEnabled(this, false)
        GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.UNAVAILABLE, "VPN_ESTABLISH_FAILED")
        setRunningState(false, "VPN_ESTABLISH_FAILED")
        fail("VPN_ESTABLISH_FAILED")
        stopSelf()
        return START_NOT_STICKY
      }
      GuardianVpnPreferences.setEnabled(this, true)
      GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.RUNNING)
      setRunningState(true)
      startPacketWorker()
    }
    return START_STICKY
  }

  override fun onRevoke() {
    GuardianVpnPreferences.setEnabled(this, false)
    GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.REVOKED, "VPN_REVOKED")
    fail("VPN_REVOKED")
    stopSelf()
    super.onRevoke()
  }

  override fun onDestroy() {
    running.set(false)
    runningState = false
    networkCallback?.let {
      getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
    }
    networkCallback = null
    worker?.interrupt()
    synchronized(stateLock) {
      output?.close()
      output = null
      interfaceFd?.close()
      interfaceFd = null
    }
    blockedRoutes.clear()
    if (GuardianVpnPreferences.runtimeStatus(this).state == GuardianVpnRuntimeState.RUNNING) {
      GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.STOPPED, "VPN_STOPPED")
    }
    setRunningState(false, GuardianVpnPreferences.runtimeStatus(this).reason ?: "VPN_STOPPED")
    super.onDestroy()
  }

  private fun startPacketWorker() {
    worker = Thread(::runPacketLoop, "guardian-vpn").also { it.start() }
  }

  private fun runPacketLoop() {
    val fd = synchronized(stateLock) { interfaceFd } ?: return
    val input = FileInputStream(fd.fileDescriptor)
    val localOutput = FileOutputStream(fd.fileDescriptor)
    synchronized(stateLock) {
      output = localOutput
    }
    val packet = ByteArray(32767)
    try {
      while (running.get() && synchronized(stateLock) { interfaceFd === fd }) {
        val length = input.read(packet)
        if (length <= 0) continue
        if (blockedRoutes.prune()) restartInterface()
        val ip = PacketCodec.parseIp(packet, length) ?: continue
        when (ip.protocol) {
          UDP -> handleUdp(ip)
          TCP -> handleBlockedTcp(ip)
          else -> Unit
        }
      }
    } catch (_: Exception) {
      if (running.get()) fail("VPN_PACKET_LOOP_FAILED")
    } finally {
      input.close()
      localOutput.close()
      synchronized(stateLock) {
        if (output === localOutput) output = null
      }
    }
  }

  private fun handleUdp(ip: IpPacket) {
    val datagram = PacketCodec.parseUdp(ip.payload) ?: return
    val key = FlowKey(ip, datagram.sourcePort, datagram.destinationPort)
    if (datagram.destinationPort == DNS_PORT) {
      handleDns(ip, datagram, key)
      return
    }
    if (!blockedRoutes.contains(ip.destination)) return
    val domain = dnsCache.domainFor(ip.destination)
    val responsibleApp = attribution.packageNamesForFlow(key.attributionKey()).firstOrNull()
    responsibleApp?.let { inventory.recordObservedPackages(setOf(it), InventorySource.VPN_ATTRIBUTION) }
    if (domain != null) {
      val decision = evaluateDomain(domain, ip.destination.hostAddress)
      if (decision.blocked) reportBlocked(domain, decision, responsibleApp)
    } else if (datagram.destinationPort == QUIC_PORT) {
      failOnce("QUIC_BLOCKED_DESTINATION_UNATTRIBUTED")
    }
  }

  private fun handleBlockedTcp(ip: IpPacket) {
    if (!blockedRoutes.contains(ip.destination)) return
    val segment = PacketCodec.parseTcp(ip.payload) ?: return
    val key = FlowKey(ip, segment.sourcePort, segment.destinationPort)
    val domain = dnsCache.domainFor(ip.destination) ?: return
    val decision = evaluateDomain(domain, ip.destination.hostAddress)
    if (decision.blocked) {
      val responsibleApp = attribution.packageNamesForFlow(key.attributionKey()).firstOrNull()
      responsibleApp?.let { inventory.recordObservedPackages(setOf(it), InventorySource.VPN_ATTRIBUTION) }
      reportBlocked(domain, decision, responsibleApp)
    }
  }

  private fun handleDns(ip: IpPacket, datagram: UdpDatagram, key: FlowKey) {
    val query = DnsMessage.parse(datagram.payload) ?: return
    val responsibleApp = attribution.packageNamesForFlow(key.attributionKey()).firstOrNull()
    responsibleApp?.let { inventory.recordObservedPackages(setOf(it), InventorySource.VPN_ATTRIBUTION) }
    val decision = evaluateDomain(query.domain, ip.destination.hostAddress)
    if (decision.blocked) {
      reportBlocked(query.domain, decision, responsibleApp)
      write(PacketCodec.buildUdp(
        ip,
        ip.destination,
        ip.source,
        datagram.destinationPort,
        datagram.sourcePort,
        query.blockedResponse(),
      ))
      return
    }
    val primaryResponse = dohTransport?.query(datagram.payload)
    if (primaryResponse != null) {
      dnsCache.record(query.domain, primaryResponse)
      write(PacketCodec.buildUdp(
        ip,
        ip.destination,
        ip.source,
        datagram.destinationPort,
        datagram.sourcePort,
        primaryResponse,
      ))
    } else {
      failOnce("DOH_UPSTREAM_UNAVAILABLE")
    }
  }

  private fun write(packet: ByteArray) {
    synchronized(stateLock) {
      runCatching { output?.write(packet) }.onFailure { fail("VPN_OUTPUT_FAILED") }
    }
  }

  private fun reportBlocked(domain: String, decision: GuardianPolicyRuntime.DomainDecision, appRef: String?) {
    GuardianPolicyRuntime.reportBlocked(domain, decision.reasonCode, decision.category, appRef)
  }

  private fun evaluateDomain(domain: String, destinationIp: String?): GuardianPolicyRuntime.DomainDecision {
    val started = System.nanoTime()
    val decision = GuardianPolicyRuntime.evaluateDomain(domain, destinationIp)
    GuardianPerformanceMetrics.recordVpnDecision(System.nanoTime() - started)
    return decision
  }

  private fun fail(reason: String) {
    GuardianPolicyRuntime.reportFailure(reason)
  }

  private fun failOnce(reason: String) {
    if (failureReasons.add(reason)) fail(reason)
  }

  private fun ensurePolicyRuntime() {
    if (GuardianPolicyRuntime.hasActiveSnapshot()) return
    val manager = PolicyManager(
      EncryptedPolicyStore(this),
      BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
    )
    GuardianPolicyRuntime.install(manager)
    if (!GuardianPolicyRuntime.hasActiveSnapshot()) failOnce("POLICY_UNAVAILABLE")
  }

  private fun establishInterface(): Boolean {
    repeat(MAX_INTERFACE_ESTABLISH_ATTEMPTS) { attempt ->
      val builder = Builder()
        .setSession("Guardian protection")
        .setMtu(1500)
        .addAddress("10.0.0.2", 32)
        .addAddress("fd00:0:0:0:0:0:0:2", 128)
      dnsServers.ifEmpty { listOf(InetAddress.getByName("10.0.0.1")) }.forEach { dns ->
        runCatching {
          builder.addDnsServer(dns)
          builder.addRoute(dns, if (dns.address.size == 4) 32 else 128)
        }.onFailure { failOnce("DNS_ROUTE_CONFIGURATION_FAILED") }
      }
      blockedRoutes.addresses().forEach { address ->
        runCatching {
          builder.addRoute(address, if (address.address.size == 4) 32 else 128)
        }.onFailure { failOnce("BLOCKED_ROUTE_CONFIGURATION_FAILED") }
      }
      val established = runCatching { builder.establish() }.getOrNull()
      if (established != null) {
        synchronized(stateLock) {
          interfaceFd?.close()
          interfaceFd = established
        }
        return true
      }
      if (attempt + 1 < MAX_INTERFACE_ESTABLISH_ATTEMPTS) {
        SystemClock.sleep(INTERFACE_ESTABLISH_RETRY_DELAY_MS)
      }
    }
    return false
  }

  private fun restartInterface() {
    if (!running.get()) return
    synchronized(stateLock) {
      running.set(false)
      worker?.interrupt()
      output?.close()
      output = null
      interfaceFd?.close()
      interfaceFd = null
      running.set(true)
      if (establishInterface()) {
        startPacketWorker()
      } else {
        GuardianVpnPreferences.recordRuntimeStatus(this, GuardianVpnRuntimeState.UNAVAILABLE, "VPN_REESTABLISH_FAILED")
        setRunningState(false, "VPN_REESTABLISH_FAILED")
        fail("VPN_REESTABLISH_FAILED")
      }
    }
  }

  private fun setRunningState(active: Boolean, details: String? = null) {
    runningState = active
    ProtectionStatusEvents.emit(active, details)
  }

  private fun currentDnsServers(): List<InetAddress> {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val network = connectivity.activeNetwork ?: return emptyList()
    return connectivity.getLinkProperties(network)?.dnsServers.orEmpty()
  }

  private fun registerNetworkCallback() {
    val manager = getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onLost(network: Network) {
        if (manager.activeNetwork == null) failOnce("NETWORK_UNAVAILABLE")
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        if (linkProperties.dnsServers != dnsServers) {
          dnsServers = linkProperties.dnsServers
          restartInterface()
        }
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
          failOnce("CAPTIVE_PORTAL_OR_UNVALIDATED_NETWORK")
        }
      }
    }
    networkCallback = callback
    manager.registerDefaultNetworkCallback(callback)
    val active = manager.activeNetwork
    val capabilities = active?.let { manager.getNetworkCapabilities(it) }
    if (capabilities == null) failOnce("NETWORK_UNAVAILABLE")
    else if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
      failOnce("CAPTIVE_PORTAL_OR_UNVALIDATED_NETWORK")
    }
  }

  private fun notification(): Notification {
    val channelId = "guardian-protection"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(channelId, "Guardian protection", NotificationManager.IMPORTANCE_LOW),
      )
    }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, channelId)
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setContentTitle("Guardian protection active")
        .setContentText("Web protection is running")
        .setOngoing(true)
        .build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setContentTitle("Guardian protection active")
        .setContentText("Web protection is running")
        .setOngoing(true)
        .build()
    }
  }

  private class FlowKey(
    ip: IpPacket,
    val sourcePort: Int,
    val destinationPort: Int,
  ) {
    private val source = ip.source.hostAddress
    private val destination = ip.destination.hostAddress
    private val protocol = ip.protocol

    override fun equals(other: Any?): Boolean =
      other is FlowKey && source == other.source && destination == other.destination &&
        protocol == other.protocol && sourcePort == other.sourcePort && destinationPort == other.destinationPort

    override fun hashCode(): Int = arrayOf(source, destination, protocol, sourcePort, destinationPort).contentHashCode()

    fun attributionKey(): String = "$protocol|$source:$sourcePort|$destination:$destinationPort|$sourcePort|$destinationPort"
  }

  private class DnsMessage private constructor(
    val domain: String,
    private val original: ByteArray,
    private val questionTypeOffset: Int,
    private val questionType: Int,
  ) {
    fun blockedResponse(): ByteArray {
      val response = original.copyOf()
      response[2] = (response[2].toInt() or 0x80).toByte()
      response[3] = (response[3].toInt() or 0x83).toByte()
      response[6] = 0
      response[7] = 0
      response[8] = 0
      response[9] = 0
      response[10] = 0
      response[11] = 0
      return response
    }

    fun supplementalAddressQueries(): List<ByteArray> {
      val types = when (questionType) {
        1 -> listOf(28)
        28 -> listOf(1)
        else -> listOf(1, 28)
      }
      return types.map { type ->
        original.copyOf().also {
          it[questionTypeOffset] = (type ushr 8).toByte()
          it[questionTypeOffset + 1] = type.toByte()
        }
      }
    }

    companion object {
      fun parse(payload: ByteArray): DnsMessage? {
        if (payload.size < 17) return null
        var cursor = 12
        val labels = mutableListOf<String>()
        while (cursor < payload.size) {
          val length = payload[cursor++].toInt() and 0xff
          if (length == 0) break
          if (length > 63 || cursor + length > payload.size) return null
          labels += payload.copyOfRange(cursor, cursor + length).toString(Charsets.US_ASCII)
          cursor += length
        }
        if (labels.isEmpty()) return null
        if (cursor + 4 > payload.size) return null
        val questionType = ((payload[cursor].toInt() and 0xff) shl 8) or
          (payload[cursor + 1].toInt() and 0xff)
        return DnsMessage(labels.joinToString(".").lowercase(), payload, cursor, questionType)
      }
    }
  }

  companion object {
    private const val NOTIFICATION_ID = 2101
    private const val DNS_PORT = 53
    private const val QUIC_PORT = 443
    private const val UDP = 17
    private const val TCP = 6
    private const val MAX_BLOCKED_DESTINATIONS = 1024
    private const val MAX_INTERFACE_ESTABLISH_ATTEMPTS = 4
    private const val INTERFACE_ESTABLISH_RETRY_DELAY_MS = 250L
    @Volatile private var runningState = false

    fun isRunning(): Boolean = runningState

    fun start(context: Context) {
      val intent = Intent(context, GuardianVpnService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) {
      GuardianVpnPreferences.setEnabled(context, false)
      context.stopService(Intent(context, GuardianVpnService::class.java))
    }

    fun startWithPersistedPolicy(context: Context) {
      val store = EncryptedPolicyStore(context)
      val manager = PolicyManager(store, BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS)
      if (!CachedProtectionStartup.shouldStart(
          GuardianVpnPreferences.isEnabled(context),
          manager.activeSnapshot() != null,
          VpnService.prepare(context) == null,
        )
      ) return
      GuardianPolicyRuntime.install(manager)
      start(context)
    }

    fun startWithUserInitiatedPolicy(context: Context): Boolean {
      val store = EncryptedPolicyStore(context)
      val manager = PolicyManager(store, BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS)
      if (!UserInitiatedProtectionStartup.shouldStart(
          manager.activeSnapshot() != null,
          VpnService.prepare(context) == null,
        )
      ) return false
      GuardianPolicyRuntime.install(manager)
      GuardianVpnPreferences.setEnabled(context, true)
      start(context)
      return true
    }
  }
}
