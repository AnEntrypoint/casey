:global uhhSyncLocal
:global uhhSyncOk
:global uhhSyncIncomingVersion
:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhHost
:global uhhTls
:global uhhGuestSsid
:global uhhContactWindowS
:global uhhBlockS
:global uhhIdleTimeoutS
:global uhhUsageIntervalS
:global uhhHeartbeatIntervalS
:global uhhWaAsn
:global uhhWalledGarden
:global uhhConfigVersion
/system script run uhh-config
:global uhhSyncOk true
:global uhhSyncIncomingVersion ""
:if ((([:typeof $uhhGuestSsid] != "str")) || ([:len $uhhGuestSsid] = 0)) do={ :global uhhGuestSsid "Ubuntu Herd Health" }
:if ([:typeof $uhhContactWindowS] != "num") do={ :global uhhContactWindowS 300 }
:if ([:typeof $uhhBlockS] != "num") do={ :global uhhBlockS 86400 }
:if ([:typeof $uhhIdleTimeoutS] != "num") do={ :global uhhIdleTimeoutS 1200 }
:if ([:typeof $uhhUsageIntervalS] != "num") do={ :global uhhUsageIntervalS 300 }
:if ([:typeof $uhhHeartbeatIntervalS] != "num") do={ :global uhhHeartbeatIntervalS 300 }
:if ((([:typeof $uhhWaAsn] != "str")) || ([:len $uhhWaAsn] = 0)) do={ :global uhhWaAsn "AS32934" }
:if ((([:typeof $uhhWalledGarden] != "array")) || ([:len $uhhWalledGarden] = 0)) do={ :global uhhWalledGarden {"ubuntudashboard.co.za";"*.ubuntudashboard.co.za";"whatsapp.com";"*.whatsapp.com";"whatsapp.net";"*.whatsapp.net";"wa.me";"*.wa.me"} }
:if ([:typeof $uhhConfigVersion] != "str") do={ :global uhhConfigVersion "" }
:local hostnameChars "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-*"
:local asnChars "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
:local quoteText do={
  :local out "\""
  :for i from=0 to=([:len $1] - 1) do={
    :local ch [:pick $1 $i ($i + 1)]
    :if ($ch = "\"") do={ :set ch "\\\"" }
    :if ($ch = "\\") do={ :set ch "\\\\" }
    :set out ($out . $ch)
  }
  :return ($out . "\"")
}
:local onlyAllowedChars do={
  :for i from=0 to=([:len $1] - 1) do={
    :if ([:typeof [:find $2 [:pick $1 $i ($i + 1)]]] = "nil") do={ :return false }
  }
  :return true
}
:local hasControlChars do={
  :if ([:typeof [:find $1 "\n"]] = "num") do={ :return true }
  :if ([:typeof [:find $1 "\r"]] = "num") do={ :return true }
  :if ([:typeof [:find $1 "\t"]] = "num") do={ :return true }
  :return false
}
:if ($uhhSyncLocal != true) do={
  :do {
    :local r [/tool/fetch url=($uhhBase . "/api/router/config") http-method=get http-header-field=("authorization:Bearer " . $uhhToken) output=user as-value check-certificate=$uhhTls]
    :if (($r->"status") != "finished") do={ :error "config fetch not finished" }
    :local cfg [:deserialize from=json value=[:tostr ($r->"data")]]
    :set uhhSyncIncomingVersion [:tostr ($cfg->"version")]
    :if ($uhhSyncIncomingVersion != $uhhConfigVersion) do={
      :local s ($cfg->"settings")
      :local settingsOk true
      :foreach k in={"contact_window_s";"block_s";"idle_timeout_s";"usage_interval_s";"heartbeat_interval_s"} do={
        :if (([:typeof ($s->$k)] != "num") || (($s->$k) < 1)) do={ :set settingsOk false }
      }
      :local guestSsid [:tostr ($s->"guest_ssid")]
      :local waAsn [:tostr ($s->"wa_asn")]
      :if (([:len $guestSsid] < 1) || ([:len $guestSsid] > 32) || ([$hasControlChars $guestSsid])) do={ :set settingsOk false }
      :if (([:len $waAsn] < 3) || ([:len $waAsn] > 16) || ([$onlyAllowedChars $waAsn $asnChars] != true)) do={ :set settingsOk false }
      :if ([:typeof ($s->"walled_garden")] != "array") do={ :set settingsOk false }
      :if ([:typeof ($s->"walled_garden")] = "array") do={
        :local entryCount 0
        :foreach entry in=($s->"walled_garden") do={
          :set entryCount ($entryCount + 1)
          :if (([:typeof $entry] != "str") || ([:len $entry] < 1) || ([:len $entry] > 253) || ([$onlyAllowedChars $entry $hostnameChars] != true)) do={ :set settingsOk false }
        }
        :if (($entryCount < 1) || ($entryCount > 100)) do={ :set settingsOk false }
      }
      :if ($settingsOk != true) do={ :error "settings failed validation, previous state kept" }
      :global uhhGuestSsid $guestSsid
      :global uhhContactWindowS ($s->"contact_window_s")
      :global uhhBlockS ($s->"block_s")
      :global uhhIdleTimeoutS ($s->"idle_timeout_s")
      :global uhhUsageIntervalS ($s->"usage_interval_s")
      :global uhhHeartbeatIntervalS ($s->"heartbeat_interval_s")
      :global uhhWaAsn $waAsn
      :global uhhWalledGarden ($s->"walled_garden")
      :do {
        :if ([:len [/interface wifi find default-name=wifi2]] > 0) do={
          :if ([/interface wifi get [find default-name=wifi2] configuration.mode] = "ap") do={
            /interface wifi set [find default-name=wifi2] configuration.ssid=$uhhGuestSsid
          }
        }
      } on-error={ :log warning "uhh-sync: guest SSID not applied, previous kept"; :set uhhSyncOk false }
      :do {
        :if ([:len [/ip hotspot walled-garden find comment=uhh-portal]] > 0) do={ /ip hotspot walled-garden remove [find comment=uhh-portal] }
        :foreach entry in=$uhhWalledGarden do={ /ip hotspot walled-garden add dst-host=$entry action=allow comment=uhh-portal }
      } on-error={ :log warning "uhh-sync: walled garden not rebuilt, previous kept"; :set uhhSyncOk false }
      :foreach assetName in={"login.html";"blocked.html";"tc.html";"redirect.html"} do={
        :do {
          :local target ("hotspot/" . $assetName)
          :local incoming ($target . ".incoming")
          :if ([:len [/file find name=$incoming]] > 0) do={ /file remove [find name=$incoming] }
          :local ra [/tool/fetch url=($uhhBase . "/api/router/assets/" . $assetName) http-method=get http-header-field=("authorization:Bearer " . $uhhToken) dst-path=$incoming check-certificate=$uhhTls as-value]
          :if ((($ra->"status") != "finished") || ([:tonum [/file get [find name=$incoming] size]] < 1)) do={ :error ("asset download " . $assetName) }
          :if ([:len [/file find name=$target]] > 0) do={ /file remove [find name=$target] }
          /file set [find name=$incoming] name=$target
        } on-error={
          :log warning ("uhh-sync: asset " . $assetName . " not updated, previous kept")
          :local staleIncoming ("hotspot/" . $assetName . ".incoming")
          :if ([:len [/file find name=$staleIncoming]] > 0) do={ /file remove [find name=$staleIncoming] }
          :set uhhSyncOk false
        }
      }
      :do {
        :if ([:len [/system scheduler find name=uhh-usage]] > 0) do={ /system scheduler set [find name=uhh-usage] interval=($uhhUsageIntervalS . "s") }
      } on-error={ :log warning "uhh-sync: usage interval not updated"; :set uhhSyncOk false }
      :if ($uhhSyncOk = true) do={ :global uhhConfigVersion $uhhSyncIncomingVersion }
      :log info ("uhh-sync: settings from version " . $uhhSyncIncomingVersion . " applied, stored version " . $uhhConfigVersion)
    }
  } on-error={
    :log warning "uhh-sync: config fetch or apply failed, previous state kept"
  }
}
:local src ""
:set src ($src . ":global uhhBase " . [$quoteText $uhhBase] . "\n")
:set src ($src . ":global uhhToken " . [$quoteText $uhhToken] . "\n")
:set src ($src . ":global uhhRouterId " . [$quoteText $uhhRouterId] . "\n")
:set src ($src . ":global uhhHost " . [$quoteText $uhhHost] . "\n")
:set src ($src . ":global uhhTls " . [$quoteText $uhhTls] . "\n")
:set src ($src . ":global uhhGuestSsid " . [$quoteText $uhhGuestSsid] . "\n")
:set src ($src . ":global uhhContactWindowS " . [:tostr $uhhContactWindowS] . "\n")
:set src ($src . ":global uhhBlockS " . [:tostr $uhhBlockS] . "\n")
:set src ($src . ":global uhhIdleTimeoutS " . [:tostr $uhhIdleTimeoutS] . "\n")
:set src ($src . ":global uhhUsageIntervalS " . [:tostr $uhhUsageIntervalS] . "\n")
:set src ($src . ":global uhhHeartbeatIntervalS " . [:tostr $uhhHeartbeatIntervalS] . "\n")
:set src ($src . ":global uhhWaAsn " . [$quoteText $uhhWaAsn] . "\n")
:local walledSrc ""
:local walledSep ""
:foreach entry in=$uhhWalledGarden do={
  :set walledSrc ($walledSrc . $walledSep . [$quoteText $entry])
  :set walledSep ";"
}
:set src ($src . ":global uhhWalledGarden {" . $walledSrc . "}\n")
:set src ($src . ":global uhhConfigVersion " . [$quoteText $uhhConfigVersion] . "\n")
:if ($src != [/system script get [find name=uhh-config] source]) do={
  /system script set [find name=uhh-config] source=$src
  :log info "uhh-sync: uhh-config rewritten"
}
