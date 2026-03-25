package expo.modules.remodexsecuretransport

import expo.modules.core.interfaces.Package
import expo.modules.kotlin.modules.Module

class RemodexSecureTransportPackage : Package {
  override fun createModules(): List<Module> = listOf(RemodexSecureTransportModule())
}
